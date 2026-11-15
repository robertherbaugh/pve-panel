import { db, audit } from './db.js';
import { pve, clusterGuests, guestPath, waitTask, bootDiskKey, diskSizeGb, invalidateGuestCache } from './pve.js';
import { operationById, updateOperation, completeOperation, operationStep, setOperationStep } from './compute-state.js';

const fail = message => { throw new Error(message); };
// Absolute configuration writes can be verified after an interrupted response.
// A task submission without a recorded response is never submitted a second time.
export async function lifecycleStep(id, name, submit, verify = null) {
  const step = operationStep(id, name);
  if (step?.state === 'complete') return;
  if (step?.upid) await waitTask(step.task_node, step.upid);
  else if (step) {
    if (!verify || !await verify()) fail(`The ${name} outcome needs provider reconciliation`);
  } else {
    setOperationStep(id, name, 'submitting');
    const op = operationById(id), upid = await submit();
    if (typeof upid === 'string' && upid.startsWith('UPID:')) {
      setOperationStep(id, name, 'running', upid, op.plan.node);
      await waitTask(op.plan.node, upid);
    }
  }
  if (verify && !await verify()) fail(`The ${name} result does not match its reservation`);
  setOperationStep(id, name, 'complete');
}
export async function lifecycleGuest(op) {
  const row = db.prepare('SELECT * FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid,op.customer_id);
  if (!row || JSON.parse(row.spec ?? '{}').operationId !== op.id) fail('VM ownership needs reconciliation');
  const guest = (await clusterGuests(true)).get(op.vmid);
  if (!guest || guest.node !== op.plan.node || guest.type !== 'qemu' || guest.template) fail('VM placement needs reconciliation');
  const cfg = await pve.get(`${guestPath(guest)}/config`);
  if (cfg.lock || guest.lock) fail('Wait until Proxmox unlocks this VM');
  const pool = await pve.get(`/pools/${encodeURIComponent(op.plan.pool)}`);
  if (!pool.members?.some(m => Number(m.vmid) === op.vmid && m.type === 'qemu')) fail('VM pool membership needs reconciliation');
  if (!String(cfg[bootDiskKey(cfg)] ?? '').startsWith(`${op.plan.storage}:`)) fail('VM storage no longer matches its reservation');
  return { row, guest, cfg, path: guestPath(guest) };
}
export function lifecycleFailed(id, err) {
  const message = String(err.message ?? err).slice(0,500), op = operationById(id);
  updateOperation(id,'review',{error:message});
  db.prepare("UPDATE vms SET state='failed',error=?,progress=NULL WHERE vmid=?").run(message,op.vmid);
}
export async function runCatalogResize(id) {
  const op = operationById(id);
  try {
    const row=db.prepare('SELECT spec FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid,op.customer_id);
    if (!row || JSON.parse(row.spec??'{}').operationId!==id) fail('VM ownership needs reconciliation');
    db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Changing size' WHERE vmid=?").run(op.vmid);
    for (const name of ['configuration','disk-growth']) { const step=operationStep(id,name); if (step?.upid && step.state!=='complete') await waitTask(step.task_node,step.upid); }
    const { path } = await lifecycleGuest(op), wanted = op.plan.offering;
    if ((await pve.get(`${path}/status/current`)).status !== 'stopped') fail('Stop the VM before resuming resize');
    updateOperation(id,'configuring');
    const cfg = () => pve.get(`${path}/config`);
    await lifecycleStep(id,'configuration',() => pve.put(`${path}/config`,{cores:wanted.cores,sockets:1,memory:wanted.memoryMb}),async () => {
      const c=await cfg(); return Number(c.cores)*Number(c.sockets??1)===wanted.cores && Number(c.memory)===wanted.memoryMb;
    });
    const disk = bootDiskKey(await cfg());
    if (diskSizeGb((await cfg())[disk]) < wanted.diskGb) {
      await lifecycleStep(id,'disk-growth',() => pve.put(`${path}/resize`,{disk,size:`${wanted.diskGb}G`}),async () => diskSizeGb((await cfg())[disk])===wanted.diskGb);
    } else if (operationStep(id,'disk-growth')?.upid) {
      await lifecycleStep(id,'disk-growth',null,async () => diskSizeGb((await cfg())[disk])===wanted.diskGb);
    }
    if (diskSizeGb((await cfg())[disk])!==wanted.diskGb) fail('The disk size needs reconciliation');
    completeOperation(id,() => {
      const row=db.prepare('SELECT spec FROM vms WHERE vmid=?').get(op.vmid), spec=JSON.parse(row.spec);
      db.prepare("UPDATE vms SET state='ready',error=NULL,progress=NULL,spec=? WHERE vmid=?").run(JSON.stringify({...spec,...wanted,offering:wanted}),op.vmid);
    });
    audit({account:{id:op.user_id},customerId:op.customer_id,ip:'compute'},op.vmid,'server_resized',{operationId:id,offering:wanted});
  } catch(err) { lifecycleFailed(id,err); }
  finally { invalidateGuestCache(); }
}
