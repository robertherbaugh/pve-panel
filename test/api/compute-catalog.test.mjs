import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack } from '../support/stack.mjs';

let stack, admin, user, dir, sql;
const state = async () => (await admin.get('/api/admin/compute-catalog')).json;
const body = (c) => ({ revision: c.revision, sizes: c.sizes, classes: c.classes.map(({ id, enabled, bindings }) => ({ id, enabled, bindings })), reserves: c.reserves });
const profileBody = (p, catalogRevision) => ({
  revision: p.revision, catalogRevision, tier: p.tier, sizeIds: p.sizeIds, storageClassIds: p.storageClassIds,
  haAllowed: p.haAllowed, backupServiceEnabled: p.backupServiceEnabled, storageLimitsGb: p.storageLimitsGb, backupLimitGb: p.backupLimitGb,
});
const start = () => startStack({ env: { DB_PATH: path.join(dir, 'saved.db'), SETUP_CHECK_HOURS: '0', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false' } });
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-compute-catalog-'));
  stack = await start(); admin = await stack.adminSession();
  user = await stack.customerWith('compute@example.com');
  sql = new DatabaseSync(path.join(dir, 'saved.db'));
});
after(async () => { sql?.close(); await stack?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('catalog starts with opt-in disabled and fixed storage classes, disabled examples and reservation billing', async () => {
  const c = await state();
  assert.deepEqual(c.classes.map(({ id, media }) => ({ id, media })), [
    { id: 'basic', media: 'HDD' }, { id: 'standard', media: 'Enterprise SSD' }, { id: 'fast', media: 'NVMe' },
  ]);
  assert.equal(c.backupClassId, 'basic'); assert.equal(c.billingMode, 'reservation'); assert.equal(c.rollout, 'customer-opt-in');
  assert.ok(c.sizes.every((s) => !s.enabled)); assert.ok(c.classes.every((s) => !s.enabled && !s.bindings.length));
  assert.equal(c.revision, 1);
  assert.match((await admin.get('/api/admin/compute-catalog')).headers.get('cache-control'), /no-store/);
});

test('catalog and profiles are isolated to platform administrators', async () => {
  const id = (await admin.get('/api/admin/customers')).json.customers[0].id;
  const endpoints = ['/api/admin/compute-catalog', '/api/admin/compute-catalog/inventory', `/api/admin/customers/${id}/compute-profile`];
  for (const endpoint of endpoints) {
    assert.equal((await stack.admin().get(endpoint)).status, 401);
    assert.equal((await user.get(endpoint)).status, 404);
    const borrowed = stack.admin(); borrowed.cookies = new Map(user.cookies);
    assert.equal((await borrowed.get(endpoint)).status, 401);
    if (!endpoint.endsWith('/inventory')) assert.equal((await borrowed.put(endpoint, {})).status, 401);
  }
  assert.equal((await user.post('/api/admin/compute-catalog/preview', {})).status, 404);
  assert.equal((await stack.admin().post('/api/admin/compute-catalog/preview', {})).status, 401);
});

test('catalog validates media boundaries, backup destinations, sizes and revisions without partial saves', async () => {
  const original = await state(), changes = body(original);
  const invalid = [
    { ...changes, billingMode: 'runtime' }, { ...changes, backupClassId: 'fast' },
    { ...changes, sizes: [{ ...changes.sizes[0], cores: 0 }] },
    { ...changes, sizes: [{ ...changes.sizes[0], memoryMb: 511 }] },
    { ...changes, sizes: [{ ...changes.sizes[0], cores: 1.5 }] },
    { ...changes, sizes: [{ ...changes.sizes[0], enabled: 'yes' }] },
    { ...changes, sizes: [changes.sizes[0], changes.sizes[0]] },
    { ...changes, classes: changes.classes.slice(0, 2) },
    { ...changes, reserves: { memoryMb: -1, diskGb: 0 } },
  ];
  for (const classId of ['standard', 'fast']) {
    const c = structuredClone(changes); c.classes.find((x) => x.id === classId).bindings.push({ node: 'pve1', storage: 'pbs', purpose: 'backup' }); invalid.push(c);
  }
  const mixed = structuredClone(changes);
  mixed.classes[0].bindings.push({ node: 'pve1', storage: 'shared', purpose: 'vm' });
  mixed.classes[2].bindings.push({ node: 'pve1', storage: 'shared', purpose: 'vm' }); invalid.push(mixed);
  const traversal = structuredClone(changes); traversal.classes[0].bindings.push({ node: '../secret', storage: 'data', purpose: 'vm' }); invalid.push(traversal);
  for (const input of invalid) assert.equal((await admin.put('/api/admin/compute-catalog', input)).status, 400, JSON.stringify(input));
  assert.deepEqual(await state(), original);
  changes.sizes[0].enabled = true;
  changes.classes[0].enabled = true;
  changes.classes[0].bindings = [
    { node: 'pve1', storage: 'hdd', purpose: 'vm' },
    { node: 'pve2', storage: 'hdd', purpose: 'vm' },
    { node: 'pve3', storage: 'hdd', purpose: 'vm' },
    { node: 'pve1', storage: 'pbs', purpose: 'backup' },
  ];
  const saved = await admin.put('/api/admin/compute-catalog', changes);
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.json.revision, 2);
  assert.equal((await admin.put('/api/admin/compute-catalog', changes)).status, 409);
  assert.equal(sql.prepare('SELECT count(*) n FROM compute_catalog_revisions').get().n, 2);
  assert.ok(sql.prepare("SELECT 1 FROM audit_log WHERE action='admin_compute_catalog'").get());
});

test('node-local datastore names may map to different media on different nodes', async () => {
  let c = body(await state());
  c.classes[0].bindings.push({ node: 'pve1', storage: 'local-lvm', purpose: 'vm' });
  c.classes[2].bindings.push({ node: 'pve2', storage: 'local-lvm', purpose: 'vm' });
  const saved = await admin.put('/api/admin/compute-catalog', c);
  assert.equal(saved.status, 200, saved.text);
  c = body(saved.json);
  for (const cls of c.classes) cls.bindings = cls.bindings.filter((b) => b.storage !== 'local-lvm');
  assert.equal((await admin.put('/api/admin/compute-catalog', c)).status, 200);
});

test('capacity preview distinguishes healthy, offline and unreadable destinations and performs only reads', async () => {
  stack.mock.cluster.nodes = [
    { node: 'pve1', status: 'online', maxcpu: 16, maxmem: 64 * 2 ** 30, mem: 8 * 2 ** 30 },
    { node: 'pve2', status: 'offline', maxcpu: 16, maxmem: 64 * 2 ** 30, mem: 0 },
    { node: 'pve3', status: 'online' },
  ];
  stack.mock.cluster.storageInventories = {
    pve1: [{ storage: 'hdd', content: 'images,rootdir', active: 1, enabled: 1, total: 1000 * 2 ** 30, avail: 900 * 2 ** 30 }],
    pve3: null,
  };
  stack.mock.cluster.observedRequests = [];
  const request = { sizeId: 'small', storageClassId: 'basic', diskGb: 20 };
  const res = await admin.post('/api/admin/compute-catalog/preview', request);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.candidates.length, 3, 'backup mapping is not a VM destination');
  assert.equal(res.json.candidates[0].passesCapacityChecks, true);
  assert.equal(res.json.candidates[1].passesCapacityChecks, false);
  assert.ok(res.json.candidates[1].reasons.includes('Node is not online.'));
  assert.equal(res.json.candidates[2].passesCapacityChecks, false);
  assert.ok(res.json.candidates[2].reasons.some((r) => r.includes('CPU capacity is unavailable')));
  assert.ok(res.json.candidates[2].reasons.some((r) => r.includes('Storage inventory is unavailable')));
  assert.equal(res.json.reservesCapacity, false); assert.equal(res.json.rollout, 'preview');
  assert.ok(res.json.checksPending.some((r) => r.includes('HA')));
  assert.ok(stack.mock.cluster.observedRequests.every((r) => r.method === 'GET'));
  const before = stack.mock.cluster.observedRequests.length;
  assert.equal((await admin.post('/api/admin/compute-catalog/preview', { ...request, diskGb: 1 })).status, 400);
  assert.equal((await admin.post('/api/admin/compute-catalog/preview', { ...request, sizeId: 'missing' })).status, 400);
  assert.equal(stack.mock.cluster.observedRequests.length, before, 'invalid requests do not call Proxmox');
  stack.mock.cluster.inventoryDenied = true;
  const denied = await admin.post('/api/admin/compute-catalog/preview', request);
  assert.equal(denied.status, 200); assert.ok(denied.json.candidates.every((c) => !c.passesCapacityChecks));
  assert.ok(denied.json.errors.length);
  stack.mock.cluster.inventoryDenied = false;
});

test('preview respects observed capacity reserves and treats missing datastore capacity as unknown', async () => {
  const req = { sizeId: 'small', storageClassId: 'basic', diskGb: 20 };
  const host = stack.mock.cluster.nodes[0], st = stack.mock.cluster.storageInventories.pve1[0];
  host.mem = host.maxmem - 3 * 2 ** 30;
  st.avail = 39 * 2 ** 30;
  let preview = (await admin.post('/api/admin/compute-catalog/preview', req)).json;
  assert.ok(preview.candidates[0].reasons.some((r) => r.includes('free memory')));
  assert.ok(preview.candidates[0].reasons.some((r) => r.includes('free disk')));
  host.mem = 0; delete st.avail; delete st.active;
  preview = (await admin.post('/api/admin/compute-catalog/preview', req)).json;
  assert.ok(preview.candidates[0].reasons.some((r) => r.includes('capacity is unavailable')));
  assert.ok(preview.candidates[0].reasons.some((r) => r.includes('availability is unverified')));
});

test('customer offerings separate service inclusion, storage, optional HA and operation permissions', async () => {
  const id = (await admin.get('/api/admin/customers')).json.customers.find((c) => c.name === 'compute@example.com').id;
  const url = `/api/admin/customers/${id}/compute-profile`;
  const initial = (await admin.get(url)).json;
  assert.equal(initial.haEnabledByDefault, false); assert.equal(initial.backupStorageIncluded, false);
  assert.equal(initial.backupServiceEnabled, false); assert.equal(initial.backupServiceIncluded, false);
  assert.equal(initial.sizeIds, null); assert.deepEqual(initial.storageClassIds, ['basic', 'standard', 'fast']);
  const c = await state(), input = { ...profileBody(initial, c.revision), tier: 'ridge', sizeIds: ['small'], backupServiceEnabled: true };
  const saved = await admin.put(url, input);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.backupServiceIncluded, true); assert.equal(saved.json.backupStorageIncluded, false);
  assert.equal(saved.json.backupClassId, 'basic'); assert.equal(saved.json.haEnabledByDefault, false);
  assert.equal((await user.get('/api/account')).json.canCreate, false, 'profile does not grant VM operation rights');
  assert.equal((await admin.put(url, input)).status, 409);
  assert.equal((await admin.put(url, { ...input, revision: saved.json.revision, catalogRevision: c.revision - 1 })).status, 409);
  const latest = profileBody(saved.json, c.revision);
  for (const patch of [{ tier: 'unknown' }, { sizeIds: ['unknown'] }, { storageClassIds: ['eco'] }, { haAllowed: 'yes' }, { backupClassId: 'fast' }, { backupLimitGb: -1 }]) {
    assert.equal((await admin.put(url, { ...latest, ...patch })).status, 400, JSON.stringify(patch));
  }
  const remove = body(c); remove.sizes = remove.sizes.filter((s) => s.id !== 'small');
  assert.equal((await admin.put('/api/admin/compute-catalog', remove)).status, 409);
  assert.deepEqual((await admin.get(url)).json, saved.json);
  assert.equal((await admin.get('/api/admin/customers/999999/compute-profile')).status, 404);
  assert.equal((await admin.get('/api/admin/customers/0/compute-profile')).status, 400);
  assert.ok(sql.prepare("SELECT 1 FROM audit_log WHERE action='admin_customer_compute_profile' AND customer_id=?").get(id));
  // Retain tombstoned profiles for history without blocking catalog maintenance.
  sql.prepare("UPDATE customers SET enabled=0,deleted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(id);
  assert.equal((await admin.get(url)).status, 404);
  assert.equal((await admin.put('/api/admin/compute-catalog', remove)).status, 200);
});

test('catalog and profiles survive a restart without reclassifying or changing existing VMs', async () => {
  const catalog = await state(), profiles = sql.prepare('SELECT * FROM customer_compute_profiles').all();
  const vms = sql.prepare('SELECT * FROM vms').all(), backups = sql.prepare('SELECT * FROM backup_jobs').all();
  sql.close(); sql = null;
  await stack.stop(); stack = await start(); admin = await stack.adminSession();
  assert.deepEqual(await state(), catalog);
  sql = new DatabaseSync(path.join(dir, 'saved.db'));
  assert.deepEqual(sql.prepare('SELECT * FROM customer_compute_profiles').all(), profiles);
  assert.deepEqual(sql.prepare('SELECT * FROM vms').all(), vms);
  assert.deepEqual(sql.prepare('SELECT * FROM backup_jobs').all(), backups);
  assert.equal(sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});
