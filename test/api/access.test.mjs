import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startStack, waitFor, sleep, Session, totp } from '../support/stack.mjs';
import WebSocket from 'ws';
import { once } from 'node:events';
import { startMockOidc } from '../support/mock-oidc.mjs';

let stack, oidc, admin, sql;
const rule = (id, patch = {}) => ({ id, name: id, groups: ['developers'], entitlements: [], match: 'any', pools: ['tacid-dev'], tags: [], vmids: [], actions: ['view', 'power', 'console'], ...patch });
const policy = (rules) => ({ version: 1, enabled: true, allowedDomains: ['tacticalid.io'], rules });
async function save(rules) { const r = await admin.put('/api/admin/access-policy', policy(rules)); assert.equal(r.status, 200, r.text); }
async function login(email, extra = {}) {
  const s = stack.customer();
  const r = await oidc.login(s, { email, ...extra });
  assert.equal(r.status, 200, r.text);
  assert.equal((await s.get('/api/auth/me')).status, 200, r.text);
  return s;
}
before(async () => {
  oidc = await startMockOidc();
  stack = await startStack({ env: { OIDC_ENABLED: 'true', OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: 'panel-test', OIDC_CLIENT_SECRET: 'secret',
    SIGNIN_RATE_LIMIT: '100', OIDC_ALLOW_INSECURE_HTTP: 'true', OIDC_AUTO_CREATE: 'true', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false', SETUP_CHECK_HOURS: '0' } });
  admin = await stack.adminSession();
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  stack.mock.vms.get(101).pool = 'tacid-dev';
  stack.mock.vms.get(102).pool = 'tacid-prod';
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
  stack.mock.perms['/pool/tacid-prod'] = ['Pool.Audit'];
});
after(async () => { sql?.close(); await stack?.stop(); await oidc?.close(); });

test('RBAC uses validated OIDC groups, limits VM visibility/actions, and keeps global admin separate', async () => {
  await save([rule('developers')]);
  const c = await login('developer@tacticalid.io', { groups: ['developers'] });
  assert.deepEqual((await c.get('/api/vms')).json.map((v) => v.vmid), [101]);
  assert.equal((await c.get('/api/vms/101')).status, 200);
  assert.equal((await c.post('/api/vms/101/power/start')).status, 200);
  assert.equal((await c.post('/api/vms/101/snapshots', { name: 'not-allowed' })).status, 404);
  assert.equal((await c.get('/api/vms/102')).status, 404);
  assert.equal((await c.post('/api/vms/102/power/start')).status, 404);
  assert.equal((await stack.admin().post('/api/auth/login', { email: 'developer@tacticalid.io', password: 'x' })).status, 401);
  assert.equal((await c.get('/api/admin/access-policy')).status, 404);
});

test('ABAC supports application entitlements and exact pool/tag attributes', async () => {
  stack.mock.vms.get(102).tags = 'tacid-prod;production';
  await sleep(5100);
  await save([rule('production', { groups: [], entitlements: ['prod:operate'], pools: ['tacid-prod'], tags: ['production'] })]);
  const c = await login('operator@tacticalid.io', { entitlements: ['prod:operate'] });
  assert.deepEqual((await c.get('/api/vms')).json.map((v) => v.vmid), [102]);
  const outsider = await login('outside@other.io', { entitlements: ['prod:operate'] });
  assert.deepEqual((await outsider.get('/api/vms')).json, []);
  const noGrant = await login('unassigned@tacticalid.io');
  assert.deepEqual((await noGrant.get('/api/vms')).json, []);
  stack.mock.vms.get(102).tags = '';
  await sleep(5100); // guest inventory cache
  assert.equal((await c.get('/api/vms/102')).status, 404);
});

test('all requires both group and entitlement; password sessions cannot borrow OIDC grants', async () => {
  await save([rule('combined', { entitlements: ['approved'], match: 'all' })]);
  const onlyGroup = await login('only-group@tacticalid.io', { groups: ['developers'] });
  assert.deepEqual((await onlyGroup.get('/api/vms')).json, []);
  const both = await login('both@tacticalid.io', { groups: ['developers'], entitlements: ['approved'] });
  assert.equal((await both.get('/api/vms/101')).status, 200);
  const userId = (await both.get('/api/auth/me')).json.id;
  await admin.patch(`/api/admin/users/${userId}`, { password: 'a-very-long-password' });
  const password = stack.customer();
  assert.equal((await password.post('/api/auth/login', { email: 'both@tacticalid.io', password: 'a-very-long-password' })).status, 200);
  assert.deepEqual((await password.get('/api/vms')).json, []);
});

test('claim leases, policy edits, logout and malformed claims fail closed', async () => {
  await save([rule('lease')]);
  const c = await login('lease@tacticalid.io', { groups: ['developers'] });
  assert.equal((await c.get('/api/vms/101')).status, 200);
  sql.prepare('UPDATE oidc_authorizations SET expires_at=0 WHERE user_id=?').run((await c.get('/api/auth/me')).json.id);
  assert.equal((await c.get('/api/vms/101')).status, 404);
  assert.equal((await c.get('/api/account')).json.authorization.refreshRequired, true);
  const current = await login('lease@tacticalid.io', { groups: ['developers'] });
  const replay = new Session(stack.customerUrl); replay.cookies = new Map(current.cookies);
  await current.post('/api/auth/logout');
  assert.equal((await replay.get('/api/vms/101')).status, 404);
  const again = await login('lease@tacticalid.io', { groups: ['developers'] });
  await save([rule('lease', { actions: ['view'] })]);
  assert.equal((await again.post('/api/vms/101/power/start')).status, 404);
  const malformed = stack.customer();
  const bad = await oidc.login(malformed, { email: 'malformed@tacticalid.io', groups: 'developers' });
  assert.match(bad.text, /sso_error/);
  assert.equal((await malformed.get('/api/vms')).status, 401);
});

test('legacy assignments survive policy changes; group users do not acquire ownership-specific operations', async () => {
  const owner = await stack.customerWith('legacy@example.com');
  assert.equal((await admin.put('/api/admin/vms/102', { userId: owner.userId })).status, 200);
  await save([rule('share-production', { pools: ['tacid-prod'], actions: ['view', 'delete', 'resize', 'reinstall'] })]);
  assert.equal((await owner.get('/api/vms/102')).status, 200);
  const c = await login('other@tacticalid.io', { groups: ['developers'] });
  // Explicit assignment to another customer wins over a matching shared pool.
  assert.equal((await c.get('/api/vms/102')).status, 404);
  assert.equal((await c.del('/api/vms/102')).status, 404);
  assert.equal((await c.post('/api/vms/102/reinstall', { templateId: 9000 })).status, 404);
  await admin.del('/api/admin/vms/102');
});

test('policy cloning binds template, storage, destination and quota; creators lose access after revocation', async () => {
  await stack.offerTemplates();
  const clone = { pool: 'tacid-dev', templates: [9000], storages: ['VMStorage'], limits: { servers: 1, cores: 4, memoryMb: 4096, diskGb: 20 } };
  await save([rule('clone-development', { actions: ['view', 'power', 'clone'], clone })]);
  const c = await login('creator@tacticalid.io', { groups: ['developers'] });
  assert.equal((await c.get('/api/account')).json.canCreate, true);
  assert.deepEqual((await c.get('/api/templates')).json.map((t) => t.id), [9000]);
  const spec = { hostname: 'group-clone', username: 'ops', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 4, sshKeys: 'ssh-ed25519 AAAA-test' };
  assert.equal((await c.post('/api/vms', { ...spec, templateId: 9100 })).status, 403);
  assert.equal((await c.post('/api/vms', { ...spec, accessRuleId: 'not-a-grant' })).status, 403);
  await save([rule('clone-development', { actions: ['view', 'power', 'clone'], clone: { ...clone, storages: ['other-storage'] } })]);
  assert.equal((await c.post('/api/vms', spec)).status, 403);
  await save([rule('clone-development', { actions: ['view', 'power', 'clone'], clone })]);
  stack.mock.vms.get(9000).cfg.scsi1 = 'unapproved:base-extra,size=1G';
  assert.equal((await c.post('/api/vms', spec)).status, 403, 'all inherited disk storage IDs are checked');
  delete stack.mock.vms.get(9000).cfg.scsi1;
  const created = await c.post('/api/vms', { ...spec, accessRuleId: 'clone-development', pool: 'tacid-prod' });
  assert.equal(created.status, 202, created.text);
  const vmid = created.json.vmid;
  assert.equal(stack.mock.vms.get(vmid).pool, 'tacid-dev');
  assert.equal(sql.prepare('SELECT access_managed FROM vms WHERE vmid=?').get(vmid).access_managed, 1);
  assert.equal((await c.post('/api/vms', spec)).status, 409);
  await waitFor(async () => (await c.get('/api/vms')).json?.some((v) => v.vmid === vmid && v.state === 'ready'), { timeout: 30000 });
  const peer = await login('peer@tacticalid.io', { groups: ['developers'] });
  assert.equal((await peer.get(`/api/vms/${vmid}`)).status, 200);
  sql.prepare('UPDATE oidc_authorizations SET expires_at=0 WHERE user_id=?').run((await c.get('/api/auth/me')).json.id);
  assert.equal((await c.get(`/api/vms/${vmid}`)).status, 404, 'creator ownership does not bypass managed access');
  assert.equal((await peer.get(`/api/vms/${vmid}`)).status, 200);
});

test('invalid policies cannot broaden access; pool audit failures do not grant access', async () => {
  assert.equal((await admin.put('/api/admin/access-policy', policy([rule('wildcard', { pools: ['*'] })]))).status, 400);
  assert.equal((await admin.put('/api/admin/access-policy', policy([rule('unknown', { actions: ['view', 'admin'] })]))).status, 400);
  await save([rule('pool-failure')]);
  const c = await login('pool-reader@tacticalid.io', { groups: ['developers'] });
  stack.mock.perms['/pool/tacid-dev'] = [];
  await sleep(5100);
  assert.deepEqual((await c.get('/api/vms')).json, []);
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
});


test('console tickets and websocket connections recheck access; open consoles close on revocation', async () => {
  await save([rule('console')]);
  const c = await login('console@tacticalid.io', { groups: ['developers'] });
  const denied = await login('no-console@tacticalid.io');
  assert.equal((await denied.post('/api/vms/101/console')).status, 404);
  await c.post('/api/vms/101/power/start');
  await sleep(5100);
  const ticket = await c.post('/api/vms/101/console');
  assert.equal(ticket.status, 200, ticket.text);
  const connect = (id) => new WebSocket(`${stack.customerUrl.replace('http:', 'ws:')}/api/console/${id}`, {
    headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  await save([rule('console', { actions: ['view'] })]);
  const revoked = connect(ticket.json.session);
  const [code] = await once(revoked, 'close');
  assert.equal(code, 4001);
  await save([rule('console')]);
  const next = await c.post('/api/vms/101/console');
  const ws = connect(next.json.session);
  try {
    await once(ws, 'open');
    const message = once(ws, 'message');
    ws.send('probe');
    await message;
    const closed = once(ws, 'close');
    await c.post('/api/auth/logout');
    await Promise.race([closed, sleep(12000).then(() => { throw new Error('Console remained open after logout'); })]);
  } finally { ws.terminate(); }
  const short = await login('console-short@tacticalid.io', { groups: ['developers'], exp: Math.floor(Date.now() / 1000) + 4 });
  c.cookies = new Map(short.cookies);
  const shortTicket = await c.post('/api/vms/101/console');
  assert.equal(shortTicket.status, 200, shortTicket.text);
  const shortWs = connect(shortTicket.json.session);
  try {
    await once(shortWs, 'open');
    await Promise.race([once(shortWs, 'close'), sleep(6500).then(() => { throw new Error('Console survived claim expiry'); })]);
  } finally { shortWs.terminate(); }
});

test('OIDC authorization survives required MFA setup and verification without leaking into password MFA', async () => {
  await save([rule('mfa')]);
  const email = 'mfa-policy@tacticalid.io';
  const created = await admin.post('/api/admin/users', { email, password: 'a-long-mfa-password', requireTotp: true });
  assert.equal(created.status, 201, created.text);
  const c = stack.customer();
  assert.match((await oidc.login(c, { email, groups: ['developers'] })).text, /sso=2fa/);
  assert.equal((await c.get('/api/vms')).status, 401);
  const setup = await c.post('/api/auth/2fa/setup');
  const activated = await c.post('/api/auth/2fa/activate', { code: totp(setup.json.key) });
  assert.equal(activated.status, 200, activated.text);
  assert.equal((await c.get('/api/vms/101')).status, 200);
  await c.post('/api/auth/logout');
  await oidc.login(c, { email, groups: ['developers'] });
  assert.equal((await c.post('/api/auth/2fa/verify', { code: activated.json.recoveryCodes[0] })).status, 200);
  assert.equal((await c.get('/api/vms/101')).status, 200);
  const password = stack.customer();
  await password.post('/api/auth/login', { email, password: 'a-long-mfa-password' });
  assert.equal((await password.post('/api/auth/2fa/verify', { code: activated.json.recoveryCodes[1] })).status, 200);
  assert.equal((await password.get('/api/vms/101')).status, 404);
});

test('wrong issuer, audience, nonce, signature and malformed entitlements do not create a session', async () => {
  for (const extra of [{ iss: 'https://wrong.example' }, { aud: 'another-client' }, { nonce: 'wrong' }, { badSignature: true }, { entitlements: [123] }, { email_verified: false }]) {
    const c = stack.customer();
    const r = await oidc.login(c, { email: 'bad-token@tacticalid.io', groups: ['developers'], ...extra });
    assert.match(r.headers.get('location') ?? r.text, /sso_error/, JSON.stringify(extra));
    assert.equal((await c.get('/api/vms')).status, 401);
  }
});

test('multiple grants require explicit destination and never combine quotas; pool removal revokes visibility', async () => {
  const clone = { pool: 'tacid-dev', templates: [9000], storages: ['VMStorage'], limits: { servers: 1, cores: 1, memoryMb: 1024, diskGb: 4 } };
  await save([rule('destination-a', { actions: ['view', 'clone'], clone }), rule('destination-b', { actions: ['view', 'clone'], clone })]);
  const c = await login('multiple@tacticalid.io', { groups: ['developers'] });
  const spec = { hostname: 'too-large', username: 'ops', templateId: 9000, cores: 2, memoryMb: 1024, diskGb: 4, sshKeys: 'ssh-ed25519 AAAA-test' };
  assert.equal((await c.post('/api/vms', spec)).status, 400);
  assert.equal((await c.post('/api/vms', { ...spec, accessRuleId: 'destination-a' })).status, 409);
  assert.equal((await c.get('/api/vms/101')).status, 200);
  stack.mock.vms.get(101).pool = 'elsewhere';
  await sleep(5100);
  assert.equal((await c.get('/api/vms/101')).status, 404);
  stack.mock.vms.get(101).pool = 'tacid-dev';
});


test('LXC policy creation binds pool, trusted tags and root disk storage', async () => {
  const image = await admin.put('/api/admin/ct-templates', { volid: 'local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst', node: 'pve1', label: 'Policy Debian', storage: 'local-lvm', minDiskGb: 4 });
  assert.equal(image.status, 200, image.text);
  const id = `ct-${image.json.id}`;
  await save([rule('containers', { tags: ['tacid-dev'], actions: ['view', 'power', 'clone'], clone: {
    pool: 'tacid-dev', templates: [id], storages: ['local-lvm'], limits: { servers: 1, cores: 2, memoryMb: 2048, diskGb: 16 },
  } })]);
  const c = await login('container-creator@tacticalid.io', { groups: ['developers'] });
  const created = await c.post('/api/vms', { hostname: 'policy-container', templateId: id, accessRuleId: 'containers', cores: 1, memoryMb: 1024, diskGb: 4, password: 'another-long-password' });
  assert.equal(created.status, 202, created.text);
  const call = stack.mock.ctCreates.find((x) => Number(x.vmid) === created.json.vmid);
  assert.equal(call.pool, 'tacid-dev');
  assert.equal(call.tags, 'tacid-dev');
  assert.match(call.rootfs, /^local-lvm:/);
  const row = await stack.serverSettled(c, created.json.vmid, 30000);
  assert.equal(row.state, 'ready');
});
