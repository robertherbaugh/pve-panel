import { db } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath } from './pve.js';
import { computeCatalog, computeProfile } from './compute-catalog.js';
import { computeInventory, previewCompute } from './compute-inventory.js';
import { heldReservations, computeManaged } from './compute-state.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
export function customerOfferings(customerId) {
  const c = computeCatalog(), p = computeProfile(customerId);
  return {
    enabled: p.catalogEnabled, revision: c.revision, profileRevision: p.revision,
    sizes: c.sizes.filter((s) => s.enabled && (p.sizeIds === null || p.sizeIds.includes(s.id))),
    classes: c.classes.filter((s) => s.enabled && p.storageClassIds.includes(s.id)).map(({ id, name, description }) => ({ id, name, description })),
    haAvailable: false, backupServiceEnabled: p.backupServiceEnabled, backupServiceIncluded: p.backupServiceIncluded,
    backupStorageIncluded: false, backupClassId: 'basic', billingMode: 'reservation',
  };
}
export function resolveOffering(customerId, spec) {
  const p = computeProfile(customerId), c = computeCatalog();
  if (!p.catalogEnabled) {
    if (spec.sizeId || spec.storageClassId || spec.haEnabled) fail('Catalog provisioning is not enabled for this customer', 403);
    return null;
  }
  if (typeof spec.templateId !== 'number') fail('Catalog provisioning currently supports VM images only', 400);
  if (config.network.enabled) fail('Catalog provisioning requires a verified existing guest network. Disable automatic SDN networks before enabling this path.');
  if (!p.network.verified) fail('The provider must verify this customer’s guest network before provisioning.');
  const size = c.sizes.find((s) => s.id === spec.sizeId && s.enabled && (p.sizeIds === null || p.sizeIds.includes(s.id)));
  const cls = c.classes.find((s) => s.id === spec.storageClassId && s.enabled && p.storageClassIds.includes(s.id));
  if (!size || !cls) fail('Choose an available VM size and storage class', 400);
  if ((spec.cores !== undefined && spec.cores !== size.cores) || (spec.memoryMb !== undefined && spec.memoryMb !== size.memoryMb)) fail('CPU and memory must match the selected VM size', 400);
  if (spec.diskGb < size.minDiskGb) fail(`This VM size needs at least ${size.minDiskGb} GiB of disk`, 400);
  if (spec.haEnabled) fail('HA activation is not available yet', 400);
  const used = db.prepare('SELECT spec FROM vms WHERE customer_id=?').all(customerId).reduce((total, r) => {
    const s = JSON.parse(r.spec ?? '{}'); return total + (s.offering?.storageClassId === cls.id ? s.diskGb ?? 0 : 0);
  }, 0);
  if (p.storageLimitsGb[cls.id] > 0 && used + spec.diskGb > p.storageLimitsGb[cls.id]) fail(`This exceeds the customer’s ${cls.name} storage limit`);
  spec.cores = size.cores; spec.memoryMb = size.memoryMb;
  return { sizeId: size.id, sizeName: size.name, storageClassId: cls.id, cores: size.cores, memoryMb: size.memoryMb, diskGb: spec.diskGb, haEnabled: false, catalogRevision: c.revision, profileRevision: p.revision, network: p.network };
}
export function checkOfferingRevision(customerId, offering) {
  if (computeCatalog().revision !== offering.catalogRevision || computeProfile(customerId).revision !== offering.profileRevision) fail('The catalog or customer offerings changed. Try again.');
}
const read = (path, params) => pve.get(path, params, { signal: AbortSignal.timeout(8000) });
async function requirePrivileges(path, names) {
  const perms = await read('/access/permissions', { path });
  if (names.some((p) => !(perms?.[path]?.[p] === 1 || perms?.[path]?.[p] === true))) fail(`The provider token needs ${names.join(', ')} on ${path}`);
}
export async function selectPlacement({ offering, template, sourceConfig, pool, grant }) {
  const catalog = computeCatalog(), inventory = await computeInventory(), guests = await clusterGuests(true);
  if (inventory.errors.length) fail('Node inventory is unavailable. The provider must check the cluster connection and audit permissions.');
  // Global read access is required to count other tenants' stopped reservations.
  await requirePrivileges('/vms', ['VM.Audit']);
  await requirePrivileges(`/vms/${template.vmid}`, ['VM.Clone']);
  await requirePrivileges(`/pool/${pool}`, ['Pool.Audit', 'VM.Allocate', 'VM.Audit', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Disk', 'VM.Config.Network', 'VM.Config.Cloudinit', 'VM.Config.Options', 'VM.PowerMgmt']);
  let haStatus;
  try { haStatus = await read('/cluster/ha/status/current'); }
  catch { fail('Cluster maintenance state cannot be verified with the current token.'); }
  if (!Array.isArray(haStatus)) fail('Cluster maintenance inventory is unavailable.');
  const maintenance = new Set(haStatus.filter((s) => s.type === 'lrm' && /maintenance|lost|unavailable/i.test(s.status ?? '')).map((s) => s.node));
  const preview = previewCompute({ sizeId: offering.sizeId, storageClassId: offering.storageClassId, diskGb: offering.diskGb }, inventory, catalog);
  const sourceDisks = Object.entries(sourceConfig).filter(([key, value]) => /^(?:(?:scsi|sata|virtio|ide)\d+|efidisk0|tpmstate0)$/.test(key) && !String(value).includes('media=cdrom') && !String(value).startsWith('none')).map(([, v]) => String(v).split(':')[0]);
  // The clone target option requires shared source volumes, including cloud-init.
  if (sourceConfig.ide2 && String(sourceConfig.ide2).includes('cloudinit')) sourceDisks.push(String(sourceConfig.ide2).split(':')[0]);
  const sourceNode = inventory.nodes.find((n) => n.node === template.node);
  const holds = heldReservations(), reasons = [], candidates = [], allocations = new Map();
  for (const candidate of preview.candidates) {
    const errors = [...candidate.reasons], node = inventory.nodes.find((n) => n.node === candidate.node), storage = node?.storages.find((s) => s.storage === candidate.storage);
    if (maintenance.has(candidate.node)) errors.push('Node is in maintenance or unavailable to HA.');
    if (grant && !grant.clone.storages.includes(candidate.storage)) errors.push('Storage is outside the clone permission set.');
    if (candidate.node !== template.node && sourceDisks.some((id) => sourceNode?.storages.find((s) => s.storage === id)?.shared !== true || !node?.storages.some((s) => s.storage === id && s.active === true && s.shared === true))) errors.push('Template volumes are not shared with this node.');
    if (!allocations.has(candidate.node)) {
      const used = { memoryMb: 0, cores: 0 }; let unknown = false;
      for (const g of guests.values()) if (!g.template && g.node === candidate.node) {
        try {
          const cfg = await read(`${guestPath(g)}/config`);
          const memory = Number(cfg.memory), cores = Number(cfg.cores) * Number(cfg.sockets ?? 1);
          if (!(memory > 0 && cores > 0)) throw new Error('Unknown guest allocation');
          const reserved = holds.filter(h => h.vmid === g.vmid);
          used.memoryMb += Math.max(memory, ...reserved.map(h => h.memory_mb));
          used.cores += Math.max(cores, ...reserved.map(h => h.cores));
        } catch { unknown = true; break; }
      }
      allocations.set(candidate.node, { used, unknown });
    }
    const { used: observed, unknown } = allocations.get(candidate.node), used = { ...observed };
    if (unknown) errors.push('Existing guest reservations cannot be read.');
    const pending = holds.filter((h) => h.node === candidate.node && !guests.has(h.vmid));
    used.memoryMb += pending.reduce((n, h) => n + h.memory_mb, 0); used.cores += pending.reduce((n, h) => n + h.cores, 0);
    if (node?.memoryBytes != null && used.memoryMb + offering.memoryMb + catalog.reserves.memoryMb > node.memoryBytes / 2 ** 20) errors.push('Allocated memory leaves insufficient reservation capacity.');
    // Start conservatively at one allocated vCPU per logical host CPU.
    if (node?.cores != null && used.cores + offering.cores > node.cores) errors.push('Allocated vCPUs leave insufficient reservation capacity.');
    const storageKey = storage?.shared ? `shared/${candidate.storage}` : `${candidate.node}/${candidate.storage}`;
    const diskHolds = holds.filter((h) => h.storage_key === storageKey && (h.state === 'held' || !guests.has(h.vmid))).reduce((n, h) => n + h.disk_gb, 0);
    if (storage?.availableBytes != null && offering.diskGb + diskHolds + catalog.reserves.diskGb > storage.availableBytes / 2 ** 30) errors.push('Pending disk reservations leave insufficient free capacity.');
    if (!errors.length) {
      try {
        await requirePrivileges(`/storage/${candidate.storage}`, ['Datastore.AllocateSpace', 'Datastore.Audit']);
        const nets = await read(`/nodes/${encodeURIComponent(candidate.node)}/network`);
        if (!Array.isArray(nets) || !nets.some((n) => n.iface === offering.network.bridge && (n.active === 1 || n.active === true))) throw new Error('Guest bridge is unavailable');
      } catch { errors.push('Storage allocation permissions or the verified guest bridge are unavailable.'); }
    }
    if (errors.length) reasons.push(`${candidate.node}/${candidate.storage}: ${errors.join(' ')}`);
    else candidates.push({ ...candidate, storageKey, score: used.memoryMb / (node.memoryBytes / 2 ** 20) + used.cores / node.cores });
  }
  candidates.sort((a, b) => a.score - b.score || a.node.localeCompare(b.node) || a.storage.localeCompare(b.storage));
  if (!candidates.length) fail('No eligible placement is available. Ask the provider to check capacity, template accessibility and permissions.');
  return { ...candidates[0], cores: offering.cores, memoryMb: offering.memoryMb, diskGb: offering.diskGb, offering, sourceNode: template.node, templateId: template.vmid, pool };
}

export async function verifyComputeDeleted(vmid) {
  if (computeManaged(vmid)) await requirePrivileges('/vms', ['VM.Audit']);
  if ((await clusterGuests(true)).has(vmid)) fail('VM deletion could not be verified');
}
