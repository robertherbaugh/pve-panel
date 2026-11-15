import { db, audit } from './db.js';
import { pve, waitTask } from './pve.js';
import { requireCustomer } from './tenancy.js';
import { computeInventory } from './compute-inventory.js';
import { releaseBackupVolume } from './compute-backups.js';
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};
const orphan=`NOT EXISTS(SELECT 1 FROM vms v WHERE v.vmid=r.vmid AND v.customer_id=r.customer_id)`;
const admin=req=>{const c=requireCustomer(req);if(c.role!=='admin')fail('Only customer administrators manage retained archives',403);return c;};
export default async function retainedBackupRoutes(app) {
  app.addHook('preHandler',app.authenticate);
  app.get('/api/retained-backups',async req=>{
    const c=admin(req);
    return {archives:db.prepare(`SELECT r.job_id AS id,r.vmid,r.volid AS archive,r.reserved_bytes AS reservedBytes,r.archive_bytes AS archiveBytes,r.created_at AS createdAt FROM compute_backup_reservations r WHERE r.customer_id=? AND r.state='retained' AND ${orphan} ORDER BY r.created_at DESC`).all(c.id)};
  });
  app.delete('/api/retained-backups/:id',async(req,reply)=>{
    const c=admin(req),hold=db.prepare(`SELECT r.* FROM compute_backup_reservations r WHERE r.job_id=? AND r.customer_id=? AND r.state='retained' AND ${orphan}`).get(req.params.id,c.id);
    if(!hold)fail('Retained archive not found',404);
    const perms=await pve.get('/access/permissions',{path:`/storage/${hold.storage}`});
    if(!perms?.[`/storage/${hold.storage}`]?.['Datastore.Audit'])fail('The provider must grant datastore audit before archive deletion can be verified');
    const inventory=await computeInventory(),shared=hold.storage_key===`shared/${hold.storage}`;
    const node=inventory.nodes.find(n=>n.status==='online'&&(n.node===hold.node||shared)&&n.storages.some(s=>s.storage===hold.storage&&s.active===true&&(!shared||s.shared===true)));
    if(!node)fail('The retained archive storage is unavailable. Its reservation remains held.');
    const path=`/nodes/${encodeURIComponent(node.node)}/storage/${encodeURIComponent(hold.storage)}/content`;
    const read=()=>pve.get(path,{content:'backup',vmid:hold.vmid});
    const found=(await read()).find(b=>b.volid===hold.volid);
    if(found?.protected)fail('This backup is protected',403);
    if(found && Number(found.vmid)!==hold.vmid)fail('Archive identity needs provider reconciliation');
    if(admin(req).id!==c.id)fail('Customer context changed',403);
    // This endpoint handles archives after VM deletion, never bypasses live VM permissions.
    if(!db.prepare(`SELECT 1 FROM compute_backup_reservations r WHERE r.job_id=? AND ${orphan}`).get(hold.job_id))fail('The VM ownership changed');
    if(found) {
      try {await waitTask(node.node,await pve.del(`${path}/${encodeURIComponent(hold.volid)}`),600000);}
      catch(err){if((await read()).some(b=>b.volid===hold.volid))throw err;}
    }
    if((await read()).some(b=>b.volid===hold.volid))fail('Archive deletion could not be verified. Its reservation remains held.');
    releaseBackupVolume(hold.volid);
    db.prepare('DELETE FROM backups WHERE volid=? AND customer_id=?').run(hold.volid,c.id);
    audit(req,hold.vmid,'retained_backup_deleted',{archive:hold.volid});
    return reply.code(204).send();
  });
}
