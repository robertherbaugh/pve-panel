import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startStack } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';
import { migrateTenancy } from '../../src/tenancy-migration.js';

let stack, oidc, admin, sql, user;
const body = (slug, pools = []) => ({
  name: slug, slug, pools, enabled: true,
  sso: { groups: ['developers'], required: false },
});
async function create(slug, pools = []) {
  const res = await admin.post('/api/admin/customers', body(slug, pools));
  assert.equal(res.status, 201, res.text);
  return res.json;
}
const remove = (c) => admin.req('DELETE', `/api/admin/customers/${c.id}`, { revision: c.revision });
before(async () => {
  oidc = await startMockOidc();
  stack = await startStack({ env: {
    CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false', SETUP_CHECK_HOURS: '0',
    OIDC_ENABLED: 'true', OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: 'panel-test',
    OIDC_CLIENT_SECRET: 'secret', OIDC_ALLOW_INSECURE_HTTP: 'true', OIDC_AUTO_CREATE: 'true',
  } });
  admin = await stack.adminSession();
  user = (await admin.post('/api/admin/users', {
    email: 'delete-member@rcadea.cloud', password: 'customer-delete-password', createPersonalCustomer: false,
  })).json;
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  sql.exec('PRAGMA foreign_keys=ON');
});
after(async () => { sql?.close(); await stack?.stop(); await oidc?.close(); });

test('only platform administrators can preview or delete customers', async () => {
  const c = await create('authorization');
  assert.equal((await stack.admin().get(`/api/admin/customers/${c.id}/deletion`)).status, 401);
  assert.equal((await stack.admin().req('DELETE', `/api/admin/customers/${c.id}`, { revision: 1 })).status, 401);
  const session = stack.customer();
  await session.post('/api/auth/login', { email: user.email, password: 'customer-delete-password' });
  await admin.put(`/api/admin/customers/${c.id}/members`, { userId: user.id, role: 'admin' });
  assert.equal((await session.get(`/api/admin/customers/${c.id}/deletion`)).status, 404);
  assert.equal((await session.req('DELETE', `/api/admin/customers/${c.id}`, { revision: 1 })).status, 404);
  const borrowed = stack.admin();
  borrowed.cookies = new Map(session.cookies);
  assert.equal((await borrowed.req('DELETE', `/api/admin/customers/${c.id}`, { revision: 1 })).status, 401);
  assert.equal((await remove(c)).status, 204);
});

test('deletion revokes memberships and only its rules, preserves history and guests, and cannot reuse customer identity', async () => {
  stack.mock.vms.get(101).pool = 'deletion-pool';
  stack.mock.perms['/pool/deletion-pool'] = ['Pool.Audit'];
  const c = await create('departing', ['deletion-pool']);
  const other = await create('retained', ['other-pool']);
  const rule = (customer, id, enabled = true) => ({
    id, name: id, customerId: customer.id, enabled, groups: ['developers'], entitlements: [],
    match: 'any', pools: customer.pools, tags: [], vmids: [], actions: ['view'],
  });
  const rules = [rule(c, 'departing-view'), rule(c, 'departing-disabled', false), rule(other, 'retained-view')];
  const policy = await admin.put('/api/admin/access-policy', { version: 1, enabled: true, allowedDomains: [], rules });
  assert.equal(policy.status, 200, policy.text);
  await admin.put(`/api/admin/customers/${c.id}/members`, { userId: user.id, role: 'viewer' });
  const sso = stack.customer(), claims = { email: 'mapped-delete@rcadea.cloud', groups: ['developers'] };
  assert.equal((await oidc.login(sso, claims)).status, 200);
  assert.equal((await sso.post('/api/customers/select', { customerId: c.id })).status, 200);
  assert.equal((await sso.get('/api/vms/101')).status, 200);
  const actor = (await sso.get('/api/auth/me')).json.id;
  sql.prepare('INSERT INTO customer_membership_blocks(customer_id,user_id) VALUES(?,?)').run(c.id, 1);
  sql.prepare("INSERT INTO tasks(upid,user_id,vmid,node,action,customer_id) VALUES('historic-task',?,101,'pve1','power_start',?)").run(actor, c.id);
  sql.prepare("INSERT INTO backup_jobs(vmid,user_id,action,state,customer_id) VALUES(101,?,'backup','done',?)").run(actor, c.id);
  sql.prepare("INSERT INTO audit_log(user_id,action,customer_id) VALUES(?,'historical',?)").run(actor, c.id);
  const preview = (await admin.get(`/api/admin/customers/${c.id}/deletion`)).json;
  assert.equal(preview.members, 2);
  assert.equal(preview.rules.length, 2);
  assert.deepEqual(preview.blockers, []);
  assert.equal((await remove(c)).status, 204);
  assert.equal((await admin.get('/api/admin/customers')).json.customers.some((x) => x.id === c.id), false);
  assert.equal((await admin.get(`/api/admin/customers/${c.id}/members`)).status, 404);
  assert.equal((await admin.get(`/api/admin/customers/${c.id}/deletion`)).status, 404);
  assert.equal((await admin.put(`/api/admin/customers/${c.id}`, { ...body(c.slug), revision: c.revision })).status, 404);
  assert.equal((await remove(c)).status, 404);
  assert.equal((await sso.get('/api/customers')).json.selectedCustomerId, null);
  assert.equal((await sso.get('/api/vms/101')).status, 404);
  assert.equal((await sso.post('/api/customers/select', { customerId: c.id })).status, 404);
  assert.equal(sql.prepare('SELECT count(*) n FROM customer_memberships WHERE customer_id=?').get(c.id).n, 0);
  assert.equal(sql.prepare('SELECT count(*) n FROM customer_membership_blocks WHERE customer_id=?').get(c.id).n, 0);
  const tombstone = sql.prepare('SELECT * FROM customers WHERE id=?').get(c.id);
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.enabled, 0);
  assert.equal(tombstone.pools, '[]');
  assert.equal(tombstone.sso_groups, '[]');
  assert.equal(sql.prepare("SELECT customer_id FROM tasks WHERE upid='historic-task'").get().customer_id, c.id);
  assert.equal(sql.prepare('SELECT state FROM backup_jobs WHERE customer_id=?').get(c.id).state, 'done');
  const deletion = sql.prepare("SELECT * FROM audit_log WHERE action='admin_customer_delete' AND customer_id=?").get(c.id);
  assert.equal(JSON.parse(deletion.detail).slug, c.slug);
  assert.ok(sql.prepare("SELECT 1 FROM audit_log WHERE action='historical' AND customer_id=?").get(c.id));
  assert.equal((await admin.get('/api/admin/access-policy')).json.policy.rules.length, 1);
  assert.equal((await admin.get('/api/admin/access-policy')).json.policy.rules[0].id, 'retained-view');
  assert.equal(stack.mock.vms.get(101).pool, 'deletion-pool');
  assert.ok(sql.prepare('SELECT id FROM users WHERE id=?').get(user.id));
  const stalePolicy = await admin.req('PUT', '/api/admin/access-policy', policy.json.policy);
  assert.equal(stalePolicy.status, 400, 'a stale editor cannot restore grants for the deleted customer');
  const replacement = await create(c.slug, c.pools);
  assert.notEqual(replacement.id, c.id);
  // Even if a replacement maps the same claims, the old selected customer is invalid.
  assert.equal((await sso.get('/api/vms/101')).status, 404);
  const fresh = stack.customer();
  assert.equal((await oidc.login(fresh, claims)).status, 200);
  assert.equal((await fresh.get('/api/customers')).json.customers.some((x) => x.id === c.id), false);
  assert.equal((await fresh.get('/api/customers')).json.customers.some((x) => x.id === replacement.id), true);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('live resources and unfinished jobs block deletion without changing memberships or policy', async () => {
  const c = await create('resource-checks');
  await admin.put(`/api/admin/customers/${c.id}/members`, { userId: user.id, role: 'operator' });
  const base = [user.id, c.id];
  const cases = [
    ['Assigned VMs', 'vms', 'INSERT INTO vms(vmid,user_id,customer_id) VALUES(700,?,?)'],
    ['Private networks', 'networks', "INSERT INTO networks(vnet,idx,user_id,customer_id) VALUES('delete-net',77,?,?)"],
    ['VPN devices', 'vpn_devices', "INSERT INTO vpn_devices(name,public_key,host,user_id,customer_id) VALUES('device','delete-pubkey',2,?,?)"],
    ['Backups', 'backups', "INSERT INTO backups(volid,vmid,storage,kind,user_id,customer_id) VALUES('delete-backup',700,'pbs','manual',?,?)"],
    ['Backup or restore jobs', 'backup_jobs', "INSERT INTO backup_jobs(vmid,action,state,user_id,customer_id) VALUES(700,'backup','queued',?,?)"],
    ['Backup or restore jobs', 'backup_jobs', "INSERT INTO backup_jobs(vmid,action,state,user_id,customer_id) VALUES(700,'restore','running',?,?)"],
  ];
  // These rows refer to a VM assigned to another customer, as can happen with retained history after transfer.
  const owner = await create('different-owner');
  sql.prepare('INSERT INTO vms(vmid,user_id,customer_id) VALUES(701,?,?)').run(user.id, owner.id);
  cases.push(
    ['Tailscale connections', 'tailscale', "INSERT INTO tailscale(vmid,mode,state,user_id,customer_id) VALUES(701,'server','connected',?,?)"],
    ['Backup schedules', 'backup_schedules', "INSERT INTO backup_schedules(vmid,frequency,hour,minute,keep,next_run_at,user_id,customer_id) VALUES(701,'daily',1,0,2,'2099-01-01',?,?)"],
    ['Windows update jobs', 'winupdates', "INSERT INTO winupdates(vmid,run_id,scope,state,user_id,customer_id) VALUES(701,'delete-run','all','installing',?,?)"],
  );
  for (const [label, table, insert] of cases) {
    sql.prepare(insert).run(...base);
    const before = (await admin.get('/api/admin/access-policy')).json;
    assert.ok((await admin.get(`/api/admin/customers/${c.id}/deletion`)).json.blockers.some((b) => b.label === label), label);
    const res = await remove(c);
    assert.equal(res.status, 409, res.text);
    assert.ok(res.json.error.includes(label), res.text);
    assert.equal(sql.prepare('SELECT deleted_at FROM customers WHERE id=?').get(c.id).deleted_at, null);
    assert.equal((await admin.get(`/api/admin/customers/${c.id}/members`)).json.members.length, 1);
    assert.deepEqual((await admin.get('/api/admin/access-policy')).json, before);
    sql.prepare(`DELETE FROM ${table} WHERE customer_id=?`).run(c.id);
  }
  assert.equal((await remove(c)).status, 204);
});

test('deletion checks a fresh revision and rechecks resources after preview', async () => {
  const c = await create('concurrent-delete');
  assert.equal((await admin.del(`/api/admin/customers/${c.id}`)).status, 400);
  const updated = await admin.put(`/api/admin/customers/${c.id}`, { ...body(c.slug), name: 'Changed name', revision: c.revision });
  assert.equal(updated.status, 200);
  assert.equal((await remove(c)).status, 409);
  assert.deepEqual((await admin.get(`/api/admin/customers/${c.id}/deletion`)).json.blockers, []);
  sql.prepare("INSERT INTO backups(volid,vmid,storage,kind,user_id,customer_id) VALUES('racing-backup',702,'pbs','manual',?,?)").run(user.id, c.id);
  assert.equal((await remove(updated.json)).status, 409);
  sql.prepare("DELETE FROM backups WHERE volid='racing-backup'").run();
  assert.equal((await remove(updated.json)).status, 204);
});

test('a failed deletion rolls back customer, policy and membership changes together', async () => {
  const c = await create('atomic-delete', ['atomic-pool']);
  await admin.put(`/api/admin/customers/${c.id}/members`, { userId: user.id, role: 'viewer' });
  const policy = (await admin.get('/api/admin/access-policy')).json.policy;
  policy.rules.push({
    id: 'atomic-view', name: 'Atomic view', customerId: c.id, groups: ['developers'],
    pools: c.pools, actions: ['view'],
  });
  assert.equal((await admin.put('/api/admin/access-policy', policy)).status, 200);
  const before = (await admin.get('/api/admin/access-policy')).json;
  sql.exec(`CREATE TRIGGER fail_customer_delete_audit BEFORE INSERT ON audit_log
    WHEN NEW.action='admin_customer_delete' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;`);
  try {
    assert.equal((await remove(c)).status, 500);
    assert.equal(sql.prepare('SELECT deleted_at FROM customers WHERE id=?').get(c.id).deleted_at, null);
    assert.equal(sql.prepare('SELECT slug FROM customers WHERE id=?').get(c.id).slug, c.slug);
    assert.equal((await admin.get(`/api/admin/customers/${c.id}/members`)).json.members.length, 1);
    assert.deepEqual((await admin.get('/api/admin/access-policy')).json, before);
  } finally {
    sql.exec('DROP TRIGGER fail_customer_delete_audit');
  }
  assert.equal((await remove(c)).status, 204);
});

test('deleted personal customers stay deleted after sign-in and an idempotent migration', async () => {
  const personalUser = await stack.customerWith('personal-delete@rcadea.cloud');
  const c = (await admin.get('/api/admin/customers')).json.customers.find((c) => c.legacy_user_id === personalUser.userId);
  assert.ok(c);
  assert.equal((await remove(c)).status, 204);
  migrateTenancy(sql);
  assert.equal((await personalUser.post('/api/auth/login', { email: 'personal-delete@rcadea.cloud', password: 'another-long-password' })).status, 200);
  assert.deepEqual((await personalUser.get('/api/customers')).json.customers, []);
  assert.equal((await admin.get('/api/admin/customers')).json.customers.some((x) => x.legacy_user_id === personalUser.userId), false);
  assert.equal(sql.prepare('SELECT count(*) n FROM customers WHERE legacy_user_id=?').get(personalUser.userId).n, 1);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});
