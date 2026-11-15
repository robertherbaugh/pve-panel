import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startStack } from '../support/stack.mjs';

let stack, admin, user, customerId, sql, catalog, profile;
const request = extra => ({ customerId, sizeId: 'medium', storageClassId: 'standard', confirmName: 'web01', catalogRevision: catalog.revision, profileRevision: profile.revision, ...extra });
const adopt = extra => admin.post('/api/admin/compute-adoption/101', request(extra));
before(async () => {
  stack = await startStack({ env: { CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false', SETUP_CHECK_HOURS: '0' } });
  admin = await stack.adminSession(); user = await stack.customerWith('adoption@example.com', { limits: {} });
  customerId = (await admin.get('/api/admin/customers')).json.customers.find(c => c.name === 'adoption@example.com').id;
  sql = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  await admin.put('/api/admin/vms/101', { customerId });
  stack.mock.vms.get(101).cfg.net0 = 'virtio=BC:24:11:00:00:07,bridge=vmbr0,tag=47,firewall=1';
  stack.mock.perms['/vms'] = ['VM.Audit']; stack.mock.perms['/pool/customers'].push('Pool.Audit');
  stack.mock.cluster.nodes = [{ node: 'pve1', status: 'online', maxcpu: 64, maxmem: 128*2**30, mem: 2**30 }];
  stack.mock.cluster.storageInventories = { pve1: [{ storage: 'VMStorage', content: 'images', active: 1, enabled: 1, shared: 1, total: 1000*2**30, avail: 900*2**30 }] };
  let c = (await admin.get('/api/admin/compute-catalog')).json;
  c.sizes[0].enabled = true; c.sizes[1].enabled = true; c.classes[1].enabled = true; c.classes[1].bindings = [{ node: 'pve1', storage: 'VMStorage', purpose: 'vm' }];
  catalog = (await admin.put('/api/admin/compute-catalog', { revision: c.revision, sizes: c.sizes, classes: c.classes.map(({id,enabled,bindings}) => ({id,enabled,bindings})), reserves: c.reserves })).json;
  const p = (await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;
  const { revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb } = p;
  profile = (await admin.put(`/api/admin/customers/${customerId}/compute-profile`, { revision, catalogRevision: catalog.revision, tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb,catalogEnabled:true,network:{bridge:'vmbr0',vlan:47,verified:true} })).json;
});
after(async () => { sql?.close(); await stack?.stop(); });

test('adoption is provider-only and requires an assigned VM, exact offering and current confirmation', async () => {
  assert.equal((await user.post('/api/admin/compute-adoption/101', request())).status, 404);
  assert.equal((await stack.admin().post('/api/admin/compute-adoption/101', request())).status, 401);
  assert.equal((await admin.get('/api/admin/compute-adoption')).json.vms[0].vmid, 101);
  assert.equal((await adopt({ customerId: 99999 })).status, 400);
  assert.equal((await adopt({ confirmName: 'wrong-vm' })).status, 400);
  assert.equal((await adopt({ sizeId: 'small' })).status, 409);
  assert.equal((await adopt({ profileRevision: 0 })).status, 409);
  const guest = stack.mock.vms.get(101); guest.status = 'running';
  assert.equal((await adopt()).status, 409); guest.status = 'stopped';
  assert.equal(sql.prepare('SELECT count(*) n FROM compute_allocations').get().n, 0);
});
test('adoption rejects mismatched networks, extra disks, native HA and unavailable placement before changing records', async () => {
  const cfg = stack.mock.vms.get(101).cfg, nic = cfg.net0;
  cfg.net0 = nic.replace('tag=47', 'tag=99'); assert.equal((await adopt()).status, 409); cfg.net0 = nic;
  cfg.scsi1 = 'VMStorage:vm-101-disk-1,size=10G'; assert.equal((await adopt()).status, 409); delete cfg.scsi1;
  stack.mock.cluster.haResources = [{ sid: 'vm:101', state: 'stopped' }]; assert.equal((await adopt()).status, 409); stack.mock.cluster.haResources = [];
  stack.mock.cluster.nodes[0].maxcpu = 1; assert.equal((await adopt()).status, 409); stack.mock.cluster.nodes[0].maxcpu = 64;
  Object.defineProperty(stack.mock.cluster, 'networks', { configurable: true, get() {
    sql.prepare('UPDATE customers SET revision=revision+1 WHERE id=?').run(customerId);
    return [{ iface: 'vmbr0', active: 1 }];
  } });
  try { assert.equal((await adopt()).status, 409, 'customer changes during placement must prevent adoption'); }
  finally { delete stack.mock.cluster.networks; }
  assert.equal(sql.prepare('SELECT created_by_customer FROM vms WHERE vmid=101').get().created_by_customer, 0);
});
test('adoption atomically records existing resources and grants lifecycle control without changing the guest', async () => {
  const cfg = structuredClone(stack.mock.vms.get(101).cfg), destroyed = stack.mock.destroyed.length;
  const result = await adopt(); assert.equal(result.status, 200, result.text + stack.logs().slice(-4000));
  assert.deepEqual(stack.mock.vms.get(101).cfg, cfg); assert.equal(stack.mock.destroyed.length, destroyed);
  assert.equal(sql.prepare("SELECT count(*) n FROM compute_reservations WHERE vmid=101 AND state='committed'").get().n, 1);
  assert.equal(sql.prepare("SELECT count(*) n FROM compute_allocation_events WHERE kind='adopted'").get().n, 1);
  assert.equal((await user.get('/api/vms/101')).json.resizable, true);
  assert.equal((await adopt()).status, 409);
  await stack.restartPanel();
  assert.equal((await user.get('/api/vms/101')).json.offering.sizeId, 'medium');
  const resized = await user.post('/api/vms/101/resize', { sizeId: 'small', diskGb: 25 }); assert.equal(resized.status, 200, resized.text);
  const vm = await stack.serverSettled(user, 101); assert.equal(vm.state, 'ready', vm.error);
  assert.match(stack.mock.vms.get(101).cfg.scsi0, /size=25G/);
});
