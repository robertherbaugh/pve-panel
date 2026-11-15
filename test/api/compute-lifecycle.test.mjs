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
 await stack.offerTemplates(); user = await stack.customerWith('lifecycle@example.com',{limits:{maxServers:10,maxCores:32,maxMemoryMb:65536,maxDiskGb:1000}});
 customerId=(await admin.get('/api/admin/customers')).json.customers.find(c=>c.name==='lifecycle@example.com').id;
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
let vmid;
test('catalog resize preserves node/class, replaces its reservation and records one allocation event',async()=>{
 const r=await create(input('lifecycle-vm'));assert.equal(r.status,202,JSON.stringify(r.json));vmid=r.json.vmid;
 {const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);}
 assert.equal((await user.post(`/api/vms/${vmid}/resize`,{sizeId:'medium',diskGb:30})).status,409);
 stack.mock.vms.get(vmid).status='stopped';
 assert.equal((await user.post(`/api/vms/${vmid}/resize`,{cores:8,memoryMb:8192})).status,400);
 const resized=await user.post(`/api/vms/${vmid}/resize`,{sizeId:'medium',diskGb:30});assert.equal(resized.status,200,resized.text);
 {const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);}
 const vm=stack.mock.vms.get(vmid);assert.equal(vm.node,'pve2');assert.match(vm.cfg.scsi0,/^nvme:.*size=30G/);assert.equal(Number(vm.cfg.memory),4096);assert.equal(Number(vm.cfg.cores),2);assert.equal(vm.status,'stopped');
 const a=sql.prepare('SELECT * FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').all(vmid);assert.equal(a.length,1);assert.equal(JSON.parse(a[0].offering).sizeId,'medium');
 assert.equal(sql.prepare("SELECT count(*) n FROM compute_reservations WHERE vmid=? AND state='committed'").get(vmid).n,1);
 assert.equal(sql.prepare("SELECT count(*) n FROM compute_allocation_events WHERE allocation_id=? AND kind='resized'").get(a[0].id).n,1);
 assert.equal((await user.post(`/api/vms/${vmid}/resize`,{sizeId:'small',diskGb:20})).status,400);
});
test('catalog resize refuses unavailable host capacity before any mutation',async()=>{
 const vm=stack.mock.vms.get(vmid),before=vm.cfg.memory;
 stack.mock.cluster.nodes.find(n=>n.node==='pve2').maxcpu=1;
 const r=await user.post(`/api/vms/${vmid}/resize`,{sizeId:'medium',diskGb:40});assert.equal(r.status,409,r.text);assert.equal(vm.cfg.memory,before);assert.match(vm.cfg.scsi0,/size=30G/);
 stack.mock.cluster.nodes.find(n=>n.node==='pve2').maxcpu=32;
});
test('accepted disk growth resumes after restart without a second allocation',async()=>{
 stack.mock.cluster.resizeDelay=5000;
 const r=await user.post(`/api/vms/${vmid}/resize`,{sizeId:'small',diskGb:35});assert.equal(r.status,200,r.text);
 await waitFor(()=>sql.prepare("SELECT 1 FROM compute_operation_steps WHERE operation_id=? AND name='disk-growth' AND state='running'").get(r.json.operationId));
 await stack.restartPanel();
 {const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);}
 assert.equal(sql.prepare('SELECT state FROM compute_operations WHERE id=?').get(r.json.operationId).state,'complete');
 assert.equal(sql.prepare("SELECT count(*) n FROM compute_reservations WHERE vmid=? AND state='committed'").get(vmid).n,1);
 assert.equal((await user.get(`/api/vms/${vmid}`)).json.resizable,true);
 stack.mock.cluster.resizeDelay=500;
});
test('catalog reinstall keeps the offering, placement, VMID and MAC while applying new login credentials',async()=>{
 const old=stack.mock.vms.get(vmid),mac=/=[0-9A-Fa-f:]{17}/.exec(old.cfg.net0)[0];
 const r=await user.post(`/api/vms/${vmid}/reinstall`,{templateId:9000,username:'newuser',password:'new-password-123'});assert.equal(r.status,202,r.text);
 const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);
 const vm=stack.mock.vms.get(vmid);assert.equal(vm.node,'pve2');assert.match(vm.cfg.scsi0,/^nvme:.*size=35G/);assert.ok(vm.cfg.net0.includes(mac));assert.match(vm.cfg.net0,/bridge=vmbr0,tag=47/);assert.equal(vm.cfg.ciuser,'newuser');assert.equal(vm.cfg.cipassword,'new-password-123');
 const a=sql.prepare('SELECT * FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').all(vmid);assert.equal(a.length,1);assert.equal(JSON.parse(a[0].offering).sizeId,'small');
});
test('reinstall follows an accepted clone after restart and keeps one allocation',async()=>{
 stack.mock.vms.get(vmid).status='stopped'; stack.mock.cluster.cloneDelay=5000;
 const r=await user.post(`/api/vms/${vmid}/reinstall`,{templateId:9000,username:'again',password:'new-password-123'});assert.equal(r.status,202,r.text);
 await waitFor(()=>sql.prepare("SELECT 1 FROM compute_operation_steps s JOIN compute_operations o ON o.id=s.operation_id WHERE o.vmid=? AND o.kind='reinstalled' AND s.name='clone' AND s.state='running'").get(vmid));
 await stack.restartPanel();
 const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);
 assert.equal(stack.mock.vms.get(vmid).cfg.ciuser,'again');
 assert.equal(sql.prepare('SELECT count(*) n FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').get(vmid).n,1);
 stack.mock.cluster.cloneDelay=2500;
});
let archive;
test('catalog restore pins the datastore and reapplies reserved hardware and network before boot',async()=>{
 for(const node of ['pve1','pve2']) stack.mock.cluster.storageInventories[node].push({storage:'pbs',type:'pbs',content:'backup',active:1,enabled:1,shared:1,avail:900*2**30,total:1000*2**30});
 let c=catalogBody((await admin.get('/api/admin/compute-catalog')).json);c.classes[0].enabled=true;c.classes[0].bindings=[{node:'pve2',storage:'pbs',purpose:'backup'}];assert.equal((await admin.put('/api/admin/compute-catalog',c)).status,200);
 const p=(await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;
 const {revision,tier,sizeIds,storageClassIds,haAllowed,storageLimitsGb,backupLimitGb,catalogEnabled,network}=p;
 assert.equal((await admin.put(`/api/admin/customers/${customerId}/compute-profile`,{revision,catalogRevision:c.revision+1,tier,sizeIds,storageClassIds,haAllowed,storageLimitsGb,backupLimitGb,catalogEnabled,network,backupServiceEnabled:true})).status,200);
 assert.equal((await admin.put('/api/admin/settings/backups',{enabled:true,storage:'pbs',maxPerServer:10})).status,200);
 const b=await user.post(`/api/vms/${vmid}/backups`);assert.equal(b.status,202,b.text);
 const job=await waitFor(()=>{const j=sql.prepare('SELECT * FROM backup_jobs WHERE id=?').get(b.json.id);return j.state==='done'?j:null;});archive=job.volid;
 stack.mock.vms.get(vmid).status='stopped';
 const backup=stack.mock.backups.get(archive);backup.cfg.cores=8;backup.cfg.memory=16384;backup.cfg.net0='virtio=00:00:00:11:22:33,bridge=old-bridge';backup.cfg.scsi0=backup.cfg.scsi0.replace(/^nvme:/,'old-storage:').replace('size=35G','size=20G');
 const r=await user.post(`/api/vms/${vmid}/backups/restore`,{id:archive,backupFirst:false,start:true});assert.equal(r.status,202,r.text);
 const j=await waitFor(()=>{const j=sql.prepare('SELECT * FROM backup_jobs WHERE id=?').get(r.json.id);return ['done','failed'].includes(j.state)?j:null;});assert.equal(j.state,'done',j.error);
 const vm=stack.mock.vms.get(vmid);assert.match(vm.cfg.scsi0,/^nvme:.*size=35G/);assert.equal(Number(vm.cfg.cores),1);assert.equal(Number(vm.cfg.memory),2048);assert.match(vm.cfg.net0,/bridge=vmbr0,tag=47,firewall=1/);assert.equal(vm.status,'running');
 assert.equal(sql.prepare("SELECT count(*) n FROM compute_allocation_events e JOIN compute_allocations a ON a.id=e.allocation_id WHERE a.vmid=? AND e.kind='restored'").get(vmid).n,1);
});
test('catalog restore rejects oversized archives and extra network interfaces before overwrite',async()=>{
 stack.mock.vms.get(vmid).status='stopped';const b=stack.mock.backups.get(archive),disk=b.cfg.scsi0;
 b.cfg.scsi0=disk.replace('size=20G','size=100G');assert.equal((await user.post(`/api/vms/${vmid}/backups/restore`,{id:archive,backupFirst:false})).status,409);b.cfg.scsi0=disk;
 b.cfg.net1='virtio,bridge=other';assert.equal((await user.post(`/api/vms/${vmid}/backups/restore`,{id:archive,backupFirst:false})).status,409);delete b.cfg.net1;
 assert.match(stack.mock.vms.get(vmid).cfg.scsi0,/size=35G/);
});
test('accepted catalog restore survives restart with one retained allocation',async()=>{
 stack.mock.cluster.restoreDelay=5000;
 const r=await user.post(`/api/vms/${vmid}/backups/restore`,{id:archive,backupFirst:false});assert.equal(r.status,202,r.text);
 const op=sql.prepare("SELECT id FROM compute_operations WHERE vmid=? AND kind='restored' ORDER BY rowid DESC LIMIT 1").get(vmid);
 await waitFor(()=>sql.prepare("SELECT 1 FROM compute_operation_steps WHERE operation_id=? AND name='restore' AND state='running'").get(op.id));
 await stack.restartPanel();
 const j=await waitFor(()=>{const j=sql.prepare('SELECT * FROM backup_jobs WHERE id=?').get(r.json.id);return ['done','failed'].includes(j.state)?j:null;});assert.equal(j.state,'done',j.error);
 assert.equal(sql.prepare('SELECT count(*) n FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').get(vmid).n,1);
 stack.mock.cluster.restoreDelay=1500;
});
