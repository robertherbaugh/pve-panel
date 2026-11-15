import { pve } from './pve.js';
import { computeCatalog } from './compute-catalog.js';

const read = (path) => pve.get(path, undefined, { signal: AbortSignal.timeout(8000) });
const capacity = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const flag = (n) => n === 1 || n === true ? true : n === 0 || n === false ? false : null;

export async function computeInventory() {
  const errors = [], nodes = [];
  let all;
  try { all = await read('/nodes'); }
  catch { return { observedAt: new Date().toISOString(), nodes, errors: ['Node inventory is unavailable with the current Proxmox connection or permissions.'] }; }
  if (!Array.isArray(all)) return { observedAt: new Date().toISOString(), nodes, errors: ['Proxmox returned an invalid node inventory.'] };
  if (all.length > 64) errors.push('Inventory is limited to the first 64 nodes.');
  // Bound concurrency and request duration. Partial inventory must remain visible.
  for (let i = 0; i < Math.min(all.length, 64); i += 8) {
    const group = await Promise.all(all.slice(i, Math.min(i + 8, 64)).map(async (n) => {
      const node = {
        node: n.node, status: n.status ?? 'unknown', cores: capacity(n.maxcpu),
        memoryBytes: capacity(n.maxmem), usedMemoryBytes: capacity(n.mem), storages: [], error: null,
      };
      if (node.status !== 'online') return node;
      try {
        const storages = await read(`/nodes/${encodeURIComponent(n.node)}/storage`);
        if (!Array.isArray(storages)) throw new Error('Invalid inventory');
        node.storages = storages.map((s) => ({
          storage: s.storage, type: s.type ?? null, content: String(s.content ?? '').split(',').filter(Boolean),
          active: flag(s.active), enabled: flag(s.enabled), shared: flag(s.shared),
          totalBytes: capacity(s.total), availableBytes: capacity(s.avail),
        }));
      } catch { node.error = 'Storage inventory is unavailable on this node.'; }
      return node;
    }));
    nodes.push(...group);
  }
  return { observedAt: new Date().toISOString(), nodes, errors };
}

// An infrastructure preview, not a placement promise. No capacity is reserved,
// no template is cloned and no HA/network settings are written.
export function previewCompute(input, inventory, catalog = computeCatalog()) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['sizeId', 'storageClassId', 'diskGb'].includes(k))) fail('Invalid preview');
  const size = catalog.sizes.find((s) => s.id === input.sizeId);
  const storageClass = catalog.classes.find((c) => c.id === input.storageClassId);
  if (!size || !storageClass) fail('Select a known size and storage class');
  if (!Number.isSafeInteger(input.diskGb) || input.diskGb < size.minDiskGb || input.diskGb > 65536) fail('Invalid disk capacity for this size');
  const rows = storageClass.bindings.filter((b) => b.purpose === 'vm').map((binding) => {
    const reasons = [], node = inventory.nodes.find((n) => n.node === binding.node), storage = node?.storages.find((s) => s.storage === binding.storage);
    if (!size.enabled) reasons.push('VM size is disabled.');
    if (!storageClass.enabled) reasons.push('Storage class is disabled.');
    if (!node) reasons.push('Node is absent from the current inventory.');
    else {
      if (node.status !== 'online') reasons.push('Node is not online.');
      if (node.cores === null) reasons.push('Node CPU capacity is unavailable.');
      else if (node.cores < size.cores) reasons.push('Node has fewer logical CPUs than this size requires.');
      if (node.memoryBytes === null || node.usedMemoryBytes === null) reasons.push('Node memory capacity is unavailable.');
      else if (node.memoryBytes - node.usedMemoryBytes < (size.memoryMb + catalog.reserves.memoryMb) * 2 ** 20) reasons.push('Insufficient observed free memory after the host reserve.');
      if (node.error) reasons.push(node.error);
    }
    if (!storage) reasons.push('Datastore is absent from the current node inventory.');
    else {
      if (storage.active !== true || storage.enabled === false) reasons.push('Datastore is inactive or its availability is unverified.');
      if (!storage.content.includes('images')) reasons.push('Datastore does not report VM disk support.');
      if (storage.availableBytes === null) reasons.push('Datastore free capacity is unavailable.');
      else if (storage.availableBytes < (input.diskGb + catalog.reserves.diskGb) * 2 ** 30) reasons.push('Insufficient observed free disk capacity after the storage reserve.');
    }
    return { ...binding, passesCapacityChecks: reasons.length === 0, reasons };
  });
  return {
    rollout: 'preview', catalogRevision: catalog.revision, observedAt: inventory.observedAt,
    sizeId: size.id, storageClassId: storageClass.id, diskGb: input.diskGb,
    candidates: rows, errors: [...inventory.errors, ...(!rows.length ? ['No VM storage mappings exist for this class.'] : [])],
    checksPending: ['Template clone compatibility', 'Guest network isolation and reachability', 'Host CPU compatibility', 'Maintenance state and allocation permissions', 'Concurrent capacity reservations', 'HA configuration and failover capacity'],
    reservesCapacity: false,
  };
}
