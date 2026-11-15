import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { startStack } from '../support/stack.mjs';
let stack, user, peer, saved, key, privateKey;
function makeKey() {
 const pair=generateKeyPairSync('ed25519');privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'});
 const wire=b=>{const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);};
 return `ssh-ed25519 ${Buffer.concat([wire(Buffer.from('ssh-ed25519')),wire(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32))]).toString('base64')} laptop`;
}
const spec=(name,extra={})=>({hostname:name,templateId:9000,cores:1,memoryMb:1024,diskGb:10,username:'engineer',...extra});
async function create(body) {
 const r=await user.post('/api/vms',body);assert.equal(r.status,202,r.text);
 const vm=await stack.serverSettled(user,r.json.vmid);assert.equal(vm.state,'ready',vm.error);
 return stack.mock.vms.get(r.json.vmid);
}
before(async()=>{
 stack=await startStack({env:{CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false',SETUP_CHECK_HOURS:'0'}});
 await stack.offerTemplates();user=await stack.customerWith('ssh-user@example.com',{limits:{}});peer=await stack.customerWith('ssh-peer@example.com',{limits:{}});key=makeKey();
 stack.mock.vms.get(9000).cfg.cipassword='inherited-template-password';
 stack.mock.vms.get(9000).cfg.sshkeys='ssh-ed25519 inherited-provider-key';
});
after(async()=>{await stack?.stop();});
test('personal key library validates public keys and cannot reveal or remove another user’s keys',async()=>{
 const r=await user.post('/api/ssh-keys',{name:'Work laptop',publicKey:key});assert.equal(r.status,201,r.text);saved=r.json;
 assert.match(saved.fingerprint,/^SHA256:/);assert.equal((await user.post('/api/ssh-keys',{name:'Duplicate',publicKey:key})).status,409);
 assert.equal((await peer.get('/api/ssh-keys')).json.keys.length,0);assert.equal((await peer.del(`/api/ssh-keys/${saved.id}`)).status,404);
 assert.equal((await user.post('/api/ssh-keys',{name:'Private',publicKey:privateKey})).status,400);
 assert.equal((await user.post('/api/ssh-keys',{name:'Broken',publicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5'})).status,400);
 assert.equal((await peer.post('/api/vms',spec('foreign-key',{loginMethod:'ssh',sshKeyIds:[saved.id]}))).status,400);
});
let keyVm;
test('saved SSH keys replace template credentials before first boot, without requiring a password',async()=>{
 keyVm=await create(spec('key-login',{loginMethod:'ssh',sshKeyIds:[saved.id]}));
 assert.equal(keyVm.cfg.ciuser,'engineer');assert.equal(keyVm.cfg.cipassword,undefined);
 assert.equal(decodeURIComponent(keyVm.cfg.sshkeys).trim(),saved.publicKey);
 assert.equal(keyVm.status,'running');
});
test('password login clears inherited SSH keys and both methods require both credentials',async()=>{
 const vm=await create(spec('password-login',{loginMethod:'password',password:'chosen-password-123'}));
 assert.equal(vm.cfg.sshkeys,undefined);assert.equal(vm.cfg.cipassword,'chosen-password-123');assert.equal(vm.cfg.ciuser,'engineer');
 assert.equal((await user.post('/api/vms',spec('no-credentials',{loginMethod:'ssh'}))).status,400);
 assert.equal((await user.post('/api/vms',spec('missing-password',{loginMethod:'both',sshKeyIds:[saved.id]}))).status,400);
 assert.equal((await user.post('/api/vms',spec('contradictory',{loginMethod:'password',password:'chosen-password-123',sshKeyIds:[saved.id]}))).status,400);
 const both=await create(spec('both-logins',{loginMethod:'both',password:'chosen-password-123',sshKeyIds:[saved.id]}));
 assert.equal(both.cfg.cipassword,'chosen-password-123');assert.equal(decodeURIComponent(both.cfg.sshkeys).trim(),saved.publicKey);
});
test('images that bypass generated cloud-init sign-in are rejected before cloning',async()=>{
 const image=stack.mock.vms.get(9000), old=image.cfg.ide2;
 delete image.cfg.ide2;assert.equal((await user.post('/api/vms',spec('no-drive',{password:'chosen-password-123'}))).status,400);image.cfg.ide2=old;
 image.cfg.cicustom='user=local:snippets/custom.yaml';
 assert.equal((await user.post('/api/vms',spec('custom-user',{password:'chosen-password-123'}))).status,400);delete image.cfg.cicustom;
});
test('removing a library key preserves previously provisioned access and the library survives restart',async()=>{
 await stack.restartPanel();assert.equal((await user.get('/api/ssh-keys')).json.keys[0].id,saved.id);
 assert.equal((await user.del(`/api/ssh-keys/${saved.id}`)).status,204);
 assert.equal((await user.get('/api/ssh-keys')).json.keys.length,0);
 assert.equal(decodeURIComponent(keyVm.cfg.sshkeys).trim(),saved.publicKey);
});
