import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startStack, waitFor } from '../support/stack.mjs';
let stack, admin, user, customerId, sql;
const input = (hostname, extra = {}) => ({ hostname, templateId: 9000, sizeId: 'small', storageClassId: 'fast', diskGb: 20, username: 'debian', password: 'compute-password-123', ...extra });
async function create(body, key = randomUUID()) {
 const res = await fetch(user.base + '/api/vms', { method: 'POST', headers: { cookie: [...user.cookies].map(([k,v]) => `${k}=${v}`).join('; '), 'content-type':'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
 return { status: res.status, json: await res.json() };
}
const catalogBody = c => ({ revision:c.revision, sizes:c.sizes, classes:c.classes.map(({id,enabled,bindings})=>({id,enabled,bindings})),reserves:c.reserves });
before(async () => {
 stack = await startStack({env:{CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false', SETUP_CHECK_HOURS:'0'}}); admin = await stack.adminSession();
 await stack.offerTemplates(); user = await stack.customerWith('services@example.com',{limits:{maxServers:10,maxCores:32,maxMemoryMb:65536,maxDiskGb:1000}});
 customerId=(await admin.get('/api/admin/customers')).json.customers.find(c=>c.name==='services@example.com').id;
 sql=new DatabaseSync(path.join(stack.dir,'panel.db'));
 stack.mock.perms['/vms']=['VM.Audit'];stack.mock.perms['/pool/customers'].push('Pool.Audit');
 stack.mock.cluster.nodes=[{node:'pve1',status:'online',maxcpu:32,maxmem:128*2**30,mem:32*2**30},{node:'pve2',status:'online',maxcpu:32,maxmem:128*2**30,mem:2**30}];
 const stores=[{storage:'VMStorage',content:'images,rootdir',active:1,enabled:1,shared:1,total:1000*2**30,avail:900*2**30},{storage:'nvme',content:'images,rootdir',active:1,enabled:1,shared:0,total:1000*2**30,avail:900*2**30}];
 stack.mock.cluster.storageInventories={pve1:structuredClone(stores),pve2:structuredClone(stores)};
 let c=catalogBody((await admin.get('/api/admin/compute-catalog')).json); c.sizes[0].enabled=true;c.sizes[1].enabled=true;
 c.classes.find(c=>c.id==='fast').enabled=true;c.classes.find(c=>c.id==='fast').bindings=[{node:'pve1',storage:'nvme',purpose:'vm'},{node:'pve2',storage:'nvme',purpose:'vm'}];
 assert.equal((await admin.put('/api/admin/compute-catalog',c)).status,200);
 const p=(await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;
 assert.equal((await admin.put(`/api/admin/customers/${customerId}/compute-profile`,{revision:p.revision,catalogRevision:c.revision+1,tier:p.tier,sizeIds:p.sizeIds,storageClassIds:p.storageClassIds,haAllowed:p.haAllowed,backupServiceEnabled:p.backupServiceEnabled,storageLimitsGb:p.storageLimitsGb,backupLimitGb:p.backupLimitGb,catalogEnabled:true,network:{bridge:'vmbr0',vlan:47,verified:true}})).status,200);
});
after(async()=>{sql?.close();await stack?.stop();});
test('customer administrators select backup service without changing provider quotas or eligibility',async()=>{
 const before=(await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;
 let p=(await user.get('/api/compute-services')).json;assert.equal(p.enabled,true);assert.equal(p.canManage,true);
 assert.equal((await user.put('/api/compute-services',{revision:p.revision,backupServiceEnabled:true,haAllowed:true})).status,200);p=(await user.get('/api/compute-services')).json;
 const r=await user.put('/api/compute-services',{revision:p.revision,backupServiceEnabled:true});assert.equal(r.status,200,r.text);assert.equal(r.json.backupServiceEnabled,true);
 assert.equal((await user.put('/api/compute-services',{revision:p.revision,backupServiceEnabled:false})).status,409);
 const after=(await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;assert.deepEqual(after.storageLimitsGb,before.storageLimitsGb);assert.equal(after.haAllowed,before.haAllowed);
 sql.prepare("UPDATE customer_memberships SET role='viewer' WHERE customer_id=? AND user_id=?").run(customerId,user.userId);
 assert.equal((await user.put('/api/compute-services',{revision:r.json.revision,backupServiceEnabled:false})).status,403);
 sql.prepare("UPDATE customer_memberships SET role='admin' WHERE customer_id=? AND user_id=?").run(customerId,user.userId);
 const off=await user.put('/api/compute-services',{revision:r.json.revision,backupServiceEnabled:false});assert.equal(off.status,200,off.text);
});
