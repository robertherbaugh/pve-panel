import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startStack, waitFor } from '../support/stack.mjs';
let stack, admin, user, id, sql;
const vmid=101;
async function profile(patch) {
 const p=(await admin.get(`/api/admin/customers/${id}/compute-profile`)).json;
 const c=(await admin.get('/api/admin/compute-catalog')).json;
 const {revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb,catalogEnabled,network}=p;
 const r=await admin.put(`/api/admin/customers/${id}/compute-profile`,{revision,catalogRevision:c.revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb,catalogEnabled,network,...patch});
 assert.equal(r.status,200,r.text);return r.json;
}
async function basic(enabled) {
 const c=(await admin.get('/api/admin/compute-catalog')).json;
 c.classes[0].enabled=enabled;c.classes[0].bindings=[{node:'pve1',storage:'pbs',purpose:'backup'}];
 const r=await admin.put('/api/admin/compute-catalog',{revision:c.revision,sizes:c.sizes,classes:c.classes.map(({id,enabled,bindings})=>({id,enabled,bindings})),reserves:c.reserves});assert.equal(r.status,200,r.text);
}
async function backup() {
 const r=await user.post(`/api/vms/${vmid}/backups`);assert.equal(r.status,202,r.text);
 return waitFor(()=>{const j=sql.prepare('SELECT * FROM backup_jobs WHERE id=?').get(r.json.id);return ['done','failed'].includes(j.state)?j:null;});
}
before(async()=>{
 stack=await startStack({env:{CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false',SETUP_CHECK_HOURS:'0',BACKUP_TICK_SECONDS:'1'}});admin=await stack.adminSession();
 user=await stack.customerWith('catalog-backups@example.com',{limits:{}});
 await admin.put('/api/admin/vms/101',{userId:user.userId});
 id=(await admin.get('/api/admin/customers')).json.customers.find(c=>c.name==='catalog-backups@example.com').id;
 sql=new DatabaseSync(path.join(stack.dir,'panel.db'));
 stack.mock.cluster.storageInventories={pve1:[{storage:'pbs',type:'pbs',content:'backup',active:1,enabled:1,shared:1,avail:1000*2**30,total:2000*2**30}]};
 assert.equal((await admin.put('/api/admin/settings/backups',{enabled:true,storage:'pbs',maxPerServer:10})).status,200);
 await basic(true);await profile({catalogEnabled:true,tier:'ridge',backupLimitGb:40});
});
after(async()=>{sql?.close();await stack?.stop();});
test('including the service fee never selects the backup add-on or grants schedule creation',async()=>{
 assert.equal((await user.post(`/api/vms/${vmid}/backups`)).status,403);
 assert.equal((await user.put(`/api/vms/${vmid}/backups/schedule`,{frequency:'daily',hour:1,minute:0,keep:1})).status,403);
 const info=(await user.get(`/api/vms/${vmid}/backups`)).json;
 assert.equal(info.available,true);assert.equal(info.canCreate,false);
 await profile({backupServiceEnabled:true});
});
let first;
test('catalog backups reserve logical disk capacity on Basic and enforce the shared customer limit',async()=>{
 first=await backup();assert.equal(first.state,'done',first.error);
 const hold=sql.prepare('SELECT * FROM compute_backup_reservations WHERE job_id=?').get(first.id);
 assert.equal(hold.storage,'pbs');assert.equal(hold.state,'retained');assert.equal(hold.reserved_bytes,20*2**30);assert.ok(hold.archive_bytes>0);
 assert.match(stack.mock.backups.get(first.volid).notes,new RegExp(`pve-panel-backup:${first.id}:`));
 const second=await backup();assert.equal(second.state,'done',second.error);
 const third=await backup();assert.equal(third.state,'failed');assert.match(third.error,/storage limit/);
 assert.equal((await user.get('/api/compute-backup-usage')).json.reservedBytes,40*2**30);
 assert.equal((await user.req('DELETE',`/api/vms/${vmid}/backups?id=${encodeURIComponent(second.volid)}`)).status,204);
 assert.equal((await user.get('/api/compute-backup-usage')).json.reservedBytes,20*2**30);
});
test('disabled Basic mappings prevent new dumps, including jobs queued by the scheduler',async()=>{
 await basic(false);const before=stack.mock.backups.size;
 const denied=await backup();assert.equal(denied.state,'failed');assert.match(denied.error,/Basic/);assert.equal(stack.mock.backups.size,before);
 const anchor=sql.prepare('SELECT max(id) id FROM backup_jobs').get().id;
 assert.equal((await user.put(`/api/vms/${vmid}/backups/schedule`,{frequency:'daily',hour:1,minute:0,keep:1})).status,200);
 sql.prepare("UPDATE backup_schedules SET next_run_at='2000-01-01T00:00:00Z' WHERE vmid=?").run(vmid);
 const scheduled=await waitFor(()=>sql.prepare("SELECT * FROM backup_jobs WHERE vmid=? AND id>? AND kind='scheduled' AND state='failed'").get(vmid,anchor));
 assert.match(scheduled.error,/Basic/);assert.equal(stack.mock.backups.size,before);
 await user.put(`/api/vms/${vmid}/backups/schedule`,{frequency:'off'});
 await basic(true);
});
test('an unknown backup outcome holds its quota and discovers the tagged archive without another dump',async()=>{
 stack.mock.cluster.loseBackupResponse=true;
 const lost=await backup();assert.equal(lost.state,'failed');
 assert.equal(sql.prepare('SELECT state FROM compute_backup_reservations WHERE job_id=?').get(lost.id).state,'held');
 await waitFor(()=>[...stack.mock.backups.values()].find(b=>b.notes.includes(`pve-panel-backup:${lost.id}:`)));
 assert.equal((await admin.post(`/api/admin/compute-backup-reservations/${lost.id}/reconcile`)).status,200);
 assert.equal(sql.prepare('SELECT state FROM compute_backup_reservations WHERE job_id=?').get(lost.id).state,'retained');
 const peer=await stack.customerWith('backup-peer@example.com');
 assert.equal((await peer.get('/api/compute-backup-usage')).json.reservedBytes,0);
 assert.equal((await peer.get('/api/admin/compute-backup-reservations')).status,404);
});
test('retained backup reservations survive VM deletion and panel restart',async()=>{
 assert.equal((await admin.put('/api/admin/settings/backups',{keepAfterDelete:true})).status,200);
 const r=await admin.del('/api/admin/vms/101/server');
 assert.equal(r.status,202,r.text);
 await waitFor(()=>!stack.mock.vms.has(vmid));
 await stack.restartPanel();
 assert.equal((await user.get('/api/compute-backup-usage')).json.reservedBytes,40*2**30);
 assert.ok(stack.mock.backups.has(first.volid));
});
