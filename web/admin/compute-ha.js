export async function renderHaPolicy(host,{api,esc}) {
  try {
    const [p,inventory]=await Promise.all([api('/api/admin/compute-ha-policy'),api('/api/admin/compute-catalog/inventory')]);
    if(!host.isConnected)return;
    host.innerHTML=`<section class="security-card"><h3>Native Proxmox HA</h3><p class="muted">HA is an optional add-on in every tier. It starts disabled. Verified shared storage and spare compute capacity are required.</p><form class="create-form">
      <label class="check"><input name="enabled" type="checkbox" ${p.enabled?'checked':''}>Offer the HA add-on</label>
      <fieldset><legend>Verified HA nodes</legend>${[...new Set([...inventory.nodes.map(n=>n.node),...p.nodes])].map(n=>`<label class="check"><input type="checkbox" name="nodes" value="${esc(n)}" ${p.nodes.includes(n)?'checked':''}>${esc(n)}</label>`).join('')}</fieldset>
      <div class="grid-2"><label>SLA version<input name="sla" maxlength="100" value="${esc(p.slaVersion)}"></label><label>MSA version<input name="msa" maxlength="100" value="${esc(p.msaVersion)}"></label></div>
      <label>HA add-on terms<textarea name="terms" rows="5" maxlength="12000">${esc(p.terms)}</textarea></label>
      <label class="check"><input name="verified" type="checkbox" ${p.infrastructureVerified?'checked':''}>I verified quorum, watchdog/fencing, compatible CPUs, redundant shared storage, guest network isolation and failover connectivity on these nodes.</label>
      <p class="hint">The panel reserves each HA VM's CPU and memory on every verified node. Proxmox manages failover within a strict node affinity rule. Existing cluster rules and SDN configuration stay under provider control.</p>
      <button class="btn primary">Save HA policy</button><p data-status role="status"></p></form></section>`;
    const f=host.querySelector('form');f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;
      try {const saved=await api('/api/admin/compute-ha-policy',{method:'PUT',body:{revision:p.revision,enabled:f.enabled.checked,nodes:[...f.querySelectorAll('[name=nodes]:checked')].map(n=>n.value),slaVersion:f.sla.value,msaVersion:f.msa.value,terms:f.terms.value,infrastructureVerified:f.verified.checked}});Object.assign(p,saved);host.querySelector('[data-status]').textContent='HA policy saved.';}
      catch(err){host.querySelector('[data-status]').textContent=err.message;}finally{b.disabled=false;}
    };
  }catch(err){host.textContent=err.message;}
}
