import { config } from './config.js';
import { db, audit } from './db.js';
import { pve, clusterGuests, guestPath, serial } from './pve.js';
import { haPolicy } from './compute-ha-policy.js';
import { computeProfile } from './compute-catalog.js';
import { computeInventory } from './compute-inventory.js';
import { selectPlacement } from './compute-placement.js';
import { allocationFor, assertComputeIdle, beginOperation, operationById, updateOperation, completeOperation, operationStep } from './compute-state.js';
import { lifecycleGuest, lifecycleStep, lifecycleFailed } from './compute-lifecycle.js';
import { requireCustomer } from './tenancy.js';
import { capacityBusy, capacityLocks } from './capacity.js';
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{statusCode});};
const resourcePath=vmid=>`/cluster/ha/resources/${encodeURIComponent(`vm:${vmid}`)}`;
const ruleId=vmid=>`pve-panel-${vmid}`;
const resources=()=>pve.get('/cluster/ha/resources');
const own=(r,allocation)=>r?.comment===`pve-panel:${allocation.id}`;
const matchesAffinity=(r,sid,nodes)=>r?.type==='node-affinity'
  && (r.strict===1||r.strict===true) && !r.disable && !Object.keys(r.errors??{}).length
  && r.resources===sid && String(r.nodes).split(',').sort().join(',')===[...nodes].sort().join(',')
  && (!r.affinity||r.affinity==='positive');
export async function assertNoHa(vmid) {
  const all=await resources();
  if(!Array.isArray(all)) fail('HA inventory is unavailable');
  if(all.some(r=>r.sid===`vm:${vmid}`)) fail('Disable HA before this operation');
}
export async function catalogPower(req,row,guest,action) {
  const a=allocationFor(row.vmid); if(!a) return null;
  const all=await resources();
  if(!Array.isArray(all)) fail('HA inventory is unavailable');
  const r=all.find(r=>r.sid===`vm:${row.vmid}`);
  if(!a.offering.haEnabled) {if(r) fail('Provider-managed HA must be reconciled before power operations');return null;}
  if(!own(r,a)) fail('HA ownership needs provider reconciliation');
  if(['start','reboot'].includes(action)) {
    const rules=await pve.get('/cluster/ha/rules');
    if(!Array.isArray(rules)||!matchesAffinity(rules.find(r=>r.rule===ruleId(row.vmid)),`vm:${row.vmid}`,a.offering.haAgreement?.nodes??[])) fail('HA affinity needs provider reconciliation before starting this VM');
  }
  if(action==='reboot') {
    if(r.state!=='started') fail('Start the HA resource before rebooting it');
    return {upid:await pve.post(`${guestPath(guest)}/status/reboot`)};
  }
  await pve.put(resourcePath(row.vmid),{state:action==='start'?'started':'stopped'});
  return {upid:null};
}
export async function setCustomerHa(req,row,input) {
  const customer=requireCustomer(req),a=allocationFor(row.vmid),policy=haPolicy();
  if(customer.role!=='admin') fail('Only customer administrators can change the HA add-on',403);
  if(!a || a.customer_id!==customer.id || !row.created_by_customer) fail('HA requires a customer catalog VM',403);
  assertComputeIdle(row.vmid);
  if(capacityBusy(customer.id)) fail('Wait until the current compute operation finishes');
  if(a.offering.haEnabled===input.enabled) fail('HA already has this setting');
  if(input.enabled && (!policy.enabled || !policy.infrastructureVerified || !computeProfile(customer.id).haAllowed)) fail('HA is not available for this customer',403);
  if(input.enabled && (input.policyRevision!==policy.revision || input.slaVersion!==policy.slaVersion || input.msaVersion!==policy.msaVersion || input.accept!==true)) fail('Accept the current HA SLA and MSA before enabling this add-on',400);
  capacityLocks.add(`customer:${customer.id}`);
  try {
    const guest=(await clusterGuests(true)).get(row.vmid);
    if(!guest || guest.type!=='qemu' || guest.status!=='stopped' || row.state!=='ready') fail('Stop the VM before changing its HA add-on');
    const cfg=await pve.get(`${guestPath(guest)}/config`),spec=JSON.parse(row.spec),pool=spec.pool??config.pve.pool;
    if(Object.keys(cfg).some(k=>/^(?:hostpci|usb)\d+$/.test(k)||['args','hookscript','ivshmem'].includes(k))) fail('This VM has host-specific devices or configuration');
    if(cfg.lock || guest.lock) fail('Wait until Proxmox unlocks the VM');
    const all=await resources(),r=all.find(r=>r.sid===`vm:${row.vmid}`);
    if(input.enabled && r) fail('This VM already has a Proxmox HA resource');
    if(!input.enabled && (!own(r,a) || r.state!=='stopped')) fail('Stop the panel-managed HA resource before disabling it');
    const perms=await pve.get('/access/permissions',{path:'/'});
    if(!perms?.['/']?.['Sys.Console'] || !perms?.['/']?.['Sys.Audit']) fail('The provider token needs Sys.Console and Sys.Audit for native HA');
    const diskKey=Object.keys(cfg).find(k=>/^(scsi|sata|virtio|ide)\d+$/.test(k)&&!/media=cdrom|cloudinit/.test(String(cfg[k]))),storage=String(cfg[diskKey]).split(':')[0];
    const offering={...a.offering,haEnabled:input.enabled,...(input.enabled?{haAgreement:{policyRevision:policy.revision,slaVersion:policy.slaVersion,msaVersion:policy.msaVersion,acceptedBy:req.account.id,acceptedAt:new Date().toISOString(),nodes:policy.nodes}}:{})};
    const op=await serial(async()=>{
      let plan;
      if(input.enabled) {
        const [inventory,status,cluster]=await Promise.all([computeInventory(),pve.get('/cluster/ha/status/current'),pve.get('/cluster/status')]);
        if(!cluster.some(c=>c.type==='cluster'&&(c.quorate===1||c.quorate===true))) fail('Cluster quorum cannot be verified');
        if(!policy.nodes.includes(guest.node)) fail('Move the VM to the verified HA nodes first');
        for(const node of policy.nodes) {
          const n=inventory.nodes.find(n=>n.node===node);
          if(!n || n.status!=='online' || !status.some(s=>s.type==='lrm'&&s.node===node&&s.status==='active')) fail('Every verified HA node must have an active local resource manager');
          for(const [k,v] of Object.entries(cfg)) if(/^(?:(?:scsi|sata|virtio|ide)\d+|efidisk0|tpmstate0)$/.test(k)&&!String(v).startsWith('none')) {
            if(!n.storages.some(s=>s.storage===String(v).split(':')[0]&&s.shared===true&&s.active===true)) fail('All VM volumes, including cloud-init, must be shared across the HA nodes');
          }
          const candidate=await selectPlacement({offering,template:guest,sourceConfig:cfg,pool,existing:{vmid:row.vmid,node,storage,diskGb:offering.diskGb}});
          if(node===guest.node) plan=candidate;
        }
        if(haPolicy().revision!==policy.revision || !computeProfile(customer.id).haAllowed) fail('HA offerings changed. Try again.');
      } else {
        plan={node:guest.node,storage,storageKey:`shared/${storage}`,cores:offering.cores,memoryMb:offering.memoryMb,diskGb:offering.diskGb,pool,offering};
      }
      return beginOperation({customerId:customer.id,userId:req.account.id,vmid:row.vmid,kind:input.enabled?'ha-enabled':'ha-disabled',plan:{...plan,offering,reserveDiskGb:0,haNodes:input.enabled?policy.nodes:a.offering.haAgreement?.nodes},onReserve:id=>{
        db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Configuring HA',spec=? WHERE vmid=?").run(JSON.stringify({...spec,operationId:id}),row.vmid);
        if(input.enabled) for(const node of policy.nodes) db.prepare("INSERT INTO compute_ha_reservations(vmid,node,cores,memory_mb,state) VALUES(?,?,?,?,'held') ON CONFLICT(vmid,node) DO UPDATE SET cores=excluded.cores,memory_mb=excluded.memory_mb,state='held'").run(row.vmid,node,offering.cores,offering.memoryMb);
      }});
    });
    runHaOperation(op.id);
    return {accepted:true,operationId:op.id};
  } finally {capacityLocks.delete(`customer:${customer.id}`);}
}
export async function runHaOperation(id) {
  const op=operationById(id),a=allocationFor(op.vmid),enabled=op.plan.offering.haEnabled,sid=`vm:${op.vmid}`;
  try {
    const row=db.prepare('SELECT spec FROM vms WHERE vmid=? AND customer_id=?').get(op.vmid,op.customer_id);
    if(!row || JSON.parse(row.spec??'{}').operationId!==id) fail('VM ownership needs reconciliation');
    db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Configuring HA' WHERE vmid=?").run(op.vmid);
    const {guest}=await lifecycleGuest(op);
    if(guest.status!=='stopped') fail('Stop the VM before resuming HA configuration');
    db.prepare("UPDATE vms SET state='creating',error=NULL,progress='Configuring HA' WHERE vmid=?").run(op.vmid);
    updateOperation(id,'configuring');
    const current=()=>resources().then(all=>all.find(r=>r.sid===sid));
    if(enabled) {
      await lifecycleStep(id,'ha-register',async()=>{
        if(await current()) fail('This HA resource already exists');
        return pve.post('/cluster/ha/resources',{sid,state:'stopped',comment:`pve-panel:${a.id}`});
      },async()=>{const r=await current();return own(r,a)&&r.state==='stopped';});
      const wanted=()=>pve.get('/cluster/ha/rules').then(all=>all.find(r=>r.rule===ruleId(op.vmid)));
      const matches=r=>matchesAffinity(r,sid,op.plan.haNodes);
      await lifecycleStep(id,'ha-affinity',async()=>{
        if(await wanted()) fail('The HA rule ID is already in use');
        return pve.post('/cluster/ha/rules',{rule:ruleId(op.vmid),type:'node-affinity',resources:sid,nodes:op.plan.haNodes.join(','),strict:1});
      },async()=>matches(await wanted()));
      if(!matches(await wanted())) fail('HA affinity needs reconciliation');
    } else {
      await lifecycleStep(id,'ha-remove',async()=>{
        const r=await current();if(!own(r,a)||r.state!=='stopped') fail('HA ownership or requested state changed');
        return pve.del(resourcePath(op.vmid));
      },async()=>!await current());
      const rules=await pve.get('/cluster/ha/rules');
      if(rules.some(r=>r.rule===ruleId(op.vmid))) fail('The provider must remove the stale panel HA affinity rule');
    }
    completeOperation(id,()=>{
      const spec=JSON.parse(db.prepare('SELECT spec FROM vms WHERE vmid=?').get(op.vmid).spec);
      db.prepare("UPDATE vms SET state='ready',error=NULL,progress=NULL,spec=? WHERE vmid=?").run(JSON.stringify({...spec,offering:op.plan.offering}),op.vmid);
      if(!enabled) db.prepare("UPDATE compute_ha_reservations SET state='released' WHERE vmid=?").run(op.vmid);
    });
    audit({account:{id:op.user_id},customerId:op.customer_id,ip:'compute'},op.vmid,op.kind,{operationId:id,agreement:op.plan.offering.haAgreement});
  } catch(err) {lifecycleFailed(id,err);}
}
