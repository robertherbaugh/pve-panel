// Administrator-only selection data. Authorization still reads current pool
// membership separately, so stale or unavailable choices never grant access.
import { pve } from './pve.js';
import { config } from './config.js';

export async function accessInventory() {
  const get = (path) => pve.get(path, undefined, { signal: AbortSignal.timeout(10_000) });
  const [poolList, guests] = await Promise.all([get('/pools'), get('/cluster/resources?type=vm')]);
  const vms = guests
    .filter((g) => !g.template && ['qemu', 'lxc'].includes(g.type) && Number(g.vmid) !== config.vpn.gatewayVmid)
    .map((g) => ({ vmid: Number(g.vmid), name: g.name || `VM ${g.vmid}`, node: g.node, type: g.type,
      tags: [...new Set(String(g.tags ?? '').split(';').filter(Boolean))].sort(), pools: [] }))
    .sort((a, b) => a.vmid - b.vmid);
  const byId = new Map(vms.map((g) => [g.vmid, g]));
  const pools = [];
  const warnings = [];
  // Bound concurrent requests on installations with many pools.
  for (let i = 0; i < poolList.length; i += 8) {
    await Promise.all(poolList.slice(i, i + 8).map(async (pool) => {
      try {
        const detail = await get(`/pools/${encodeURIComponent(pool.poolid)}`);
        const ids = new Set((detail.members ?? []).filter((m) => ['qemu', 'lxc'].includes(m.type)).map((m) => Number(m.vmid)));
        for (const vmid of ids) byId.get(vmid)?.pools.push(pool.poolid);
        pools.push({ id: pool.poolid, comment: detail.comment || pool.comment || '',
          vmCount: [...ids].filter((id) => byId.has(id)).length, available: true });
      } catch {
        pools.push({ id: pool.poolid, comment: pool.comment || '', vmCount: null, available: false });
        warnings.push(`Pool ${pool.poolid} could not be read. Its existing selections are preserved.`);
      }
    }));
  }
  for (const vm of vms) vm.pools.sort();
  const counts = new Map();
  for (const vm of vms) for (const tag of vm.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return { pools: pools.sort((a, b) => a.id.localeCompare(b.id)),
    tags: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([name, vmCount]) => ({ name, vmCount })), vms, warnings };
}
