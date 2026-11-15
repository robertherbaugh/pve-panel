import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startStack } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';
let stack, oidc, admin, sql, a, b, dev, prod;
const body = (slug, pool) => ({
  name: slug,
  slug,
  enabled: true,
  pools: [pool],
  sso: { groups: ['team'], required: true },
  limits: { servers: 5 },
});
const rule = (c, pool) => ({
  id: c.slug,
  customerId: c.id,
  name: c.name,
  groups: ['team'],
  pools: [pool],
  actions: ['view', 'clone'],
  clone: {
    pool,
    templates: [9000],
    storages: ['VMStorage'],
    limits: { servers: 5, cores: 16, memoryMb: 32768, diskGb: 100 },
  },
});
const spec = {
  hostname: 'customer-network',
  templateId: 9000,
  username: 'ops',
  cores: 1,
  memoryMb: 1024,
  diskGb: 4,
  sshKeys: 'ssh-ed25519 AAAA-test',
};
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
      SETUP_CHECK_HOURS: '0',
      EXPIRY_CHECK_SECONDS: '0',
    },
  });
  admin = await stack.adminSession();
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  await stack.offerTemplates();
  dev = (await admin.post('/api/admin/customers', body('development', 'team-dev'))).json;
  prod = (await admin.post('/api/admin/customers', body('production', 'team-prod'))).json;
  for (const c of [dev, prod]) stack.mock.perms[`/pool/${c.pools[0]}`] = ['Pool.Audit'];
  assert.equal(
    (
      await admin.put('/api/admin/access-policy', {
        version: 1,
        enabled: true,
        allowedDomains: [],
        rules: [rule(dev, 'team-dev'), rule(prod, 'team-prod')],
      })
    ).status,
    200,
  );
  a = stack.customer();
  b = stack.customer();
  await oidc.login(a, { email: 'creator-a@rcadea.cloud', groups: ['team'] });
  await oidc.login(b, { email: 'creator-b@rcadea.cloud', groups: ['team'] });
  for (const s of [a, b]) {
    s.userId = (await s.get('/api/auth/me')).json.id;
    for (const c of [dev, prod])
      await admin.put(`/api/admin/customers/${c.id}/members`, { userId: s.userId, role: 'operator' });
    await s.post('/api/customers/select', { customerId: dev.id });
  }
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await oidc?.close();
});
test(
  'shared networking and VPN devices belong to the customer, across creators and customer switching',
  { timeout: 90000 },
  async () => {
    for (const s of [a, b]) {
      const r = await s.post('/api/vms', spec);
      assert.equal(r.status, 202, r.text);
      assert.equal((await stack.serverSettled(s, r.json.vmid)).state, 'ready');
    }
    const aInfo = (await a.get('/api/account')).json,
      bInfo = (await b.get('/api/account')).json;
    assert.equal(aInfo.network.vnet, bInfo.network.vnet);
    assert.equal(aInfo.network.subnet, bInfo.network.subnet);
    assert.equal(sql.prepare('SELECT count(*) n FROM networks WHERE customer_id=?').get(dev.id).n, 1);
    const device = await a.post('/api/vpn/devices', { name: 'Team laptop' });
    assert.equal(device.status, 201, 'operator can add a device');
    const devices = (await b.get('/api/vpn')).json.devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'Team laptop');
    const saved = sql.prepare('SELECT user_id,customer_id FROM vpn_devices WHERE id=?').get(devices[0].id);
    assert.equal(saved.user_id, a.userId);
    assert.equal(saved.customer_id, dev.id);
    await a.post('/api/customers/select', { customerId: prod.id });
    assert.deepEqual((await a.get('/api/vpn')).json.devices, []);
    assert.equal((await a.del(`/api/vpn/devices/${devices[0].id}`)).status, 404);
    const created = await a.post('/api/vms', spec);
    assert.equal(created.status, 202, created.text);
    assert.equal((await stack.serverSettled(a, created.json.vmid)).state, 'ready');
    const second = (await a.get('/api/account')).json.network;
    assert.notEqual(second.vnet, aInfo.network.vnet, 'one creator has distinct networks for two customers');
    assert.equal((await a.get('/api/vpn')).json.devices.length, 0);
    assert.equal(
      (await b.del(`/api/vpn/devices/${devices[0].id}`)).status,
      204,
      'another operator can remove the customer device',
    );
    await admin.del(`/api/admin/customers/${dev.id}/members/${a.userId}`);
    assert.equal(sql.prepare('SELECT count(*) n FROM networks WHERE customer_id=?').get(dev.id).n, 1);
    assert.equal(
      (await b.get('/api/vms')).json.length,
      2,
      'removing the original network creator preserves customer VMs',
    );
  },
);
