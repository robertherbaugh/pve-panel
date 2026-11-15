import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { once } from 'node:events';
import { startStack, waitFor, sleep } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';
let stack, oidc, admin, sql, dev, prod, alice, bob, eve;
const customer = (name, slug, pools, patch = {}) => ({
  name,
  slug,
  enabled: true,
  pools,
  allowedDomains: [],
  sso: { groups: [], entitlements: [], match: 'any', required: false },
  limits: { servers: 0, cores: 0, memoryMb: 0, diskGb: 0 },
  ...patch,
});
async function create(input) {
  const r = await admin.post('/api/admin/customers', input);
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function user(email) {
  const r = await admin.post('/api/admin/users', {
    email,
    password: 'customer-test-password',
    createPersonalCustomer: false,
  });
  assert.equal(r.status, 201, r.text);
  const s = stack.customer();
  s.userId = r.json.id;
  assert.equal((await s.post('/api/auth/login', { email, password: 'customer-test-password' })).status, 200);
  return s;
}
async function member(c, u, role) {
  const r = await admin.put(`/api/admin/customers/${c.id}/members`, { userId: u.userId, role });
  assert.equal(r.status, 200, r.text);
}
async function select(s, c) {
  const r = await s.post('/api/customers/select', { customerId: c.id });
  assert.equal(r.status, 200, r.text);
}
async function update(c, patch) {
  const body = {
    ...customer(c.name, c.slug, c.pools),
    allowedDomains: c.allowedDomains,
    sso: c.sso,
    limits: c.limits,
    expiry: c.expiry,
    maxBackups: c.maxBackups,
    revision: c.revision,
    ...patch,
  };
  const r = await admin.put(`/api/admin/customers/${c.id}`, body);
  assert.equal(r.status, 200, r.text);
  Object.assign(c, r.json);
  return r;
}
function connect(s, id) {
  return new WebSocket(`${stack.customerUrl.replace('http:', 'ws:')}/api/console/${id}`, {
    headers: { Cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
}
async function closeWithin(ws) {
  return Promise.race([
    once(ws, 'close'),
    sleep(8000).then(() => {
      throw new Error('Console survived revocation');
    }),
  ]);
}
before(async () => {
  oidc = await startMockOidc();
  stack = await startStack({
    env: {
      OIDC_ENABLED: 'true',
      OIDC_ISSUER: oidc.issuer,
      OIDC_CLIENT_ID: 'panel-test',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      OIDC_AUTO_CREATE: 'true',
      SIGNIN_RATE_LIMIT: '200',
      SETUP_CHECK_HOURS: '0',
      EXPIRY_CHECK_SECONDS: '0',
      CUSTOMER_NETWORKS: 'false',
      VPN_ENABLED: 'false',
    },
  });
  admin = await stack.adminSession();
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  for (const [id, pool] of [
    [101, 'tenant-dev'],
    [102, 'tenant-prod'],
  ]) {
    stack.mock.vms.get(id).pool = pool;
    stack.mock.perms[`/pool/${pool}`] = ['Pool.Audit'];
  }
  dev = await create(customer('Development', 'development', ['tenant-dev']));
  prod = await create(customer('Production', 'production', ['tenant-prod']));
  alice = await user('alice@rcadea.cloud');
  bob = await user('bob@rcadea.cloud');
  eve = await user('eve@rcadea.cloud');
  await member(dev, alice, 'admin');
  await member(prod, alice, 'viewer');
  await member(dev, bob, 'operator');
  await member(prod, eve, 'admin');
  assert.equal((await admin.put('/api/admin/vms/101', { customerId: dev.id })).status, 200);
  assert.equal((await admin.put('/api/admin/vms/102', { customerId: prod.id })).status, 200);
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await oidc?.close();
});

test(
  'multiple members share customer VMs and multiple customer memberships require an explicit context',
  { timeout: 40000 },
  async () => {
    await select(alice, dev);
    await select(bob, dev);
    await select(eve, prod);
    assert.deepEqual(
      (await alice.get('/api/vms')).json.map((v) => v.vmid),
      [101],
    );
    assert.deepEqual(
      (await bob.get('/api/vms')).json.map((v) => v.vmid),
      [101],
    );
    assert.equal((await bob.get('/api/vms/102')).status, 404);
    assert.equal((await eve.get('/api/vms/101')).status, 404);
    assert.equal((await bob.get('/api/customer/members')).status, 403);
    assert.equal((await bob.post('/api/vms/101/power/start')).status, 200);
    assert.equal((await alice.post('/api/customers/select', { customerId: 999999 })).status, 404);
    await select(alice, prod);
    assert.deepEqual(
      (await alice.get('/api/vms')).json.map((v) => v.vmid),
      [102],
    );
    assert.equal((await alice.post('/api/vms/102/power/start')).status, 404);
    assert.equal((await alice.get('/api/vms/101')).status, 404);
    assert.equal((await alice.get('/api/account')).json.personalCreation, undefined);
    await select(alice, dev);
  },
);

test(
  'VM routes, backup guesses and task IDs remain inside the selected customer',
  { timeout: 40000 },
  async () => {
    const operation = await alice.post('/api/vms/101/power/start');
    assert.equal(operation.status, 200, operation.text);
    const task = encodeURIComponent(operation.json.task);
    assert.equal((await alice.get(`/api/tasks/${task}`)).status, 200);
    assert.equal(
      (await bob.get(`/api/tasks/${task}`)).status,
      404,
      'same customer does not disclose another actor’s task',
    );
    await select(alice, prod);
    assert.equal((await alice.get(`/api/tasks/${task}`)).status, 404);
    for (const path of [
      '/api/vms/101',
      '/api/vms/101/backups',
      '/api/vms/101/snapshots',
      '/api/vms/101/tailscale',
      '/api/vms/101/updates',
    ])
      assert.equal((await alice.get(path)).status, 404, path);
    assert.equal((await alice.post('/api/vms/101/console')).status, 404);
    assert.equal((await alice.post('/api/vms/101/resize', { cores: 3 })).status, 404);
    await select(alice, dev);
  },
);

test(
  'console tickets bind to the selected customer; manual shared consoles survive without an OIDC lease',
  { timeout: 40000 },
  async () => {
    await waitFor(async () => (await alice.get('/api/vms/101')).json.status === 'running');
    const ticket = await alice.post('/api/vms/101/console');
    assert.equal(ticket.status, 200, ticket.text);
    await select(alice, prod);
    const wrong = connect(alice, ticket.json.session);
    assert.equal((await once(wrong, 'close'))[0], 4001);
    await select(alice, dev);
    const next = await bob.post('/api/vms/101/console');
    assert.equal(next.status, 200, next.text);
    const ws = connect(bob, next.json.session);
    try {
      await once(ws, 'open');
      const response = once(ws, 'message');
      ws.send('probe');
      await response;
      await sleep(100);
      assert.equal(ws.readyState, WebSocket.OPEN);
      const closed = closeWithin(ws);
      await admin.del(`/api/admin/customers/${dev.id}/members/${bob.userId}`);
      await closed;
      assert.equal((await bob.get('/api/vms/101')).status, 404);
      assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=101').get().customer_id, dev.id);
    } finally {
      ws.terminate();
      await member(dev, bob, 'operator');
    }
  },
);

test(
  'customer administrators manage existing users without changing global roles or deleting shared resources',
  { timeout: 40000 },
  async () => {
    assert.equal((await alice.del(`/api/customer/members/${alice.userId}`)).status, 409, 'sole admin guard');
    assert.equal(
      (await alice.put('/api/customer/members', { email: 'eve@rcadea.cloud', role: 'viewer' })).status,
      200,
    );
    assert.equal(
      (await alice.put('/api/customer/members', { email: 'missing@rcadea.cloud', role: 'admin' })).status,
      404,
    );
    assert.equal(
      (await alice.put('/api/customer/members', { email: 'eve@rcadea.cloud', role: 'viewer', isAdmin: true }))
        .status,
      200,
    );
    await select(eve, dev);
    assert.equal((await eve.get('/api/vms/101')).status, 200);
    assert.equal((await eve.post('/api/vms/101/power/start')).status, 404);
    assert.equal((await alice.del(`/api/customer/members/${eve.userId}`)).status, 204);
    assert.equal((await eve.get('/api/vms/101')).status, 404);
    assert.equal(sql.prepare('SELECT is_admin FROM users WHERE id=?').get(eve.userId).is_admin, 0);
    assert.equal(sql.prepare('SELECT count(*) n FROM vms WHERE customer_id=?').get(dev.id).n, 1);
    await select(eve, prod);
  },
);

test(
  'customer boundaries and revisions reject overlapping pools and stale or out-of-bound policies',
  { timeout: 40000 },
  async () => {
    const duplicate = await admin.post(
      '/api/admin/customers',
      customer('Duplicate', 'duplicate', ['tenant-dev']),
    );
    assert.equal(duplicate.status, 409);
    const stale = { ...customer(dev.name, dev.slug, dev.pools), revision: dev.revision - 1 };
    assert.equal((await admin.put(`/api/admin/customers/${dev.id}`, stale)).status, 409);
    assert.equal((await admin.put('/api/admin/vms/102', { customerId: dev.id })).status, 400);
    const rule = {
      id: 'escape',
      customerId: dev.id,
      name: 'escape',
      groups: ['developers'],
      pools: ['tenant-prod'],
      actions: ['view'],
    };
    assert.equal(
      (
        await admin.put('/api/admin/access-policy', {
          version: 1,
          enabled: true,
          allowedDomains: [],
          rules: [rule],
        })
      ).status,
      400,
    );
    const tampered = stack.customer();
    tampered.cookies = new Map(alice.cookies);
    tampered.cookies.set('panel_customer', 'invalid');
    assert.equal((await tampered.get('/api/vms/101')).status, 404);
  },
);

test(
  'migrated personal plans respect a configured customer pool boundary',
  { timeout: 40000 },
  async () => {
    const legacy = await stack.customerWith('personal@rcadea.cloud', { limits: {} });
    const personal = (await admin.get('/api/admin/customers')).json.customers.find(
      (c) => c.legacy_user_id === legacy.userId,
    );
    assert.ok(personal);
    // An explicit assignment works before a pool boundary is configured.
    const assigned = sql.prepare('SELECT * FROM vms WHERE vmid=101').get();
    sql.prepare('UPDATE vms SET customer_id=? WHERE vmid=101').run(personal.id);
    try {
      assert.equal((await legacy.get('/api/vms/101')).status, 200);
      stack.mock.perms['/pool/personal-only'] = ['Pool.Audit'];
      await update(personal, { pools: ['personal-only'] });
      assert.equal((await legacy.get('/api/vms/101')).status, 404);
      assert.equal((await legacy.post('/api/vms/101/power/start')).status, 404);
      assert.equal((await legacy.get('/api/account')).json.canCreate, false);
    } finally {
      sql.prepare('UPDATE vms SET customer_id=?,assigned_at=? WHERE vmid=101').run(
        assigned.customer_id,
        assigned.assigned_at,
      );
    }
  },
);

test(
  'disabling a user or customer revokes access and open consoles while preserving shared VM records',
  { timeout: 40000 },
  async () => {
    const ticket = await bob.post('/api/vms/101/console');
    const ws = connect(bob, ticket.json.session);
    try {
      await once(ws, 'open');
      const response = once(ws, 'message');
      ws.send('probe');
      await response;
      await sleep(100);
      assert.equal(ws.readyState, WebSocket.OPEN);
      const closed = closeWithin(ws);
      assert.equal((await admin.post(`/api/admin/users/${bob.userId}/disable`)).status, 200);
      await closed;
      assert.equal((await bob.get('/api/vms')).status, 401);
      assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=101').get().customer_id, dev.id);
      assert.equal((await alice.get('/api/vms/101')).status, 200);
    } finally {
      ws.terminate();
      await admin.post(`/api/admin/users/${bob.userId}/enable`);
    }
    await update(dev, { enabled: false });
    assert.equal((await alice.get('/api/vms/101')).status, 404);
    assert.equal((await alice.get('/api/customers')).json.selectedCustomerId, null);
    await update(dev, { enabled: true });
  },
);

test(
  'domains filter mapped membership, never create it; manual membership can require fresh SSO',
  { timeout: 40000 },
  async () => {
    await update(dev, {
      allowedDomains: ['rcadea.cloud'],
      sso: { groups: ['developers'], entitlements: ['customer:dev'], match: 'all', required: true },
    });
    const r = {
      id: 'dev-view',
      customerId: dev.id,
      name: 'Development view',
      groups: ['developers'],
      entitlements: ['vm:operate'],
      match: 'all',
      pools: dev.pools,
      tags: [],
      vmids: [],
      actions: ['view', 'power'],
    };
    assert.equal(
      (
        await admin.put('/api/admin/access-policy', {
          version: 1,
          enabled: true,
          allowedDomains: [],
          rules: [r],
        })
      ).status,
      200,
    );
    assert.equal(
      (await alice.get('/api/vms/101')).status,
      404,
      'password session cannot satisfy SSO-required customer',
    );
    for (const claims of [
      { email: 'domain-only@rcadea.cloud' },
      { email: 'partial@rcadea.cloud', groups: ['developers'] },
      { email: 'outside@other.cloud', groups: ['developers'], entitlements: ['customer:dev', 'vm:operate'] },
    ]) {
      const s = stack.customer();
      await oidc.login(s, claims);
      assert.equal((await s.get('/api/customers')).json.customers.length, 0);
    }
    const s = stack.customer();
    const claims = {
      email: 'mapped@rcadea.cloud',
      groups: ['developers'],
      entitlements: ['customer:dev', 'vm:operate'],
    };
    assert.equal((await oidc.login(s, claims)).status, 200);
    assert.equal((await s.get('/api/vms/101')).status, 200);
    assert.equal((await s.post('/api/vms/101/power/start')).status, 200);
    const id = (await s.get('/api/auth/me')).json.id;
    assert.equal(
      sql.prepare('SELECT count(*) n FROM customers WHERE legacy_user_id=?').get(id).n,
      0,
      'new SSO identities do not get personal customers',
    );
    await admin.del(`/api/admin/customers/${dev.id}/members/${id}`);
    assert.equal((await s.get('/api/vms/101')).status, 404);
    const again = stack.customer();
    await oidc.login(again, claims);
    assert.equal((await again.get('/api/vms/101')).status, 404, 'fresh SSO cannot override explicit removal');
    await admin.put(`/api/admin/customers/${dev.id}/members`, { userId: id, role: 'member' });
    assert.equal((await again.get('/api/vms/101')).status, 200);
    sql.prepare('UPDATE oidc_authorizations SET expires_at=0 WHERE user_id=?').run(id);
    assert.equal((await again.get('/api/vms/101')).status, 404);
    await update(dev, {
      sso: { groups: [], entitlements: [], match: 'any', required: false },
      allowedDomains: [],
    });
  },
);

test(
  'backups keep customer ownership and the acting identity; a removed creator cannot take the backup away',
  { timeout: 40000 },
  async () => {
    await admin.put('/api/admin/settings/backups', { enabled: true, storage: 'pbs', maxPerServer: 3 });
    const r = await alice.post('/api/vms/101/backups');
    assert.equal(r.status, 202, r.text);
    const job = await waitFor(async () => {
      const j = (await alice.get('/api/vms/101/backups')).json.job;
      return j && ['done', 'failed'].includes(j.state) ? j : null;
    });
    assert.equal(job.state, 'done', job.error);
    const saved = sql.prepare('SELECT customer_id,user_id FROM backups WHERE volid=?').get(job.volid);
    assert.deepEqual({ ...saved }, { customer_id: dev.id, user_id: alice.userId });
    await member(dev, bob, 'admin');
    assert.equal(
      (await bob.get('/api/vms/101/backups')).json.backups.some((b) => b.id === job.volid),
      true,
    );
    assert.equal(
      (await eve.get(`/api/vms/102/backups/files?id=${encodeURIComponent(job.volid)}`)).status,
      404,
    );
    await admin.del(`/api/admin/customers/${dev.id}/members/${alice.userId}`);
    assert.equal(
      (await bob.get('/api/vms/101/backups')).json.backups.some((b) => b.id === job.volid),
      true,
    );
    await member(dev, alice, 'admin');
    await member(dev, bob, 'operator');
  },
);

test(
  'aggregate customer quotas apply across creators, including concurrent clones and pending restores',
  { timeout: 40000 },
  async () => {
    await update(dev, {
      sso: { groups: ['creators'], entitlements: [], match: 'any', required: true },
      limits: { servers: 2, cores: 8, memoryMb: 16384, diskGb: 100 },
    });
    await stack.offerTemplates();
    const r = {
      id: 'clone',
      customerId: dev.id,
      name: 'Clone',
      groups: ['creators'],
      entitlements: [],
      pools: dev.pools,
      tags: [],
      vmids: [],
      actions: ['view', 'clone', 'resize'],
      clone: {
        pool: 'tenant-dev',
        templates: [9000],
        storages: ['VMStorage'],
        limits: { servers: 5, cores: 16, memoryMb: 32768, diskGb: 200 },
      },
    };
    assert.equal(
      (
        await admin.put('/api/admin/access-policy', {
          version: 1,
          enabled: true,
          allowedDomains: [],
          rules: [r],
        })
      ).status,
      200,
    );
    const a = stack.customer(),
      b = stack.customer();
    await oidc.login(a, { email: 'creator-a@rcadea.cloud', groups: ['creators'] });
    await oidc.login(b, { email: 'creator-b@rcadea.cloud', groups: ['creators'] });
    const spec = {
      hostname: 'shared-capacity',
      templateId: 9000,
      username: 'ops',
      cores: 1,
      memoryMb: 1024,
      diskGb: 4,
      sshKeys: 'ssh-ed25519 AAAA-test',
    };
    const attempts = await Promise.all([a.post('/api/vms', spec), b.post('/api/vms', spec)]);
    assert.deepEqual(
      attempts.map((x) => x.status).sort(),
      [202, 409],
      attempts.map((x) => x.text).join('\n'),
    );
    const vmid = attempts.find((x) => x.status === 202).json.vmid,
      owner = attempts[0].status === 202 ? a : b,
      other = owner === a ? b : a;
    assert.equal((await stack.serverSettled(owner, vmid)).state, 'ready');
    assert.equal(
      (await other.post('/api/vms', spec)).status,
      409,
      'one server by each creator still exceeds aggregate cap',
    );
    const uid = (await owner.get('/api/auth/me')).json.id;
    assert.equal(
      (await admin.del(`/api/admin/users/${uid}`)).status,
      409,
      'legacy deletion cannot destroy organization resources',
    );
    assert.throws(() => sql.prepare('DELETE FROM users WHERE id=?').run(uid), /preserve customer resources/);
    await admin.post(`/api/admin/users/${uid}/disable`);
    assert.equal((await other.get(`/api/vms/${vmid}`)).status, 200, 'creator disable preserves team access');
    await admin.post(`/api/admin/users/${uid}/enable`);
    await oidc.login(owner, {
      email: owner === a ? 'creator-a@rcadea.cloud' : 'creator-b@rcadea.cloud',
      groups: ['creators'],
    });
    const row = sql.prepare('SELECT customer_id,user_id FROM vms WHERE vmid=?').get(vmid);
    assert.equal(row.customer_id, dev.id);
    assert.equal(row.user_id, uid);
    // Reserving a restore is durable and blocks another capacity mutation.
    sql
      .prepare(
        "INSERT INTO backup_jobs(vmid,user_id,customer_id,action,state) VALUES(?,?,?,'restore','queued')",
      )
      .run(vmid, uid, dev.id);
    assert.equal((await owner.post(`/api/vms/${vmid}/resize`, { cores: 2 })).status, 409);
    assert.equal(
      (await admin.put(`/api/admin/vms/${vmid}`, { customerId: prod.id })).status,
      409,
      'an active restore prevents reassignment',
    );
    sql.prepare("DELETE FROM backup_jobs WHERE vmid=? AND action='restore' AND state='queued'").run(vmid);
  },
);
