import { randomUUID } from 'node:crypto';
import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath, bootDiskKey, diskSizeGb, serial } from './pve.js';
import { customerById } from './tenancy.js';
import { customerHasGuest } from './access.js';
import { resolveOffering, selectPlacement, checkOfferingRevision } from './compute-placement.js';
import { computeManaged, recordAllocation, assertComputeIdle } from './compute-state.js';
import { capacityLocks, capacityBusy } from './capacity.js';
import { assertNoHa } from './compute-ha.js';
import { customerUsage } from './provision.js';
import { activeRun } from './winupdate.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
export async function adoptionCandidates() {
  const guests = await clusterGuests(true);
  return db.prepare('SELECT vmid,customer_id FROM vms WHERE state=\'ready\'').all().flatMap(row => {
    const g = guests.get(row.vmid);
    return g && g.type === 'qemu' && !g.template && row.vmid !== config.vpn.gatewayVmid && !computeManaged(row.vmid)
      ? [{ vmid: row.vmid, customerId: row.customer_id, name: g.name, node: g.node, status: g.status }] : [];
  });
}

// Adoption records the existing allocation. It never clones, moves or changes a guest.
export async function adoptCompute(req, vmid, input) {
  const customer = customerById(input.customerId);
  if (!customer?.enabled) fail('Choose an enabled customer', 400);
  if (capacityBusy(customer.id)) fail('Wait until this customer’s compute operations finish');
  capacityLocks.add(`customer:${customer.id}`);
  try {
    return await serial(async () => {
      const row = db.prepare('SELECT * FROM vms WHERE vmid=? AND customer_id=?').get(vmid, customer.id);
      if (!row || row.state !== 'ready') fail('Assign this VM to the customer before adopting it');
      assertComputeIdle(vmid);
      if (computeManaged(vmid)) fail('This VM already has a catalog allocation');
      if (db.prepare("SELECT 1 FROM backup_jobs WHERE vmid=? AND state IN ('queued','running')").get(vmid)
        || activeRun(vmid)) fail('Wait until the VM’s current operation finishes');
      const guest = (await clusterGuests(true)).get(vmid);
      if (!guest || guest.type !== 'qemu' || guest.template || vmid === config.vpn.gatewayVmid || guest.status !== 'stopped') fail('Adoption requires a stopped, assigned VM');
      if (input.confirmName !== guest.name) fail('Type the VM’s current name to confirm adoption', 400);
      if (!await customerHasGuest(customer, guest, row)) fail('The VM is outside this customer’s resource boundary', 403);
      const path = guestPath(guest), cfg = await pve.get(`${path}/config`);
      if (cfg.lock || guest.lock || cfg.protection) fail('Unlock and unprotect the VM before adoption');
      if (Object.keys(cfg).some(k => /^(?:hostpci|usb|unused)\d+$/.test(k) || ['args','hookscript','ivshmem','cicustom'].includes(k))) fail('Remove host-specific configuration and unused volumes before adoption');
      const disks = Object.entries(cfg).filter(([k,v]) => /^(scsi|sata|virtio|ide)\d+$/.test(k) && !/media=cdrom|cloudinit/.test(String(v)) && !String(v).startsWith('none'));
      if (disks.length !== 1 || disks[0][0] !== bootDiskKey(cfg) || Object.keys(cfg).some(k => /^net[1-9][0-9]*$/.test(k))) fail('Adoption supports one boot disk and one guest network interface');
      const diskGb = diskSizeGb(disks[0][1]);
      if (!Number.isSafeInteger(diskGb) || diskGb < 1) fail('The disk capacity must be a whole number of GiB');
      const spec = { templateId: 0, sizeId: input.sizeId, storageClassId: input.storageClassId, diskGb };
      const offering = resolveOffering(customer.id, spec, vmid);
      if (!offering) fail('Enable catalog provisioning for this customer first');
      if (input.catalogRevision !== offering.catalogRevision || input.profileRevision !== offering.profileRevision) fail('The catalog or customer offerings changed. Reload before adopting.');
      if (Number(cfg.cores) * Number(cfg.sockets ?? 1) !== offering.cores || Number(cfg.memory) !== offering.memoryMb) fail('Choose a size matching the VM’s configured CPU and memory');
      const nic = String(cfg.net0 ?? '').split(','), bridge = nic.find(s => s.startsWith('bridge='))?.slice(7), vlan = nic.find(s => s.startsWith('tag='))?.slice(4);
      if (bridge !== offering.network.bridge || (vlan ? Number(vlan) : null) !== offering.network.vlan || !nic.includes('firewall=1') || nic.some(s => s.startsWith('trunks='))) fail('The existing NIC must match the verified customer bridge, VLAN and firewall configuration');
      const usage = await customerUsage(customer);
      if (Object.entries(customer.limits).some(([key,limit]) => limit > 0 && usage[key] > limit)) fail('The customer’s existing allocations exceed its shared quota');
      await assertNoHa(vmid);
      const oldSpec = JSON.parse(row.spec ?? '{}'), pool = oldSpec.pool ?? config.pve.pool;
      const members = await pve.get(`/pools/${encodeURIComponent(pool)}`);
      if (!members.members?.some(g => Number(g.vmid) === vmid && g.type === 'qemu')) fail('The VM must belong to its configured provisioning pool');
      const storage = String(disks[0][1]).split(':')[0];
      const plan = await selectPlacement({ offering, template: guest, sourceConfig: cfg, pool, existing: { vmid, node: guest.node, storage, diskGb } });
      checkOfferingRevision(customer.id, offering);
      const current = (await clusterGuests(true)).get(vmid), currentCfg = await pve.get(`${path}/config`);
      const latest = db.prepare('SELECT * FROM vms WHERE vmid=?').get(vmid);
      if (!customerById(customer.id)?.enabled || latest?.customer_id !== customer.id || latest.state !== 'ready' || latest.spec !== row.spec || current?.node !== guest.node || current?.status !== 'stopped' || currentCfg.digest !== cfg.digest || JSON.stringify(currentCfg) !== JSON.stringify(cfg)) fail('The VM changed during validation. Reload before adopting.');
      assertComputeIdle(vmid);
      checkOfferingRevision(customer.id, offering);
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        recordAllocation(vmid, customer.id, offering, 'adopted');
        db.prepare("INSERT INTO compute_operations(id,customer_id,user_id,vmid,kind,state,plan) VALUES(?,?,?,?,'adopted','complete',?)").run(id, customer.id, req.account.id, vmid, JSON.stringify(plan));
        db.prepare("INSERT INTO compute_reservations(operation_id,vmid,node,storage,storage_key,cores,memory_mb,disk_gb,state) VALUES(?,?,?,?,?,?,?,?,'committed')").run(id, vmid, guest.node, storage, plan.storageKey, offering.cores, offering.memoryMb, diskGb);
        db.prepare('UPDATE vms SET created_by_customer=1,spec=? WHERE vmid=?').run(JSON.stringify({ ...oldSpec, template: oldSpec.template ?? 0, hostname: guest.name, cores: offering.cores, memoryMb: offering.memoryMb, diskGb, offering, pool, operationId: id }), vmid);
        audit({ account: req.account, ip: req.ip, customerId: customer.id }, vmid, 'admin_compute_adopted', { operationId: id, offering });
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return { vmid, operationId: id, offering };
    });
  } finally { capacityLocks.delete(`customer:${customer.id}`); }
}
