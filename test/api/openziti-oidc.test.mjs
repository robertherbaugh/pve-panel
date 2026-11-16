import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startStack } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';
import { startMockZiti } from '../support/mock-openziti.mjs';

let stack, oidc, ziti, admin, sql, customer, operator, reader, serviceId;
const rule = (id, patch) => ({
  id,
  customerId: customer.id,
  name: id,
  enabled: true,
  groups: [],
  entitlements: [],
  match: 'any',
  pools: ['tacid-dev'],
  tags: [],
  vmids: [],
  actions: ['view', 'private-access.read'],
  ...patch,
});
const rules = () => [
  rule('operators', {
    groups: ['developers'],
    actions: ['view', 'private-access.read', 'private-access.manage'],
  }),
  rule('readers', { entitlements: ['vm:ssh'] }),
];
const savePolicy = async (value) => {
  const r = await admin.put('/api/admin/access-policy', {
    version: 1,
    enabled: true,
    allowedDomains: [],
    rules: value,
  });
  assert.equal(r.status, 200, r.text);
};
const login = async (email, claims) => {
  const s = stack.customer();
  const r = await oidc.login(s, { email, ...claims });
  assert.equal(r.status, 200, r.text);
  assert.equal(
    (await s.post('/api/customers/select', { customerId: customer.id })).status,
    200,
  );
  return s;
};
before(async () => {
  oidc = await startMockOidc();
  ziti = await startMockZiti();
  stack = await startStack({
    env: {
      OPENZITI_TEST_MODE: 'true',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER: oidc.issuer,
      OIDC_CLIENT_ID: 'panel-test',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_INSECURE_HTTP: 'true',
      OIDC_AUTO_CREATE: 'true',
      SIGNIN_RATE_LIMIT: '100',
      SETUP_CHECK_HOURS: '0',
      VPN_ENABLED: 'false',
      CUSTOMER_NETWORKS: 'false',
      TAILSCALE_ENABLED: 'false',
    },
  });
  admin = await stack.adminSession();
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  stack.mock.vms.get(101).pool = 'tacid-dev';
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
  const created = await admin.post('/api/admin/customers', {
    name: 'Tactical ID',
    slug: 'tactical-id',
    enabled: true,
    pools: ['tacid-dev'],
    allowedDomains: [],
    sso: {
      groups: ['members'],
      entitlements: [],
      match: 'any',
      required: true,
    },
    limits: { servers: 0, cores: 0, memoryMb: 0, diskGb: 0 },
  });
  assert.equal(created.status, 201, created.text);
  customer = created.json;
  await savePolicy(rules());
  const s = (await admin.get('/api/admin/private-access')).json.openziti
    .settings;
  const cfg = {
    revision: s.revision,
    enabled: false,
    controller: ziti.url,
    username: 'panel-admin',
    password: ziti.secret,
    routerRole: 'rcadea-customers',
    caPem: '',
  };
  assert.equal(
    (await admin.put('/api/admin/private-access/openziti', cfg)).status,
    200,
  );
  assert.equal(
    (await admin.post('/api/admin/private-access/openziti/check')).status,
    200,
  );
  delete cfg.password;
  cfg.revision++;
  cfg.enabled = true;
  assert.equal(
    (await admin.put('/api/admin/private-access/openziti', cfg)).status,
    200,
  );
  operator = await login('operator@rcadea.cloud', {
    groups: ['members', 'developers'],
  });
  reader = await login('reader@rcadea.cloud', {
    groups: ['members'],
    entitlements: ['vm:ssh'],
  });
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await ziti?.close();
  await oidc?.close();
});

test('an OIDC access lease cannot fall back to a manual personal membership after claim expiry', async () => {
  const owner = await stack.customerWith('legacy-oidc@example.com');
  assert.equal(
    (await admin.put('/api/admin/vms/102', { userId: owner.userId })).status,
    200,
  );
  const session = stack.customer();
  assert.equal(
    (await oidc.login(session, { email: 'legacy-oidc@example.com' })).status,
    200,
  );
  const created = await session.post('/api/vms/102/private-access/services', {
    kind: 'ssh',
  });
  assert.equal(created.status, 200, created.text);
  const issued = await session.post(
    `/api/private-access/services/${created.json.id}/access`,
  );
  assert.equal(issued.status, 200, issued.text);
  sql
    .prepare('UPDATE oidc_authorizations SET expires_at=0 WHERE user_id=?')
    .run(owner.userId);
  assert.equal(
    (await session.post(`/api/private-access/grants/${issued.json.id}/renew`))
      .status,
    403,
  );
  await admin.post('/api/admin/private-access/openziti/reconcile');
  assert.equal(
    sql.prepare('SELECT * FROM openziti_grants WHERE id=?').get(issued.json.id),
    undefined,
  );
  assert.equal(
    (await owner.del(`/api/private-access/services/${created.json.id}`)).status,
    200,
  );
});

test('validated groups can manage an unassigned pool VM; entitlements grant only explicit read access', async () => {
  assert.equal(
    sql.prepare('SELECT * FROM vms WHERE vmid=101').get(),
    undefined,
  );
  const created = await operator.post('/api/vms/101/private-access/services', {
    kind: 'ssh',
  });
  assert.equal(created.status, 200, created.text);
  serviceId = created.json.id;
  assert.equal((await reader.get('/api/vms/101/private-access')).status, 200);
  assert.equal(
    (await reader.post('/api/vms/101/private-access/services', { kind: 'rdp' }))
      .status,
    404,
  );
  assert.equal(
    (
      await reader.post(
        `/api/private-access/services/${serviceId}/host-enrollment`,
      )
    ).status,
    404,
  );
  const outsider = await login('unmapped@rcadea.cloud', {
    groups: ['members'],
  });
  assert.equal(
    (await outsider.post(`/api/private-access/services/${serviceId}/access`))
      .status,
    404,
  );
  assert.equal((await reader.get('/api/vms/102/private-access')).status, 404);
  const issued = await reader.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(issued.status, 200, issued.text);
  const auth = sql
    .prepare('SELECT expires_at FROM oidc_authorizations WHERE user_id=?')
    .get((await reader.get('/api/auth/me')).json.id);
  assert(issued.json.accessExpiresAt <= auth.expires_at);
  await reader.del(`/api/private-access/grants/${issued.json.id}`);
});

test('expired claims and removed entitlements revoke controller access; password login cannot borrow claims', async () => {
  const issued = await reader.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(issued.status, 200, issued.text);
  const uid = (await reader.get('/api/auth/me')).json.id;
  sql
    .prepare('UPDATE oidc_authorizations SET expires_at=0 WHERE user_id=?')
    .run(uid);
  assert(
    [403, 404].includes(
      (await reader.post(`/api/private-access/grants/${issued.json.id}/renew`))
        .status,
    ),
  );
  await admin.post('/api/admin/private-access/openziti/reconcile');
  assert.equal(
    sql.prepare('SELECT * FROM openziti_grants WHERE id=?').get(issued.json.id),
    undefined,
  );
  reader = await login('reader@rcadea.cloud', {
    groups: ['members'],
    entitlements: ['vm:ssh'],
  });
  const next = await reader.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(next.status, 200, next.text);
  await savePolicy([rules()[0]]);
  assert.equal((await reader.get('/api/vms/101/private-access')).status, 404);
  await admin.post('/api/admin/private-access/openziti/reconcile');
  assert.equal(
    sql.prepare('SELECT * FROM openziti_grants WHERE id=?').get(next.json.id),
    undefined,
  );
  await admin.patch(`/api/admin/users/${uid}`, {
    password: 'a-local-password-for-testing',
  });
  const password = stack.customer();
  assert.equal(
    (
      await password.post('/api/auth/login', {
        email: 'reader@rcadea.cloud',
        password: 'a-local-password-for-testing',
      })
    ).status,
    200,
  );
  assert(
    [403, 404].includes(
      (await password.get('/api/vms/101/private-access')).status,
    ),
  );
  await operator.del(`/api/private-access/services/${serviceId}`);
});
