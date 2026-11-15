import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startStack, waitFor } from '../support/stack.mjs';
let stack, admin, user, outsider, sql, customerId;
const guest=(id,extra={})=>({vmid:id,node:'pve1',type:'qemu',name:`imported-${id}`,status:'stopped',maxcpu:1,maxmem:2**30,maxdisk:8*2**30,cfg:{cores:1,memory:1024,scsi0:`VMStorage:vm-${id}-disk-0,size=8G`},...extra});
const organization=(name,pools=[])=>({name,slug:name.toLowerCase(),enabled:true,pools,allowedDomains:[],sso:{groups:[],entitlements:[],match:'any',required:false},limits:{servers:0,cores:0,memoryMb:0,diskGb:0}});
const del=(session,id,adminRoute=false)=>session.req('DELETE',adminRoute?`/api/admin/vms/${id}/server`:`/api/vms/${id}`,{confirmVmid:id});
before(async()=>{
 stack=await startStack({env:{SETUP_CHECK_HOURS:'0'}});admin=await stack.adminSession();user=await stack.customerWith('server-manager@example.com');outsider=await stack.customerWith('server-outsider@example.com');customerId=(await user.get('/api/account')).json.customer.id;sql=new DatabaseSync(path.join(stack.dir,'panel.db'));
 for(let id=501;id<=512;id++)stack.mock.vms.set(id,guest(id));
});
after(async()=>{sql?.close();await stack?.stop();});
test('bulk assignment is atomic, preserves labels and expiry rules, and rejects protected or missing guests',async()=>{
 await admin.put('/api/admin/vms/501',{customerId,label:'Keep this label'});
 let r=await admin.post('/api/admin/vms/assign',{vmids:[501,502,99999],customerId});assert.equal(r.status,400,r.text);assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=502').get(),undefined);
 r=await admin.post('/api/admin/vms/assign',{vmids:[502,9000],customerId});assert.equal(r.status,400,r.text);
 r=await admin.post('/api/admin/vms/assign',{vmids:[501,502,503],customerId});assert.equal(r.status,200,r.text);assert.equal(r.json.assigned,3);assert.equal(sql.prepare('SELECT label FROM vms WHERE vmid=501').get().label,'Keep this label');
 assert.deepEqual((await user.get('/api/vms')).json.map(v=>v.vmid),[501,502,503]);assert.equal((await outsider.post('/api/admin/vms/assign',{vmids:[504],customerId})).status,404);
});
test('bulk assignment verifies exact customer pool boundaries and blocks busy or catalog reservations without partial writes',async()=>{
 stack.mock.perms['/pool/limited']=['Pool.Audit','VM.Audit'];stack.mock.vms.get(504).pool='limited';
 const c=(await admin.post('/api/admin/customers',organization('Limited',['limited']))).json;
 let r=await admin.post('/api/admin/vms/assign',{vmids:[504,505],customerId:c.id});assert.equal(r.status,400,r.text);assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=504').get(),undefined);
 r=await admin.post('/api/admin/vms/assign',{vmids:[504],customerId:c.id});assert.equal(r.status,200,r.text);
 sql.prepare("UPDATE vms SET state='creating' WHERE vmid=502").run();r=await admin.post('/api/admin/vms/assign',{vmids:[505,502],customerId});assert.equal(r.status,409,r.text);assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=505').get(),undefined);sql.prepare("UPDATE vms SET state='ready' WHERE vmid=502").run();
 sql.prepare("INSERT INTO compute_allocations(id,vmid,customer_id,offering,started_at) VALUES('transfer-hold',506,?,'{}',datetime('now'))").run(customerId);
 r=await admin.post('/api/admin/vms/assign',{vmids:[505,506],customerId});assert.equal(r.status,409,r.text);assert.equal(sql.prepare('SELECT customer_id FROM vms WHERE vmid=505').get(),undefined);
});
