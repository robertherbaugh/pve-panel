import { db, audit } from './db.js';
import { pve, waitTask, bootDiskKey, diskSizeGb, invalidateGuestCache } from './pve.js';
import { operationById, operationStep, updateOperation, completeOperation } from './compute-state.js';
import { lifecycleGuest, lifecycleStep, lifecycleFailed } from './compute-lifecycle.js';

export async function runCatalogRestore(id) {
  const op=operationById(id), wanted=op.plan.offering;
  if(op.state==='complete') return true;
  try {
    const row=db.prepare('SELECT spec FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid,op.customer_id);
    if (!row || JSON.parse(row.spec??'{}').operationId!==id) throw new Error('VM ownership needs reconciliation');
    db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Restoring backup' WHERE vmid=?").run(op.vmid);
    updateOperation(id,'restoring');
    for (const name of ['restore','configuration','disk-growth','start']) {
      const step=operationStep(id,name); if (step?.upid && step.state!=='complete') await waitTask(step.task_node,step.upid);
    }
    const {path,guest}=await lifecycleGuest(op), cfg=()=>pve.get(`${path}/config`);
    if (!operationStep(id,'restore')) {
      if (guest.status!=='stopped') throw new Error('Stop the VM before restoring');
    }
    await lifecycleStep(id,'restore',()=>pve.post(`/nodes/${encodeURIComponent(op.plan.node)}/qemu`,{vmid:op.vmid,archive:op.plan.volid,force:1,storage:op.plan.storage}));
    const disk=bootDiskKey(await cfg());
    if (!String((await cfg())[disk]).startsWith(`${op.plan.storage}:`)) throw new Error('Restored disk is outside its reserved storage class');
    await lifecycleStep(id,'configuration',()=>pve.put(`${path}/config`,{cores:wanted.cores,sockets:1,memory:wanted.memoryMb,net0:op.plan.net0}),async()=>{
      const c=await cfg();return Number(c.cores)*Number(c.sockets??1)===wanted.cores && Number(c.memory)===wanted.memoryMb && c.net0===op.plan.net0;
    });
    const diskStep=operationStep(id,'disk-growth');
    if (diskSizeGb((await cfg())[disk])<wanted.diskGb || diskStep) await lifecycleStep(id,'disk-growth',()=>pve.put(`${path}/resize`,{disk,size:`${wanted.diskGb}G`}),async()=>diskSizeGb((await cfg())[disk])===wanted.diskGb);
    if (diskSizeGb((await cfg())[disk])!==wanted.diskGb) throw new Error('Restored disk capacity needs reconciliation');
    const final=await cfg();
    if (Number(final.cores)*Number(final.sockets??1)!==wanted.cores || Number(final.memory)!==wanted.memoryMb || final.net0!==op.plan.net0) throw new Error('Restored configuration needs reconciliation');
    if (op.plan.start) await lifecycleStep(id,'start',()=>pve.post(`${path}/status/start`),async()=>(await pve.get(`${path}/status/current`)).status==='running');
    completeOperation(id,()=>db.prepare("UPDATE vms SET state='ready',error=NULL,progress=NULL WHERE vmid=?").run(op.vmid));
    audit({account:{id:op.user_id},customerId:op.customer_id,ip:'compute'},op.vmid,'backup_restored',{backup:op.plan.volid,operationId:id});
    return true;
  } catch(err) {lifecycleFailed(id,err);return false;}
  finally {invalidateGuestCache();}
}
