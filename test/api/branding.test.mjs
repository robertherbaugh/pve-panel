import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startStack, Session, waitFor } from '../support/stack.mjs';

let stack, admin, dir, sql;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=', 'base64');
const input = (text = SVG, type = 'image/svg+xml') => ({ type, data: Buffer.from(text).toString('base64') });
const state = async () => (await admin.get('/api/admin/settings/branding')).json;
async function change(method, endpoint, body, revision = null) {
  const current = revision ?? (await state()).revision;
  const res = await fetch(admin.base + endpoint, { method, headers: {
    cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    'if-match': current, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
const upload = (slot, image, revision) => change('PUT', `/api/admin/settings/branding/${slot}`, image, revision);
const start = (env = {}) => startStack({ mail: true, env: {
  SETUP_CHECK_HOURS: '0', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false',
  DB_PATH: path.join(dir, 'saved.db'), PANEL_NAME: 'Acme Cloud', BRANDING_DIR: path.join(dir, 'legacy'), ...env,
} });
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-panel-branding-'));
  fs.mkdirSync(path.join(dir, 'legacy'));
  fs.writeFileSync(path.join(dir, 'legacy/logo.svg'), SVG);
  fs.writeFileSync(path.join(dir, 'legacy/os-linux.svg'), SVG);
  fs.writeFileSync(path.join(dir, 'legacy/secret.txt'), 'not public');
  stack = await start();
  admin = await stack.adminSession();
  sql = new DatabaseSync(path.join(dir, 'saved.db'));
});
after(async () => { sql?.close(); await stack?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('legacy name and fixed image files import into the database and serve both portals before sign-in', async () => {
  fs.rmSync(path.join(dir, 'legacy'), { recursive: true });
  assert.equal(sql.prepare("SELECT json_extract(value,'$.name') name FROM settings WHERE key='branding'").get().name, 'Acme Cloud');
  assert.equal(sql.prepare('SELECT count(*) n FROM branding_assets').get().n, 2);
  for (const base of [stack.customerUrl, stack.adminUrl]) {
    const brand = await (await fetch(`${base}/api/brand`)).json();
    assert.equal(brand.name, 'Acme Cloud');
    assert.match(brand.logo, /^\/branding\/logo\.svg\?v=[a-f0-9]{64}$/);
    assert.match(brand.osIcons.linux, /^\/branding\/os-linux\.svg\?v=/);
    const logo = await fetch(base + brand.logo);
    assert.equal(logo.status, 200);
    assert.equal(await logo.text(), SVG);
    assert.match(logo.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/branding/secret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/branding/logo.html`)).status, 404);
    for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'])
      assert.equal((await fetch(`${base}/shared/${file}`)).status, 200);
  }
});

test('only platform administrators can change branding, with a current revision', async () => {
  assert.equal((await stack.admin().get('/api/admin/settings/branding')).status, 401);
  const customer = await stack.customerWith('branding-user@example.com');
  assert.equal((await customer.get('/api/admin/settings/branding')).status, 404);
  assert.equal((await customer.put('/api/admin/settings/branding', { name: 'Not allowed' })).status, 404);
  const borrowed = stack.admin(); borrowed.cookies = new Map(customer.cookies);
  assert.equal((await borrowed.get('/api/admin/settings/branding')).status, 401);
  assert.equal((await admin.put('/api/admin/settings/branding', { name: 'Missing revision' })).status, 428);
  const before = await state();
  assert.equal((await change('PUT', '/api/admin/settings/branding', { name: 'RCADEA Cloud' })).status, 200);
  assert.equal((await upload('logo', input(), before.revision)).status, 409);
  assert.equal((await change('DELETE', '/api/admin/settings/branding/os-linux', undefined, before.revision)).status, 409);
  for (const base of [stack.customerUrl, stack.adminUrl])
    assert.equal((await (await fetch(base + '/api/brand')).json()).name, 'RCADEA Cloud');
  const local = new Session(stack.adminUrl.replace('127.0.0.1', 'localhost'));
  local.cookies = new Map(admin.cookies);
  const passkey = await local.post('/api/account/passkeys/options');
  assert.equal(passkey.status, 200, passkey.text);
  assert.equal(passkey.json.options.rp.name, 'RCADEA Cloud');
  await admin.put('/api/admin/settings/email', {
    host: '127.0.0.1', port: stack.smtp.port, security: 'none', username: 'panel', password: 'mail-secret',
    fromName: 'Support', fromAddress: 'panel@example.com', panelUrl: stack.customerUrl,
  });
  assert.equal((await admin.post('/api/admin/settings/email/test', { to: 'recipient@example.com' })).status, 200);
  const message = await waitFor(() => stack.smtp.messages.find((m) => m.to === 'recipient@example.com'));
  assert.equal(message.subject, 'RCADEA Cloud: test email');
  assert.ok(message.html.includes('RCADEA Cloud'));
  assert.ok(message.from.includes('Support'));
});

test('uploads store bytes in SQLite, invalidate image URLs and restore built-in images when removed', async () => {
  const before = await state();
  const uploaded = await upload('logo', { type: 'image/png', data: PNG.toString('base64') });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json));
  const row = sql.prepare("SELECT * FROM branding_assets WHERE slot='logo'").get();
  assert.deepEqual(Buffer.from(row.data), PNG);
  assert.equal(row.content_type, 'image/png');
  const current = uploaded.json.assets.logo.url;
  assert.notEqual(current, before.assets.logo.url);
  for (const base of [stack.customerUrl, stack.adminUrl]) {
    const asset = await fetch(base + current);
    assert.equal(asset.headers.get('content-type'), 'image/png');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), PNG);
    assert.equal((await fetch(base + current, { headers: { 'if-none-match': asset.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(base + before.assets.logo.url)).status, 404);
    assert.equal((await fetch(base + '/branding/logo.png?v=wrong')).status, 404);
  }
  assert.equal((await upload('os-windows', input())).status, 200);
  assert.equal((await change('DELETE', '/api/admin/settings/branding/logo')).status, 200);
  assert.equal((await stack.customer().get('/api/brand')).json.logo, null);
  assert.equal(sql.prepare("SELECT count(*) n FROM branding_assets WHERE slot='logo'").get().n, 0);
  assert.equal((await fetch(stack.customerUrl + current)).status, 404);
  const audit = sql.prepare("SELECT detail FROM audit_log WHERE action='admin_branding' ORDER BY id DESC LIMIT 2").all();
  assert.ok(audit.every((r) => !r.detail.includes(PNG.toString('base64')) && !r.detail.includes('<svg')));
});

test('bad images, scripts, external SVG references and oversized uploads cannot replace saved assets', async () => {
  const before = await state();
  const unsafe = [
    input('<html><script>alert(1)</script></html>'),
    input('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    input('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
    input('<!DOCTYPE svg [<!ENTITY x "test">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'),
    input('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>'),
    input('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'),
    input('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'),
    input(SVG, 'image/png'),
    { type: 'image/png', data: '%%%%' },
  ];
  for (const image of unsafe) assert.equal((await upload('os-linux', image)).status, 400);
  assert.equal((await upload('arbitrary-file', input())).status, 404);
  const huge = Buffer.alloc(1024 * 1024 + 1, 32).toString('base64');
  assert.ok([400, 413].includes((await upload('logo', { type: 'image/png', data: huge })).status));
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(50000, 16); bomb.writeUInt32BE(50000, 20);
  assert.equal((await upload('logo', { type: 'image/png', data: bomb.toString('base64') })).status, 400);
  assert.equal((await change('PUT', '/api/admin/settings/branding', { name: '   ' })).status, 400);
  assert.equal((await change('PUT', '/api/admin/settings/branding', { name: 'Bad\r\nName' })).status, 400);
  assert.deepEqual(await state(), before);
});

test('database branding survives restart and ignores later ENV or file changes, including removed images', async () => {
  const before = await state();
  sql.close(); sql = null;
  await stack.stop();
  fs.mkdirSync(path.join(dir, 'legacy'));
  fs.writeFileSync(path.join(dir, 'legacy/logo.svg'), SVG);
  stack = await start({ PANEL_NAME: 'Environment changed' });
  admin = await stack.adminSession();
  assert.deepEqual(await state(), before);
  assert.equal((await stack.customer().get('/api/brand')).json.logo, null);
  assert.equal((await stack.customer().get('/api/brand')).json.name, 'RCADEA Cloud');
  sql = new DatabaseSync(path.join(dir, 'saved.db'));
  assert.equal(sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
});
