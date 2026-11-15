import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startStack } from '../support/stack.mjs';

let stack, admin, sql;
before(async () => {
  stack = await startStack({ env: { SETUP_CHECK_HOURS: '0' } });
  admin = await stack.adminSession();
  sql = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  const audit = sql.prepare('INSERT INTO audit_log(vmid,action,detail,ip,created_at) VALUES(?,?,?,?,?)');
  const operation = sql.prepare("INSERT INTO compute_operations(id,customer_id,user_id,vmid,kind,state,plan,credentials,request_hash) VALUES(?,1,1,?,'create',?,?,?,?)");
  const backup = sql.prepare("INSERT INTO compute_backup_reservations(job_id,customer_id,vmid,node,storage,storage_key,reserved_bytes,state) VALUES(?,1,?,'pve1','pbs','pbs',?,'held')");
  sql.exec('BEGIN');
  for (let i = 1; i <= 237; i++) {
    audit.run(i, 'power_start', JSON.stringify({ hostname: `history-${i}` }), '192.0.2.1', '2026-01-01 00:00:00');
    operation.run(`operation-${String(i).padStart(3, '0')}`, i, i % 2 ? 'complete' : 'review', JSON.stringify({ node: 'pve1', storage: 'fast', secret: 'plan-secret' }), 'credential-secret', 'hash-secret');
    backup.run(i, i, i * 2 ** 30);
  }
  sql.exec('COMMIT');
});
after(async () => { sql?.close(); await stack?.stop(); });

test('activity pages the full history, sorts numeric VMIDs, searches friendly actions and filters before counting', async () => {
  const request = q => admin.get(`/api/admin/audit?paginated=1&${q}`);
  const first = await request('pageSize=25&sort=server&order=asc&filter_what=Started%20server');
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.total, 237); assert.equal(first.json.pages, 10);
  assert.deepEqual(first.json.items.map(r => r.vmid), Array.from({ length: 25 }, (_, i) => i + 1));
  const last = await request('page=999&pageSize=25&sort=server&order=asc&filter_what=Started%20server');
  assert.equal(last.json.page, 10); assert.equal(last.json.items.length, 12);
  assert.equal(last.json.items.at(-1).vmid, 237);
  const search = await request('q=history-237');
  assert.equal(search.json.total, 1); assert.equal(search.json.items[0].vmid, 237);
  const literal = await request('q=%25'); assert.equal(literal.json.total, 0, 'percent is literal, not a wildcard');
  const none = await request('q=no-such-event&page=100');
  assert.deepEqual([none.json.total, none.json.pages, none.json.page, none.json.items.length], [0, 1, 1, 0]);
  assert.ok(Array.isArray((await admin.get('/api/admin/audit?limit=5')).json), 'legacy array response');
});

test('compute inventories reach records beyond 200 with safe projections and independent filters', async () => {
  const operations = await admin.get('/api/admin/compute-operations?paginated=1&page=3&pageSize=100&sort=vm&order=asc');
  assert.equal(operations.status, 200, operations.text);
  assert.equal(operations.json.total, 237); assert.equal(operations.json.items.length, 37);
  assert.equal(operations.json.items[0].vmid, 201);
  assert.doesNotMatch(JSON.stringify(operations.json), /secret|credentials|request_hash|"plan"/);
  const filtered = await admin.get('/api/admin/compute-operations?paginated=1&filter_state=review&filter_placement=pve1');
  assert.equal(filtered.json.total, 118);
  const backups = await admin.get('/api/admin/compute-backup-reservations?paginated=1&page=3&pageSize=100&sort=reserved&order=asc');
  assert.equal(backups.json.total, 237); assert.equal(backups.json.items[0].job_id, 201);
  assert.equal((await admin.get('/api/admin/compute-operations')).json.operations.length, 200);
  assert.equal((await admin.get('/api/admin/compute-backup-reservations')).json.reservations.length, 200);
});

test('table parameters are validated and inventories remain admin-only', async () => {
  for (const path of ['audit', 'compute-operations', 'compute-backup-reservations']) {
    for (const query of ['page=0', 'page=1.5', 'pageSize=101', 'pageSize=-1', 'sort=credentials', 'order=DROP', 'filter_secret=x', 'q=' + 'x'.repeat(201), 'q=a&q=b']) {
      const r = await admin.get(`/api/admin/${path}?paginated=1&${query}`);
      assert.equal(r.status, 400, `${path} ${query}: ${r.text}`);
    }
    assert.equal((await stack.admin().get(`/api/admin/${path}?paginated=1`)).status, 401);
    assert.equal((await stack.customer().get(`/api/admin/${path}?paginated=1`)).status, 404);
  }
});
