import { runCatalogResize } from './compute-lifecycle.js';
import { resolveSshKeys } from './ssh-keys.js';
import { db, audit } from './db.js';
import { config } from './config.js';
import { resolveOffering, selectPlacement, checkOfferingRevision, verifyComputeDeleted } from './compute-placement.js';
import { beginOperation, priorRequest, requestHash, updateOperation, completeOperation, operationById, operationCredentials, pendingOperations, releaseCompute, assertComputeIdle, computeManaged, operationStep, setOperationStep, releaseStaging, allocationFor } from './compute-state.js';
import { capacityLocks,capacityBusy } from './capacity.js';
import { customerById, requireCustomer } from './tenancy.js';
import {
  pve, clusterGuests, locateTemplate, waitTask, bootDiskKey, diskSizeGb, serial,
  invalidateGuestCache, guestPath,
} from './pve.js';
import { ensureNetwork, isolateGuest, nicModel } from './network.js';
import { setupWindows, windowsPasswordProblem } from './windows.js';
import { agentExec } from './agent.js';
import { expiryForNewServer } from './expiry.js';
import { activeRun } from './winupdate.js';
import { forgetServerBackups } from './backups.js';
import { offeredContainerTemplates, containerRow, containerParams, containerMac } from './containers.js';
import { cloneRule, cloneRules, withLimits, customerHasGuest, poolMembers } from './access.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

// ---- Limits & usage -------------------------------------------------------

export function limitsOf(account) {
  return {
    servers: account.max_servers,
    cores: account.max_cores,
    memoryMb: account.max_memory_mb,
    diskGb: account.max_disk_gb,
  };
}

/** Total size of a server's disks in GB (VM disks, or a container's rootfs and mount points; CD and cloud-init drives excluded). */
export function diskTotalGb(cfg) {
  let total = 0;
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^((scsi|virtio|sata|ide)\d+|rootfs|mp\d+)$/.test(k)) continue;
    if (/media=cdrom|cloudinit/.test(String(v))) continue;
    total += diskSizeGb(v) || 0;
  }
  return Math.round(total);
}

/**
 * Resources a customer uses, over ALL their servers (also the ones an admin
 * assigned). Read from each server's configuration, which includes PENDING
 * changes (e.g. more memory waiting for a restart), so resizing several running
 * servers can't exceed the plan. Servers still being created count with what
 * was requested.
 */
const customerContextForUsage=(userId,id)=>customerById(id)?.legacy_user_id===userId;
export async function usageOf(userId, customerId=null) {
  const rows = customerId!=null&&customerContextForUsage(userId,customerId) ? db.prepare('SELECT * FROM vms WHERE customer_id=?').all(customerId) : customerId==null ? db.prepare('SELECT * FROM vms WHERE user_id=?').all(userId) : db.prepare('SELECT * FROM vms WHERE user_id=? AND customer_id=?').all(userId,customerId);
  return usageRows(rows);
}
export async function customerUsage(customer) {
  const rows=db.prepare('SELECT * FROM vms WHERE customer_id=?').all(customer.id);
  const known=new Set(rows.map(r=>r.vmid));
  if(customer.pools.length) for(const guest of (await clusterGuests()).values()) {
    if(known.has(Number(guest.vmid))) continue;
    const row=db.prepare('SELECT * FROM vms WHERE vmid=?').get(Number(guest.vmid));
    if(await customerHasGuest(customer,guest,row)) rows.push({vmid:Number(guest.vmid),state:'ready',spec:null});
  }
  return usageRows(rows);
}
async function usageRows(rows) {
  const guests = await clusterGuests();
  const usage = { servers: 0, cores: 0, memoryMb: 0, diskGb: 0 };
  await Promise.all(rows.map(async (row) => {
    usage.servers += 1;
    const spec = row.spec ? JSON.parse(row.spec) : null;
    const guest = guests.get(row.vmid);
    if (row.state === 'creating' && spec) {
      usage.cores += spec.cores;
      usage.memoryMb += spec.memoryMb;
      usage.diskGb += spec.diskGb;
      return;
    }
    if (!guest) return;
    try {
      const cfg = await pve.get(`${guestPath(guest)}/config`); // pending values included
      usage.cores += (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1);
      usage.memoryMb += Number(cfg.memory) || 512;
      usage.diskGb += diskTotalGb(cfg);
    } catch {
      usage.cores += guest.maxcpu ?? 0;
      usage.memoryMb += Math.round((guest.maxmem ?? 0) / MB);
      usage.diskGb += Math.round((guest.maxdisk ?? 0) / GB);
    }
  }));
  return usage;
}

// ---- Templates --------------------------------------------------------------

/** Templates offered to customers, with the minimum disk size of each. */
export async function offeredTemplates() {
  const rows = db.prepare('SELECT * FROM templates ORDER BY label').all();
  const guests = await clusterGuests();
  const result = await Promise.all(rows.map(async (t) => {
    const guest = guests.get(t.vmid);
    if (!guest?.template) return null; // template was removed in Proxmox
    try {
      const cfg = await pve.get(`/nodes/${encodeURIComponent(guest.node)}/qemu/${t.vmid}/config`);
      const disk = bootDiskKey(cfg);
      const windows = t.setup === 'windows';
      return {
        id: t.vmid,
        name: t.label,
        kind: 'vm',
        setup: windows ? 'windows' : 'cloudinit',
        minDiskGb: Math.ceil(diskSizeGb(cfg[disk])) || 1,
        defaultUser: windows ? (t.ci_user || 'Administrator') : (t.ci_user || cfg.ciuser || ''),
        os: cfg.ostype ?? null,
      };
    } catch {
      return null;
    }
  }));
  return [...result.filter(Boolean), ...await offeredContainerTemplates()];
}

// ---- Create -----------------------------------------------------------------

const creatingFor = capacityLocks; // one creation per customer at a time

export class ProvisionError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

/** Sign-in rules per setup method (shared by create and reinstall). Mutates spec. */
function applySetupRules(spec, offered) {
  if (offered.setup !== 'windows') {
    if (!spec.loginMethod && !spec.password && !spec.sshKeys?.trim()) throw new ProvisionError(400, 'Set a password or add an SSH key so you can sign in');
    const method = spec.loginMethod ?? (spec.password ? (spec.sshKeys?.trim() ? 'both' : 'password') : 'ssh');
    if (!['ssh','password','both'].includes(method)) throw new ProvisionError(400, 'Choose a sign-in method');
    if ((method === 'ssh' || method === 'both') && !spec.sshKeys?.trim()) throw new ProvisionError(400, 'Select a saved SSH key or paste a public key');
    if ((method === 'password' || method === 'both') && !spec.password) throw new ProvisionError(400, 'Set a password for this sign-in method');
    if ((method === 'ssh' && spec.password) || (method === 'password' && spec.sshKeys?.trim())) throw new ProvisionError(400, 'Credentials must match the selected sign-in method');
    spec.loginMethod = method;
  } else if (spec.loginMethod || spec.sshKeyIds?.length) throw new ProvisionError(400, 'Windows images use their Administrator password');
  if (offered.setup === 'windows') {
    if (spec.hostname.length > 15) {
      throw new ProvisionError(400, 'Windows computer names can be at most 15 characters');
    }
    if (!spec.password) throw new ProvisionError(400, 'Set a password for the Administrator account');
    spec.username = offered.defaultUser; // fixed admin account of the template
    spec.sshKeys = undefined;
    const problem = windowsPasswordProblem(spec.password, spec.username);
    if (problem) throw new ProvisionError(400, problem);
  } else if (offered.setup === 'container') {
    // Containers have no cloud-init: sign-in is root, with a password and/or SSH keys
    spec.username = 'root';
    if (!spec.password && !spec.sshKeys?.trim()) {
      throw new ProvisionError(400, 'Set a password or add an SSH key so you can sign in to the container');
    }
  } else {
    if (!spec.username) throw new ProvisionError(400, 'Choose a user name');
    if (!spec.password && !spec.sshKeys?.trim()) {
      throw new ProvisionError(400, 'Set a password or add an SSH key so you can sign in to the server');
    }
  }
  spec.setup = offered.setup;
}

async function checkImageLogin(offered, tpl) {
  if (offered.setup !== 'cloudinit') return;
  const image = await pve.get(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/config`);
  if (/(^|,)user=/.test(image.cicustom ?? '')) throw new ProvisionError(400, 'This image has custom cloud-init user data that overrides sign-in settings. The provider must prepare a compatible image.');
  if (!Object.entries(image).some(([k,v]) => /^(ide|scsi|sata)\d+$/.test(k) && String(v).includes('cloudinit'))) throw new ProvisionError(400, 'The provider must add a cloud-init drive to this image before it can configure sign-in.');
}

/**
 * Validates quota, reserves a VMID and starts the clone. Returns the new VMID
 * right away; configuration, disk resize and first start continue in the
 * background, tracked through the `state` column.
 */
export async function createServer(req, spec) {
  const customer=requireCustomer(req);
  const capacityKey=`customer:${customer.id}`;
  let grant = null;
  if (spec.accessRuleId) grant = cloneRule(req, spec.accessRuleId);
  else if (!req.account.can_create) {
    const available = cloneRules(req);
    if (available.length === 1) grant = available[0];
    else if (available.length > 1) throw new ProvisionError(400, 'Choose a cloning destination');
  }
  const account = grant ? withLimits(req.account, grant) : req.account;
  if (!account.can_create) throw new ProvisionError(403, 'Creating servers is not enabled for your account');
  resolveSshKeys(req.account.id, spec);
  const offering = resolveOffering(customer.id, spec);
  if (!offering && (!Number.isInteger(spec.cores) || !Number.isInteger(spec.memoryMb))) throw new ProvisionError(400, 'CPU and memory are required');
  const key = req.headers?.['idempotency-key'];
  const hash = offering ? requestHash(spec) : null;
  const previous = offering ? priorRequest(customer.id, account.id, key, hash) : null;
  if (previous) return previous.vmid;
  if (capacityBusy(customer.id)) {
    throw new ProvisionError(409, 'Another server is being created. Wait until it has finished.');
  }
  creatingFor.add(capacityKey);

  let background = false;
  try {
    const isContainer = typeof spec.templateId === 'string';
    const ctRow = isContainer ? containerRow(spec.templateId) : null;
    const tplRow = isContainer ? null : db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    if (!tplRow && !ctRow) throw new ProvisionError(400, 'That image is not available');
    const tpl = isContainer ? null : await locateTemplate(spec.templateId);
    let destinationPool = config.pve.pool;
    if (grant) {
      if (!grant.clone.templates.includes(spec.templateId)) throw new ProvisionError(403, 'That image is not allowed at this destination');
      const source = isContainer ? null : await pve.get(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/config`);
      const storages = isContainer ? [ctRow.storage] : tplRow.storage ? [tplRow.storage]
        : Object.entries(source).filter(([key, value]) => /^(?:(?:ide|sata|scsi|virtio)\d+|efidisk0|tpmstate0)$/.test(key) && !String(value).startsWith('none'))
          .map(([, value]) => String(value).split(':')[0]);
      if (!offering && (!storages.length || storages.some((storage) => !grant.clone.storages.includes(storage)))) throw new ProvisionError(403, 'The image storage is not allowed at this destination');
      destinationPool = grant.clone.pool;
      spec.accessTags = grant.tags.join(';');
      spec.accessRuleId = grant.id;
    }
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB`);
    }

    applySetupRules(spec, offered);
    await checkImageLogin(offered, tpl);

    // Quota
    const limits = limitsOf(account);
    const usage = await usageOf(account.id,customer.id);
    const over = [];
    if (usage.servers + 1 > limits.servers) over.push(`servers (${limits.servers} allowed)`);
    if (usage.cores + spec.cores > limits.cores) over.push(`CPU cores (${limits.cores - usage.cores} left)`);
    if (usage.memoryMb + spec.memoryMb > limits.memoryMb) {
      over.push(`memory (${((limits.memoryMb - usage.memoryMb) / 1024).toFixed(1)} GB left)`);
    }
    if (usage.diskGb + spec.diskGb > limits.diskGb) over.push(`disk (${limits.diskGb - usage.diskGb} GB left)`);
    if (over.length) throw new ProvisionError(409, `This exceeds your plan: ${over.join(', ')}`);

    const total=await customerUsage(customer);
    const exceeded=Object.entries(customer.limits).some(([key,limit])=>limit>0&&total[key]+({servers:1,cores:spec.cores,memoryMb:spec.memoryMb,diskGb:spec.diskGb}[key])>limit);
    if(exceeded) throw new ProvisionError(409,'This exceeds the customer’s shared resource limits');

    // The customer's private network (created with their first server)
    const net = config.network.enabled ? await ensureNetwork(account.id,customer.id) : null;

    // Reserve ID + start clone, serialised against other creations
    const insertVM = (id, operationId = null) => {
      db.prepare(`INSERT INTO vms(vmid,user_id,type,state,created_by_customer,spec,progress,expires_at,expiry_set_at,access_managed,customer_id)
        VALUES(?,?,?,'creating',1,?,?,?,?,?,?)`).run(id, account.id, isContainer ? 'lxc' : 'qemu', JSON.stringify({
          cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: spec.templateId, hostname: spec.hostname,
          loginMethod: spec.loginMethod, ...(offering ? { offering, operationId } : {}), ...(grant ? { accessRuleId: grant.id, pool: destinationPool } : {}),
        }), 'Copying the image', expiryForNewServer(account.id,new Date(),customer.id), new Date().toISOString(), grant ? 1 : 0, customer.id);
    };
    const { vmid, upid, operationId = null, targetNode = tpl?.node, taskNode = tpl?.node } = await serial(async () => {
      const sourceConfig = offering ? await pve.get(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/config`) : null;
      if (offering && Object.entries(sourceConfig).filter(([k, v]) => /^(scsi|sata|virtio|ide)\d+$/.test(k) && !/media=cdrom|cloudinit/.test(String(v)) && !String(v).startsWith('none')).length !== 1) throw new ProvisionError(400, 'Catalog images must have one data disk');
      if (offering && Object.keys(sourceConfig).some(k => /^net[1-9][0-9]*$/.test(k))) throw new ProvisionError(400, 'Catalog images must have one guest network interface');
      if (offering && customer.pools.length && !customer.pools.includes(destinationPool)) throw new ProvisionError(403, 'The destination pool is outside this customer');
      const placement = offering ? await selectPlacement({ offering, template: tpl, sourceConfig, pool: destinationPool, grant }) : null;
      // Proxmox's next free ID, skipping IDs the panel still has records for
      // (e.g. a VM that was deleted directly in Proxmox but is still assigned here).
      const known = db.prepare('SELECT 1 FROM vms WHERE vmid = ?');
      let id = Number(await pve.get('/cluster/nextid'));
      for (let tries = 0; ; tries += 1, id += 1) {
        if (tries > 1000) throw new Error('No free VM ID found');
        if (known.get(id)) continue;
        try {
          await pve.get('/cluster/nextid', { vmid: id }); // errors if the ID is taken in Proxmox
          break;
        } catch {
          // taken in Proxmox, try the next one
        }
      }
      const currentCustomer=requireCustomer(req);
      if(currentCustomer.id!==customer.id || currentCustomer.revision!==customer.revision) throw new ProvisionError(409,'Customer settings changed. Please try again.');
      if (grant) {
        // Re-evaluate after asynchronous quota/ID work. A policy edit or expired
        // claim lease must not authorize a late clone with an old rule snapshot.
        const current = cloneRule(req, grant.id);
        if (JSON.stringify(current) !== JSON.stringify(grant)) throw new ProvisionError(409, 'The cloning policy changed. Please try again.');
      }
      if (offering) {
        checkOfferingRevision(customer.id, offering);
        const { password, username, sshKeys, ...safeSpec } = spec;
        const op = beginOperation({ customerId: customer.id, userId: account.id, vmid: id, key, hash,
          plan: { ...placement, spec: safeSpec, template: tplRow }, credentials: { password, username, sshKeys }, onReserve: opId => insertVM(id, opId) });
        updateOperation(op.id, 'submitting');
        try {
          const task = await pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
            newid: id, name: spec.hostname, full: 1, storage: placement.staging?.storage ?? placement.storage, pool: destinationPool,
            target: placement.staging || placement.node === tpl.node ? undefined : placement.node, description: `pve-panel-operation:${op.id}`,
          });
          updateOperation(op.id, 'cloning', { upid: task, taskNode: tpl.node });
          return { vmid: id, upid: task, operationId: op.id, targetNode: placement.node, taskNode: tpl.node };
        } catch (err) {
          updateOperation(op.id, 'review', { error: 'The clone outcome needs reconciliation.' });
          db.prepare("UPDATE vms SET state='failed',error='The clone outcome needs provider reconciliation',progress=NULL WHERE vmid=?").run(id);
          throw err;
        }
      }
      const task = isContainer
        ? await pve.post(`/nodes/${encodeURIComponent(ctRow.node)}/lxc`, containerParams({ vmid: id, row: ctRow, spec, net, pool: destinationPool }))
        : await pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
          newid: id,
          name: spec.hostname,
          full: 1,
          storage: tplRow.storage || undefined,
          pool: destinationPool,
        });
      return { vmid: id, upid: task };
    });

    const templateRef = isContainer ? spec.templateId : tpl.vmid;
    if (!offering) insertVM(vmid);
    audit(req, vmid, 'server_create_started', { template: templateRef, hostname: spec.hostname, ...(grant ? { accessRuleId: grant.id, pool: destinationPool } : {}) });

    background = true;
    const actor = { account: { id: account.id }, customerId:customer.id, ip: req.ip };
    (isContainer
      ? finishContainer(actor, ctRow.node, vmid, upid, net)
      : finishCreate(actor, targetNode, vmid, upid, spec, tplRow, net, { operationId, taskNode }))
      .finally(() => creatingFor.delete(capacityKey));

    return vmid;
  } finally {
    if (!background) creatingFor.delete(capacityKey);
  }
}

const setProgress = db.prepare('UPDATE vms SET progress = ? WHERE vmid = ?');

async function finishPlacement(id) {
  const op = operationById(id), plan = op.plan;
  if (!plan.staging) return;
  let guest = (await clusterGuests(true)).get(op.vmid);
  if (!guest || guest.template) throw new Error('The staged VM is missing');
  const cfg = await pve.get(`${guestPath(guest)}/config`);
  if (cfg.lock || guest.lock || !String(cfg.description ?? '').includes(`pve-panel-operation:${id}`)) throw new Error('The staged VM identity or lock needs reconciliation');
  const step = operationStep(id, 'migration');
  if (step?.upid) await waitTask(step.task_node, step.upid);
  guest = (await clusterGuests(true)).get(op.vmid);
  if (guest?.node === plan.node) {
    setOperationStep(id, 'migration', 'complete'); releaseStaging(id); return;
  }
  if (guest?.node !== plan.sourceNode || step) throw new Error('Migration outcome needs provider reconciliation. The panel will not repeat the migration.');
  if (guest.status !== 'stopped') throw new Error('The staged VM must remain stopped');
  const ha = await pve.get('/cluster/ha/status/current');
  if (!Array.isArray(ha) || ha.some(s => s.type === 'lrm' && s.node === plan.node && /maintenance|lost|unavailable/i.test(s.status ?? ''))) throw new Error('The destination entered maintenance');
  const actor = { account: { id: op.user_id }, customerId: op.customer_id, ip: 'placement' };
  setOperationStep(id, 'migration', 'submitting');
  const upid = await pve.post(`${guestPath(guest)}/migrate`, { target: plan.node, targetstorage: plan.storage, online: 0, 'with-local-disks': 1 });
  setOperationStep(id, 'migration', 'running', upid, guest.node);
  updateOperation(id, 'migrating', { upid, taskNode: guest.node });
  await waitTask(guest.node, upid);
  const placed = (await clusterGuests(true)).get(op.vmid);
  if (placed?.node !== plan.node) throw new Error('Migration destination could not be verified');
  const final = await pve.get(`${guestPath(placed)}/config`);
  if (final.lock || placed.lock) throw new Error('Migration is still locked');
  setOperationStep(id, 'migration', 'complete'); releaseStaging(id);
  audit(actor, op.vmid, 'server_placed', { node: plan.node, storage: plan.storage });
}

async function finishCreate(actor, node, vmid, cloneUpid, spec, tplRow, net, {
  mac = null, done = 'server_created', failed = 'server_create_failed', operationId = null, taskNode = node,
} = {}) {
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`;
  const progress = (text) => setProgress.run(text, vmid);
  const windows = spec.setup === 'windows';
  try {
    await waitTask(taskNode, cloneUpid);
    if (operationId) {
      await finishPlacement(operationId);
      updateOperation(operationId, 'configuring');
    }

    progress('Configuring');
    const cfg = await pve.get(`${path}/config`);
    const params = { cores: spec.cores, sockets: 1, memory: spec.memoryMb };
    if (operationId) {
      const plan = operationById(operationId).plan;
      if (!String(cfg.description ?? '').includes(`pve-panel-operation:${operationId}`)) throw new Error('VM identity does not match its provisioning operation');
      if (!String(cfg[bootDiskKey(cfg)] ?? '').startsWith(`${plan.storage}:`)) throw new Error('VM storage does not match its reserved class');
      const network = plan.offering.network;
      params.net0 = `${String(cfg.net0 ?? nicModel(cfg.net0)).split(',')[0]},bridge=${network.bridge}${network.vlan ? `,tag=${network.vlan}` : ''},firewall=1`;
    }
    if (net) {
      // Customer's VNet, firewall on for isolation. A kept MAC (reinstall) gets
      // the same DHCP address again; otherwise Proxmox assigns a new one.
      params.net0 = `${nicModel(cfg.net0)}${mac ? `=${mac}` : ''},bridge=${net.vnet},firewall=1`;
    } else if (mac && cfg.net0) {
      params.net0 = cfg.net0.replace(/^(\w+)=([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})/, `$1=${mac}`);
    }
    if (!windows) {
      params.ciuser = spec.username;
      params.ipconfig0 = tplRow.ipconfig || 'ip=dhcp';
      if (spec.password) params.cipassword = spec.password;
      // Clear image credentials that the customer did not select.
      if (spec.loginMethod === 'ssh') params.delete = 'cipassword';
      if (spec.loginMethod === 'password') params.delete = 'sshkeys';
      // Proxmox expects the key list URL-encoded (in addition to form encoding).
      if (spec.sshKeys) params.sshkeys = encodeURIComponent(`${spec.sshKeys.trim()}\n`);
    }
    if (spec.accessTags !== undefined) params.tags = spec.accessTags;
    await pve.put(`${path}/config`, params);
    if (net) await isolateGuest(path, net);

    const disk = bootDiskKey(cfg);
    if (disk && spec.diskGb > diskSizeGb(cfg[disk])) {
      progress('Resizing the disk');
      const resize = await pve.put(`${path}/resize`, { disk, size: `${spec.diskGb}G` });
      await waitTask(node, resize); // async in newer PVE versions, sync in older
    }

    progress('Starting');
    if (!operationId || (await pve.get(`${path}/status/current`)).status !== 'running') await waitTask(node, await pve.post(`${path}/status/start`));

    if (windows) {
      await setupWindows({
        path, node,
        hostname: spec.hostname,
        adminUser: spec.username,
        password: spec.password,
        net,
        progress,
      });
    }

    const ready = () => db.prepare("UPDATE vms SET state = 'ready', error = NULL, progress = NULL WHERE vmid = ?").run(vmid);
    if (operationId) completeOperation(operationId, ready); else ready();
    audit(actor, vmid, done);
  } catch (err) {
    if (operationId) updateOperation(operationId, 'review', { error: String(err.message).slice(0, 500) });
    db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
      .run(operationId ? 'Provisioning needs provider reconciliation' : String(err.message).slice(0, 500), vmid);
    audit(actor, vmid, failed, { error: err.message });
  } finally {
    invalidateGuestCache();
  }
}

/** After Proxmox created a container: isolate it in the customer's network and start it. */
async function finishContainer(actor, node, vmid, createUpid, net, { done = 'server_created', failed = 'server_create_failed' } = {}) {
  const path = `/nodes/${encodeURIComponent(node)}/lxc/${vmid}`;
  const progress = (text) => setProgress.run(text, vmid);
  try {
    await waitTask(node, createUpid);
    if (net) {
      progress('Securing the network');
      await isolateGuest(path, net);
    }
    progress('Starting');
    await waitTask(node, await pve.post(`${path}/status/start`));
    db.prepare("UPDATE vms SET state = 'ready', error = NULL, progress = NULL WHERE vmid = ?").run(vmid);
    audit(actor, vmid, done);
  } catch (err) {
    db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
      .run(operationId ? 'Provisioning needs provider reconciliation' : String(err.message).slice(0, 500), vmid);
    audit(actor, vmid, failed, { error: err.message });
  } finally {
    invalidateGuestCache();
  }
}

// ---- Reinstall --------------------------------------------------------------

/**
 * Replaces a server's installation with a fresh copy of an image: stops and
 * deletes the VM, clones the image again under the SAME ID, keeps name, size and
 * MAC address (so DHCP gives the same IP), re-applies network isolation and runs
 * the image's setup with new sign-in details. Disk content and snapshots are
 * erased. Only for servers the customer created. Returns right away; progress is
 * tracked through the `state` column like a creation.
 */
function lifecycleAccount(req,row,customer) {
  if(row.access_managed || customer.role!=='admin') return req.account;
  const owner=customer.legacy_user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(customer.legacy_user_id) : null;
  return {...req.account,can_create:owner?owner.can_create:1,
    ...Object.fromEntries(['max_servers','max_cores','max_memory_mb','max_disk_gb'].map(k=>[k,owner?owner[k]:Number.MAX_SAFE_INTEGER]))};
}

export async function reinstallServer(req, row, input) {
  resolveSshKeys(req.account.id, input);
  if (computeManaged(row.vmid)) throw new ProvisionError(409, 'Catalog reinstall is not available yet. This protects the VM’s storage and placement.');
  const customer=requireCustomer(req);
  const account=lifecycleAccount(req,row,customer);
  const capacityKey=`customer:${customer.id}`;
  if (!row.created_by_customer) {
    throw new ProvisionError(403, 'Only servers you created yourself can be reinstalled');
  }
  if (!account.can_create) throw new ProvisionError(403, 'Reinstalling is not enabled for your account');
  if (activeRun(row.vmid)) throw new ProvisionError(409, 'Windows updates are being installed on this server. Wait until they have finished.');
  if (row.expired_at) throw new ProvisionError(403, 'This server has expired. Extend it first.');
  if (!['ready', 'failed'].includes(row.state)) {
    throw new ProvisionError(409, 'Wait until the current operation on this server has finished');
  }
  if (capacityBusy(customer.id)) {
    throw new ProvisionError(409, 'Another server is being set up. Wait until it has finished.');
  }
  creatingFor.add(capacityKey);

  let background = false;
  try {
    const vmid = row.vmid;
    const old = row.spec ? JSON.parse(row.spec) : {};
    const guest = (await clusterGuests(true)).get(vmid) ?? null; // may be gone after a failed attempt
    const oldCfg = guest ? await pve.get(`${guestPath(guest)}/config`) : {};
    const oldDisk = bootDiskKey(oldCfg);
    const isContainer = row.type === 'lxc';
    const mac = (isContainer ? containerMac(oldCfg.net0) : /=([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(oldCfg.net0 ?? '')?.[1])
      ?? old.mac ?? null;

    // Same size as before
    const spec = {
      ...input,
      hostname: old.hostname ?? guest?.name ?? `server-${vmid}`,
      cores: old.cores ?? (Number(oldCfg.cores) || 1),
      memoryMb: old.memoryMb ?? (Number(oldCfg.memory) || 1024),
      diskGb: old.diskGb ?? (oldDisk ? Math.ceil(diskSizeGb(oldCfg[oldDisk])) : 0),
    };

    // A container is reinstalled from a container image, a VM from a VM template
    if (isContainer !== (typeof spec.templateId === 'string')) {
      throw new ProvisionError(400, isContainer ? 'Choose a container image for this container' : 'Choose a server image for this server');
    }
    const ctRow = isContainer ? containerRow(spec.templateId) : null;
    const tplRow = isContainer ? null : db.prepare('SELECT * FROM templates WHERE vmid = ?').get(spec.templateId);
    const offered = (await offeredTemplates()).find((t) => t.id === spec.templateId);
    if (!(tplRow || ctRow) || !offered) throw new ProvisionError(400, 'That image is not available');
    if (spec.diskGb < offered.minDiskGb) {
      throw new ProvisionError(400, `This image needs a disk of at least ${offered.minDiskGb} GB; this server has ${spec.diskGb} GB`);
    }
    applySetupRules(spec, offered);
    const tpl = isContainer ? null : await locateTemplate(spec.templateId);
    await checkImageLogin(offered, tpl);
    const templateRef = isContainer ? spec.templateId : tpl.vmid;
    let destinationPool=config.pve.pool;
    if(customer.pools.length) {
      const memberships=await Promise.all(customer.pools.map(async pool=>({pool,contains:(await poolMembers(pool)).has(vmid)})));
      destinationPool=memberships.find(p=>p.contains)?.pool ?? (customer.pools.includes(old.pool)?old.pool:null);
      if(!destinationPool) throw new ProvisionError(403,'The reinstall destination is outside this customer’s pool boundary');
    }
    const net = config.network.enabled ? await ensureNetwork(account.id,row.customer_id) : null;

    // The row keeps the ID reserved: new creations skip IDs the panel knows.
    db.prepare(`
      UPDATE vms SET state = 'creating', error = NULL, progress = 'Removing the old installation', spec = ?, ostype = NULL
      WHERE vmid = ?`).run(JSON.stringify({
      cores: spec.cores, memoryMb: spec.memoryMb, diskGb: spec.diskGb, template: templateRef,
      hostname: spec.hostname, mac, reinstalledAt: new Date().toISOString(), ...(customer.pools.length?{pool:destinationPool}:{}),
    }), vmid);
    // Things that belonged to the old installation
    db.prepare('DELETE FROM tasks WHERE vmid = ?').run(vmid);
    db.prepare('DELETE FROM tailscale WHERE vmid = ?').run(vmid);
    audit(req, vmid, 'server_reinstall_started', { template: templateRef, previousTemplate: old.template ?? null });

    background = true;
    const actor = { account: { id: account.id }, customerId:customer.id, ip: req.ip };
    (async () => {
      try {
        if (guest) {
          const path = guestPath(guest);
          if (guest.status !== 'stopped') await waitTask(guest.node, await pve.post(`${path}/status/stop`));
          await waitTask(guest.node, await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 }));
          invalidateGuestCache();
        }
        if (isContainer) {
          setProgress.run('Creating the container', vmid);
          const upid = await serial(() => pve.post(`/nodes/${encodeURIComponent(ctRow.node)}/lxc`,
            containerParams({ vmid, row: ctRow, spec, net, pool: destinationPool, mac })));
          await finishContainer(actor, ctRow.node, vmid, upid, net, { done: 'server_reinstalled', failed: 'server_reinstall_failed' });
          return;
        }
        setProgress.run('Copying the image', vmid);
        const upid = await serial(() => pve.post(`/nodes/${encodeURIComponent(tpl.node)}/qemu/${tpl.vmid}/clone`, {
          newid: vmid,
          name: spec.hostname,
          full: 1,
          storage: tplRow.storage || undefined,
          pool: destinationPool,
        }));
        await finishCreate(actor, tpl.node, vmid, upid, spec, tplRow, net, {
          mac, done: 'server_reinstalled', failed: 'server_reinstall_failed',
        });
      } catch (err) {
        db.prepare("UPDATE vms SET state = 'failed', error = ?, progress = NULL WHERE vmid = ?")
          .run(`Reinstalling failed: ${err.message}`.slice(0, 500), vmid);
        audit(actor, vmid, 'server_reinstall_failed', { error: err.message });
        invalidateGuestCache();
      } finally {
        creatingFor.delete(capacityKey);
      }
    })();
  } finally {
    if (!background) creatingFor.delete(capacityKey);
  }
}

// ---- Resize -----------------------------------------------------------------

const resizing = new Set(); // one resize per server at a time

// Extends drive C: into free space behind it. Prints "extended", "nothing"
// (already full size) or "blocked" (another partition, e.g. Recovery, is in the way).
const WIN_EXTEND_C = `
$ErrorActionPreference = 'Stop'
Update-HostStorageCache
$part = Get-Partition -DriveLetter C
$max = (Get-PartitionSupportedSize -DriveLetter C).SizeMax
$disk = Get-Disk -Number $part.DiskNumber
if ($max - $part.Size -gt 100MB) { Resize-Partition -DriveLetter C -Size $max; 'extended' }
elseif ($disk.LargestFreeExtent -gt 100MB) { 'blocked' }
else { 'nothing' }
`;

/**
 * Changes CPU cores, memory and/or disk size of a customer-created server
 * within the plan. CPU/memory on a running server take effect at the next
 * restart by Proxmox (optionally right away); disks only grow.
 */
export async function resizeServer(req, row, input) {
  const { cores, memoryMb, diskGb, restart = false } = input;
  assertComputeIdle(row.vmid);
  const allocation = allocationFor(row.vmid);
  if (!allocation && input.sizeId) throw new ProvisionError(400,'This VM does not use catalog sizes');
  const customer=requireCustomer(req);
  const account=lifecycleAccount(req,row,customer);
  const capacityKey=`customer:${customer.id}`;
  if (!row.created_by_customer) throw new ProvisionError(403, 'Only servers you created yourself can be resized');
  if (!account.can_create) throw new ProvisionError(403, 'Resizing is not enabled for your account');
  if (activeRun(row.vmid)) throw new ProvisionError(409, 'Windows updates are being installed on this server. Wait until they have finished.');
  if (row.expired_at) throw new ProvisionError(403, 'This server has expired. Extend it first.');
  if (row.state !== 'ready') throw new ProvisionError(409, 'Wait until the current operation on this server has finished');
  if (resizing.has(row.vmid)) throw new ProvisionError(409, 'This server is already being resized');
  if(capacityBusy(customer.id)) throw new ProvisionError(409,'Another operation is changing this customer’s resource usage');
  creatingFor.add(capacityKey);
  resizing.add(row.vmid);
  try {
    const guest = (await clusterGuests(true)).get(row.vmid);
    if (!guest) throw new ProvisionError(404, 'Server not found');
    const path = guestPath(guest);
    const cfg = await pve.get(`${path}/config`); // includes pending values
    const windows = /^w/.test(cfg.ostype ?? '');
    const disk = bootDiskKey(cfg);
    const cur = {
      cores: (Number(cfg.cores) || 1) * (Number(cfg.sockets) || 1),
      memoryMb: Number(cfg.memory) || 512,
      diskGb: disk ? Math.ceil(diskSizeGb(cfg[disk])) : 0,
    };
    const oldSpec = JSON.parse(row.spec ?? '{}');
    const offering = allocation ? resolveOffering(customer.id, { ...input, templateId:oldSpec.template, storageClassId:allocation.offering.storageClassId, diskGb:diskGb ?? cur.diskGb },row.vmid) : null;
    const next = offering ? { cores:offering.cores,memoryMb:offering.memoryMb,diskGb:offering.diskGb } : { cores: cores ?? cur.cores, memoryMb: memoryMb ?? cur.memoryMb, diskGb: diskGb ?? cur.diskGb };

    if (next.diskGb < cur.diskGb) throw new ProvisionError(400, `Disks can only grow; this one has ${cur.diskGb} GB`);
    if (next.diskGb > cur.diskGb && !disk) throw new ProvisionError(400, "This server's disk can't be resized here");
    if (windows && next.memoryMb < 2048) throw new ProvisionError(400, 'Windows needs at least 2 GB of memory');
    const cpuMemChanged = next.cores !== cur.cores || next.memoryMb !== cur.memoryMb;
    const diskChanged = next.diskGb > cur.diskGb;
    if (!cpuMemChanged && !diskChanged) throw new ProvisionError(400, 'Nothing to change');

    const total=await customerUsage(customer);
    if(Object.entries(customer.limits).some(([key,limit])=>key!=='servers'&&limit>0&&total[key]-cur[key]+next[key]>limit)) throw new ProvisionError(409,'This exceeds the customer’s shared resource limits');

    // Plan: everything else the customer uses, plus this server's new size
    const limits = limitsOf(account);
    const usage = await usageOf(customer.legacy_user_id??row.user_id,row.customer_id);
    const others = { cores: usage.cores - cur.cores, memoryMb: usage.memoryMb - cur.memoryMb, diskGb: usage.diskGb - cur.diskGb };
    const over = [];
    if (others.cores + next.cores > limits.cores) over.push(`CPU cores (at most ${limits.cores - others.cores} for this server)`);
    if (others.memoryMb + next.memoryMb > limits.memoryMb) {
      over.push(`memory (at most ${((limits.memoryMb - others.memoryMb) / 1024).toFixed(1)} GB for this server)`);
    }
    if (others.diskGb + next.diskGb > limits.diskGb) over.push(`disk (at most ${limits.diskGb - others.diskGb} GB for this server)`);
    if (over.length) throw new ProvisionError(409, `This exceeds your plan: ${over.join(', ')}`);

    if (allocation) {
      if (guest.status !== 'stopped' || cfg.lock || guest.lock) throw new ProvisionError(409,'Stop the VM and wait for its tasks before changing its catalog size');
      if (allocation.offering.haEnabled) throw new ProvisionError(409,'Disable HA before changing this VM size');
      const pool=oldSpec.pool ?? config.pve.pool, storage=String(cfg[disk]).split(':')[0];
      if (!(await poolMembers(pool)).has(row.vmid) || customer.pools.length && !customer.pools.includes(pool)) throw new ProvisionError(403,'The VM is outside the customer pool');
      const op=await serial(async()=>{
        const placement=await selectPlacement({offering,template:guest,sourceConfig:cfg,pool,existing:{vmid:row.vmid,node:guest.node,storage,diskGb:cur.diskGb}});
        checkOfferingRevision(customer.id,offering);
        return beginOperation({customerId:customer.id,userId:req.account.id,vmid:row.vmid,kind:'resized',plan:{...placement,reserveDiskGb:next.diskGb-cur.diskGb,cores:Math.max(cur.cores,next.cores),memoryMb:Math.max(cur.memoryMb,next.memoryMb)},onReserve:id=>{
          db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Changing size',spec=? WHERE vmid=?").run(JSON.stringify({...oldSpec,cores:Math.max(cur.cores,next.cores),memoryMb:Math.max(cur.memoryMb,next.memoryMb),diskGb:next.diskGb,operationId:id}),row.vmid);
        }});
      });
      runCatalogResize(op.id);
      return { operationId:op.id,accepted:true,before:cur,after:next,pendingRestart:false };
    }
    const running = guest.status === 'running';
    const container = guest.type === 'lxc'; // containers take new CPU/memory limits right away
    if (cpuMemChanged) {
      await pve.put(`${path}/config`, container
        ? { cores: next.cores, memory: next.memoryMb }
        : { cores: next.cores, sockets: 1, memory: next.memoryMb });
    }
    if (diskChanged) {
      try {
        await waitTask(guest.node, await pve.put(`${path}/resize`, { disk, size: `${next.diskGb}G` }));
      } catch (err) {
        throw new ProvisionError(502, `Proxmox could not enlarge the disk: ${err.message}`
          + (cpuMemChanged ? ' (the CPU/memory change was saved)' : ''));
      }
    }

    // Keep the stored size in step (used by reinstall)
    const spec = row.spec ? JSON.parse(row.spec) : {};
    db.prepare('UPDATE vms SET spec = ? WHERE vmid = ?')
      .run(JSON.stringify({ ...spec, cores: next.cores, memoryMb: next.memoryMb, diskGb: next.diskGb }), row.vmid);

    // Windows doesn't grow its partition by itself
    let windowsDisk = null;
    if (diskChanged && windows) {
      if (!running) {
        windowsDisk = 'not-running';
      } else {
        try {
          const r = await agentExec(path, [
            'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', Buffer.from(WIN_EXTEND_C, 'utf16le').toString('base64'),
          ], 120_000);
          windowsDisk = /extended/.test(r.out) ? 'extended' : /blocked/.test(r.out) ? 'blocked' : /nothing/.test(r.out) ? 'extended' : 'failed';
        } catch {
          windowsDisk = 'failed';
        }
      }
    }

    let restartTask = null;
    if (cpuMemChanged && running && restart && !container) {
      restartTask = await pve.post(`${path}/status/reboot`); // a Proxmox restart applies pending changes
      invalidateGuestCache();
    }
    audit(req, row.vmid, 'server_resized', { before: cur, after: next, restart: !!restartTask });
    return {
      before: cur,
      after: next,
      pendingRestart: cpuMemChanged && running && !restartTask && !container,
      restartTask: typeof restartTask === 'string' ? restartTask : null,
      windowsDisk,
    };
  } finally {
    resizing.delete(row.vmid);
    creatingFor.delete(capacityKey);
  }
}

// ---- Delete -----------------------------------------------------------------

/** Destroys a customer-created server (must be stopped) and removes its record. */
export async function deleteServer(req, row) {
  assertComputeIdle(row.vmid);
  const guests = await clusterGuests(true);
  const guest = guests.get(row.vmid);

  if (!guest) {
    // Unresolved clones are blocked above. Only verified absence releases an allocation.
    await verifyComputeDeleted(row.vmid);
    releaseCompute(row.vmid);
    db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
    audit(req, row.vmid, 'server_deleted');
    return { removed: true };
  }
  if (guest.status !== 'stopped') {
    throw new ProvisionError(409, 'Shut down the server before deleting it');
  }

  const path = guestPath(guest); // VM or container
  if (computeManaged(row.vmid) && (await pve.get(`${path}/config`)).lock) throw new ProvisionError(409, 'Wait until Proxmox unlocks this VM');
  const upid = await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 });
  db.prepare("UPDATE vms SET state = 'deleting' WHERE vmid = ?").run(row.vmid);
  audit(req, row.vmid, 'server_delete_started');

  const actor = { account: { id: req.account.id }, customerId:row.customer_id, ip: req.ip };
  waitTask(guest.node, upid)
    .then(async () => {
      await verifyComputeDeleted(row.vmid);
      releaseCompute(row.vmid);
      db.prepare('DELETE FROM vms WHERE vmid = ?').run(row.vmid);
      audit(actor, row.vmid, 'server_deleted');
      await forgetServerBackups(row.vmid, guest.node);
    })
    .catch((err) => {
      db.prepare("UPDATE vms SET state = 'failed', error = ? WHERE vmid = ?")
        .run(`Deleting failed: ${err.message}`.slice(0, 500), row.vmid);
    })
    .finally(invalidateGuestCache);

  return { removed: false };
}

// Recovery follows accepted clone tasks. It never resubmits an ambiguous clone.
export function startComputeRecovery(log) {
  for (const op of pendingOperations()) {
    if (op.kind === 'resized') { runCatalogResize(op.id); continue; }
    if (op.kind !== 'create') { updateOperation(op.id, 'review', { error: 'Interrupted operation needs reconciliation' }); continue; }
    if (!op.upid || !op.task_node) {
      updateOperation(op.id, 'review', { error: 'Interrupted before the task response was recorded. Reconcile before retrying.' });
      continue;
    }
    const row = db.prepare('SELECT * FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid, op.customer_id);
    if (!row || JSON.parse(row.spec ?? '{}').operationId !== op.id) { updateOperation(op.id, 'review', { error: 'VM ownership needs reconciliation' }); continue; }
    try {
      const spec = { ...op.plan.spec, ...operationCredentials(op.id) };
      db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Resuming provisioning' WHERE vmid=?").run(op.vmid);
      finishCreate({ account: { id: op.user_id }, customerId: op.customer_id, ip: 'recovery' }, op.plan.node, op.vmid, op.upid, spec, op.plan.template, null, { operationId: op.id, taskNode: op.task_node }).catch(err => log.warn(err.message));
    } catch { updateOperation(op.id, 'review', { error: 'Provisioning credentials could not be recovered' }); }
  }
}

// Resume only an existing, identifiable VM. Never retry a clone POST.
export async function reconcileComputeOperation(req, id, action) {
  const op = operationById(id);
  if (op?.state === 'review' && op.kind === 'resized' && action === 'resume') {
    updateOperation(id,'configuring');
    runCatalogResize(id);
    return {accepted:true};
  }
  if (!op || op.state !== 'review' || op.kind !== 'create') throw new ProvisionError(409, 'This operation is not awaiting create reconciliation');
  const row = db.prepare('SELECT * FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid, op.customer_id);
  if (!row || JSON.parse(row.spec ?? '{}').operationId !== id) throw new ProvisionError(409, 'VM ownership needs manual reconciliation');
  if (op.upid && op.task_node) {
    const status = await pve.get(`/nodes/${encodeURIComponent(op.task_node)}/tasks/${encodeURIComponent(op.upid)}/status`);
    if (status.status !== 'stopped') throw new ProvisionError(409, 'The Proxmox task is still running');
    if (action === 'resume' && status.exitstatus !== 'OK') throw new ProvisionError(409, 'The Proxmox task failed. Inspect the VM before continuing.');
  }
  const guest = (await clusterGuests(true)).get(op.vmid);
  if (action === 'release') {
    const migration = operationStep(id, 'migration');
    if (migration && migration.state !== 'complete') {
      if (!migration.upid || !migration.task_node) throw new ProvisionError(409, 'An unknown migration retains its reservation');
      const status = await pve.get(`/nodes/${encodeURIComponent(migration.task_node)}/tasks/${encodeURIComponent(migration.upid)}/status`);
      if (status.status !== 'stopped') throw new ProvisionError(409, 'Migration is still running');
    }
    if (!op.upid || !op.task_node || guest) throw new ProvisionError(409, 'Release requires a recorded terminal task and verified VM absence. Unknown submissions retain their reservation.');
    await verifyComputeDeleted(op.vmid);
    releaseCompute(op.vmid);
    db.prepare('DELETE FROM vms WHERE vmid=?').run(op.vmid);
  } else {
    if (!guest || guest.template || ![op.plan.node, ...(op.plan.staging ? [op.plan.sourceNode] : [])].includes(guest.node)) throw new ProvisionError(409, 'The expected VM is not present on its reserved node');
    const cfg = await pve.get(`${guestPath(guest)}/config`);
    if (operationStep(id, 'migration') && guest.node !== op.plan.node) throw new ProvisionError(409, 'An attempted migration must be reconciled on its destination before resuming');
    if (guest.lock || cfg.lock || !String(cfg.description ?? '').includes(`pve-panel-operation:${id}`) || !(await pve.get(`/pools/${encodeURIComponent(op.plan.pool)}`)).members?.some(m => Number(m.vmid) === op.vmid && m.type === 'qemu')) throw new ProvisionError(409, 'VM identity, pool or lock state needs manual reconciliation');
    const spec = { ...op.plan.spec, ...operationCredentials(id) };
    if (operationById(id).state !== 'review') throw new ProvisionError(409, 'This operation already resumed');
    updateOperation(id, 'configuring');
    db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Resuming provisioning' WHERE vmid=?").run(op.vmid);
    finishCreate({ account: { id: op.user_id }, customerId: op.customer_id, ip: req.ip }, op.plan.node, op.vmid, null, spec, op.plan.template, null, { operationId: id });
  }
  audit({ account: req.account, customerId: op.customer_id, ip: req.ip }, op.vmid, 'admin_compute_reconcile', { id, action });
  return { accepted: true };
}
