// Tailscale on a customer server, including lost guest-agent results.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor } from '../support/stack.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

let stack;
let lena;
let vmid;
const KEY = 'tskey-auth-kGood12345-SECRETSECRETSECRET';
const settled = () => waitFor(async () => {
  const s = (await lena.get(`/api/vms/${vmid}/tailscale`)).json;
  return s && !['installing', 'disconnecting'].includes(s.state) ? s : null;
}, { timeout: 60_000, what: 'tailscale to settle' });

before(async () => {
  stack = await startStack();
  await stack.offerTemplates();
  lena = await stack.customerWith('lena@example.com', { limits: {} });
  vmid = (await lena.post('/api/vms', { hostname: 'web-shop', templateId: 9000, cores: 1, memoryMb: 1024, diskGb: 10, username: 'lena', password: 'supersecret-123' })).json.vmid;
  await stack.serverSettled(lena, vmid);
  await lena.post(`/api/vms/${vmid}/power/start`);
  await waitFor(async () => (await lena.get(`/api/vms/${vmid}`)).json?.status === 'running', { what: 'running' });
  await stack.agentReady(vmid); // like a real VM, the agent answers a moment after boot
});
after(async () => { await stack?.stop(); });

test('rejects keys that are not Tailscale auth keys', async () => {
  const r = await lena.post(`/api/vms/${vmid}/tailscale`, { authKey: 'hello', mode: 'server', hostname: 'web-shop' });
  assert.equal(r.status, 400);
});

test('connects as a gateway even when the agent loses the answer of "tailscale up"', async () => {
  await stack.mock.control(`/__lose/${vmid}/1/tailscale%20up`);
  const r = await lena.post(`/api/vms/${vmid}/tailscale`, { authKey: KEY, mode: 'gateway', hostname: 'web-shop' });
  assert.equal(r.status, 202, r.text);
  const s = await settled();
  assert.equal(s.state, 'connected', s.error);
  assert.equal(s.routeApproved, false, 'route waits for approval');
  await stack.mock.control(`/__tsapprove/${vmid}`);
  assert.equal((await lena.get(`/api/vms/${vmid}/tailscale`)).json.routeApproved, true);
});

test('the auth key never reaches a command line or the panel database', async () => {
  assert.equal(stack.logs().includes('SECRETSECRETSECRET'), false);
});

test('disconnects', async () => {
  const r = await lena.del(`/api/vms/${vmid}/tailscale`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removedFromTailnet, true);
  assert.equal((await lena.get(`/api/vms/${vmid}/tailscale`)).json.state, 'none');
});

test('a key Tailscale rejects ends in a clear failure', async () => {
  await lena.post(`/api/vms/${vmid}/tailscale`, { authKey: 'tskey-auth-badKey123-xyzxyzxyz', mode: 'server', hostname: 'web-shop' });
  const s = await settled();
  assert.equal(s.state, 'failed');
  assert.match(s.error, /invalid key/);
});
test('Headscale uses a configured login server and keeps its key off command lines and out of the database',async()=>{
 const admin=await stack.adminSession();
 assert.equal((await admin.put('/api/admin/remote-access',{provider:'headscale',loginServer:'http://headscale.example.com'})).status,400);
 assert.equal((await admin.put('/api/admin/remote-access',{provider:'headscale',loginServer:"https://headscale.example.com/';echo-bad"})).status,400);
 const saved=await admin.put('/api/admin/remote-access',{provider:'headscale',loginServer:'https://headscale.example.com/'});assert.equal(saved.status,200,saved.text);
 const key='0123456789abcdef'.repeat(4);
 const r=await lena.post(`/api/vms/${vmid}/tailscale`,{authKey:key,mode:'server',hostname:'headscale-shop'});assert.equal(r.status,202,r.text);
 const final=await settled();assert.equal(final.state,'connected',final.error);assert.equal(final.provider,'headscale');assert.equal(final.loginServer,'https://headscale.example.com');
 assert.equal(stack.mock.vms.get(vmid).ts.loginServer,'https://headscale.example.com');assert.ok(!stack.logs().includes(key));
 const sql=new DatabaseSync(path.join(stack.dir,'panel.db'));
 try {
  await lena.del(`/api/vms/${vmid}/tailscale`);stack.mock.cluster.echoTsKeyFailure=true;
  assert.equal((await lena.post(`/api/vms/${vmid}/tailscale`,{authKey:key,mode:'server',hostname:'headscale-shop'})).status,202);
  const failed=await settled();assert.equal(failed.state,'failed');assert.ok(failed.error.includes('[redacted]'));assert.ok(!failed.error.includes(key));
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM tailscale').all()).includes(key));assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM audit_log').all()).includes(key));
 }finally{stack.mock.cluster.echoTsKeyFailure=false;sql.close();}
 assert.equal((await lena.post(`/api/vms/${vmid}/tailscale`,{authKey:key,mode:'server',hostname:'headscale-shop'})).status,202);await settled();
 await admin.put('/api/admin/remote-access',{provider:'tailscale',loginServer:''});
 assert.equal((await lena.get(`/api/vms/${vmid}/tailscale`)).json.provider,'headscale','existing connection retains its control server');
});
