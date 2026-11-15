import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startStack, sleep } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';

let stack, oidc, admin;
const rule = (id, patch = {}) => ({ id, name: id, groups: ['operators'], pools: ['tacid-dev'], actions: ['view', 'power', 'console'], ...patch });
const policy = (rules, allowedDomains = []) => ({ version: 1, enabled: true, allowedDomains, rules });
const save = (rules, domains) => admin.put('/api/admin/access-policy', policy(rules, domains));
async function login(email, claims = {}) {
  const session = stack.customer();
  assert.equal((await oidc.login(session, { email, ...claims })).status, 200);
  return session;
}
before(async () => {
  oidc = await startMockOidc();
  stack = await startStack({ env: { OIDC_ENABLED: 'true', OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: 'panel-test', OIDC_CLIENT_SECRET: 'secret',
    OIDC_ALLOW_INSECURE_HTTP: 'true', OIDC_AUTO_CREATE: 'true', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false', SETUP_CHECK_HOURS: '0' } });
  admin = await stack.adminSession();
  stack.mock.vms.get(101).pool = 'tacid-dev';
  stack.mock.vms.get(102).pool = 'tacid-prod';
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
  stack.mock.perms['/pool/tacid-prod'] = ['Pool.Audit'];
});
after(async () => { await stack?.stop(); await oidc?.close(); });

test('optional domains trust validated claims, while configured domains and missing claims still restrict access', async () => {
  assert.equal((await save([rule('sso')])).status, 200);
  const user = await login('operator@rcadea.cloud', { groups: ['operators'] });
  assert.equal((await user.get('/api/vms/101')).status, 200);
  const noGroup = await login('unmapped@rcadea.cloud');
  assert.deepEqual((await noGroup.get('/api/vms')).json, []);
  await save([rule('sso')], ['tacticalid.io']);
  assert.equal((await user.get('/api/vms/101')).status, 404);
  await save([rule('sso', { groups: [], entitlements: ['operate'] })]);
  const entitled = await login('entitled@another.example', { entitlements: ['operate'] });
  assert.equal((await entitled.get('/api/vms/101')).status, 200);
  assert.equal((await stack.customer().get('/api/vms')).status, 401);
  assert.equal((await save([rule('invalid')], ['*.cloud'])).status, 400);
});

test('old rules default enabled; disabling one set revokes its operations and console without changing another set', async () => {
  const saved = await save([rule('development'), rule('production', { pools: ['tacid-prod'] })]);
  assert.equal(saved.json.policy.rules[0].enabled, true);
  const user = await login('toggle@rcadea.cloud', { groups: ['operators'] });
  await user.post('/api/vms/101/power/start');
  await sleep(5100); // guest inventory cache after the power transition
  const ticket = await user.post('/api/vms/101/console');
  assert.equal(ticket.status, 200, ticket.text);
  const ws = new WebSocket(`${stack.customerUrl.replace('http:', 'ws:')}/api/console/${ticket.json.session}`, {
    headers: { cookie: [...user.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  try {
    await once(ws, 'open');
    const closed = once(ws, 'close');
    await save([rule('development', { enabled: false }), rule('production', { pools: ['tacid-prod'] })]);
    assert.deepEqual((await user.get('/api/vms')).json.map((v) => v.vmid), [102]);
    assert.equal((await user.post('/api/vms/101/power/start')).status, 404);
    await Promise.race([closed, sleep(8000).then(() => { throw new Error('Disabled permission set left its console open'); })]);
  } finally { ws.terminate(); }
  assert.equal((await save([rule('invalid', { enabled: 'false' })])).status, 400);
  await stack.offerTemplates();
  const clone = rule('create', { enabled: false, actions: ['view', 'clone'], clone: { pool: 'tacid-dev', templates: [9000], storages: ['VMStorage'], limits: { servers: 1, cores: 2, memoryMb: 2048, diskGb: 20 } } });
  await save([clone]);
  assert.equal((await user.get('/api/account')).json.canCreate, false);
  assert.equal((await user.post('/api/vms', { hostname: 'blocked', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 4, sshKeys: 'ssh-ed25519 AAAA-test' })).status, 403);
  await save([{ ...clone, enabled: true }]);
  assert.equal((await user.get('/api/account')).json.canCreate, true);
});

test('resource inventory is administrator-only, excludes templates and gateway, and reports partial pool failures', async () => {
  stack.mock.vms.get(101).cfg.tags = 'tacid-dev;ubuntu;tacid-dev';
  const response = await admin.get('/api/admin/access-policy/resources');
  assert.equal(response.status, 200, response.text);
  const inventory = response.json;
  assert.deepEqual(inventory.vms.find((v) => v.vmid === 101).pools, ['tacid-dev']);
  assert.equal(inventory.pools.find((p) => p.id === 'tacid-dev').vmCount, 1);
  assert.ok(inventory.pools.find((p) => p.id === 'tacid-dev').comment.includes('tacid-dev'));
  assert.deepEqual(inventory.tags.find((t) => t.name === 'tacid-dev'), { name: 'tacid-dev', vmCount: 1 });
  assert.ok(!inventory.vms.some((v) => [9000, 9100, 150].includes(v.vmid)));
  assert.equal((await stack.admin().get('/api/admin/access-policy/resources')).status, 401);
  assert.equal((await stack.customer().get('/api/admin/access-policy/resources')).status, 404);
  stack.mock.poolFailures.add('tacid-dev');
  try {
    const degraded = (await admin.get('/api/admin/access-policy/resources')).json;
    assert.equal(degraded.pools.find((p) => p.id === 'tacid-dev').available, false);
    assert.equal(degraded.warnings.length, 1);
    assert.deepEqual(degraded.vms.find((v) => v.vmid === 101).pools, []);
  } finally { stack.mock.poolFailures.delete('tacid-dev'); }
});

test('stale editor revisions cannot replace newer permissions', async () => {
  const before = (await admin.get('/api/admin/access-policy')).json;
  const latest = await save([rule('newer-edit')]);
  const url = stack.adminUrl + '/api/admin/access-policy';
  const headers = { 'Content-Type': 'application/json', cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'If-Match': before.revision };
  const stale = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(policy([])) });
  assert.equal(stale.status, 409);
  assert.deepEqual((await admin.get('/api/admin/access-policy')).json.policy.rules.map((r) => r.id), ['newer-edit']);
  const current = await fetch(url, { method: 'PUT', headers: { ...headers, 'If-Match': latest.json.revision }, body: JSON.stringify(policy([rule('updated')])) });
  assert.equal(current.status, 200);
});
