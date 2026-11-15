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
 await admin.put('/api/admin/vms/501',{customerId,label:'Imported server'});
});
after(async()=>{sql?.close();await stack?.stop();});
test('admin power actions work for unassigned guests and always protect templates and gateway',async()=>{
 assert.equal((await admin.post('/api/admin/vms/505/power/start')).status,200);
 await waitFor(()=>stack.mock.vms.get(505).status==='running');assert.equal((await admin.post('/api/admin/vms/505/power/stop')).status,200);
 assert.equal((await admin.post('/api/admin/vms/9000/power/start')).status,404);assert.equal((await admin.post('/api/admin/vms/150/power/stop')).status,403);
 const vm=(await admin.get('/api/admin/vms')).json.find(v=>v.vmid===505);assert.equal(vm.state,'ready');assert.equal(vm.userId,null);
});
test('customer Delete works on imported assignments with confirmation, preserves tenancy and blocks running guests',async()=>{
 assert.equal((await user.get('/api/vms/501')).json.deletable,true);
 assert.equal((await user.del('/api/vms/501')).status,400);assert.equal((await del(outsider,501)).status,404);
 stack.mock.vms.get(501).status='running';assert.equal((await del(user,501)).status,409);stack.mock.vms.get(501).status='stopped';
 const r=await del(user,501);assert.equal(r.status,202,r.text);assert.ok(r.json.operationId);
 assert.equal((await admin.put('/api/admin/vms/501',{customerId:customerId+1})).status,409);
 await waitFor(()=>!stack.mock.vms.has(501));await waitFor(()=>!sql.prepare('SELECT 1 FROM vms WHERE vmid=501').get());assert.equal(sql.prepare('SELECT state FROM vm_deletions WHERE id=?').get(r.json.operationId).state,'complete');
});
test('shared pool guests can be deleted by a customer admin while operators and viewers cannot',async()=>{
 stack.mock.vms.get(507).pool='shared-delete';stack.mock.perms['/pool/shared-delete']=['Pool.Audit','VM.Audit','VM.Allocate'];
 const c=(await admin.post('/api/admin/customers',organization('SharedDelete',['shared-delete']))).json;
 await admin.put(`/api/admin/customers/${c.id}/members`,{userId:user.userId,role:'operator'});await user.post('/api/customers/select',{customerId:c.id});
 assert.equal((await user.get('/api/vms/507')).json.deletable,false);assert.equal((await del(user,507)).status,404);
 await admin.put(`/api/admin/customers/${c.id}/members`,{userId:user.userId,role:'admin'});assert.equal((await user.get('/api/vms/507')).json.deletable,true);
 assert.equal((await del(user,507)).status,202);await waitFor(()=>!stack.mock.vms.has(507));await user.post('/api/customers/select',{customerId});
});
test('all deletions reject Proxmox locks, native HA and current jobs; unassigned deletion has durable tracking',async()=>{
 stack.mock.vms.get(508).cfg.lock='backup';assert.equal((await del(admin,508,true)).status,409);delete stack.mock.vms.get(508).cfg.lock;
 stack.mock.cluster.haResources=[{sid:'vm:508',state:'stopped'}];assert.equal((await del(admin,508,true)).status,409);stack.mock.cluster.haResources=[];
 assert.equal((await admin.del('/api/admin/vms/508/server')).status,400);
 stack.mock.vms.get(508).status='running';const r=await del(admin,508,true);assert.equal(r.status,202,r.text);assert.ok(sql.prepare('SELECT 1 FROM vm_deletions WHERE vmid=508').get());
 assert.equal((await admin.post('/api/admin/vms/508/power/start')).status,409);await waitFor(()=>!stack.mock.vms.has(508));await waitFor(()=>sql.prepare('SELECT state FROM vm_deletions WHERE vmid=508').get().state==='complete');
});
test('uncertain deletion submission survives restart without resubmission or reservation release',async()=>{
 const now=new Date().toISOString();
 sql.prepare("INSERT INTO vm_deletions(id,vmid,customer_id,user_id,node,type,name,state,admin) VALUES('uncertain-delete',509,?,?,'pve1','qemu','imported-509','submitting',1)").run(customerId,user.userId);
 sql.prepare("INSERT INTO compute_allocations(id,vmid,customer_id,offering,started_at) VALUES('delete-held',509,?,'{}',?)").run(customerId,now);
 const calls=stack.mock.destroyed.filter(s=>s.startsWith('DELETE 509 ')).length;
 await stack.restartPanel();admin=await stack.adminSession();
 await waitFor(()=>sql.prepare("SELECT state FROM vm_deletions WHERE id='uncertain-delete'").get().state==='review');assert.equal(stack.mock.destroyed.filter(s=>s.startsWith('DELETE 509 ')).length,calls);assert.equal(sql.prepare("SELECT ended_at FROM compute_allocations WHERE id='delete-held'").get().ended_at,null);
 assert.equal((await del(admin,509,true)).status,409);
 stack.mock.vms.delete(509);await stack.restartPanel();await waitFor(()=>sql.prepare("SELECT state FROM vm_deletions WHERE id='uncertain-delete'").get().state==='complete');assert.ok(sql.prepare("SELECT ended_at FROM compute_allocations WHERE id='delete-held'").get().ended_at);
});
