import {api,esc} from '/shared/ui.js';
export async function configureHa(vm,onSave) {
  const p=await api('/api/compute-ha-policy'),enabled=!vm.offering.haEnabled,d=document.createElement('dialog');
  d.className='access-rule-modal';d.setAttribute('aria-label',enabled?'Enable HA add-on':'Disable HA add-on');
  d.innerHTML=`<form class="create-form"><h2>${enabled?'Enable':'Disable'} HA for ${esc(vm.name)}</h2><p>The VM must be stopped before this change.</p>
    ${enabled?`${!p.enabled?'<p class="notice warn">HA is not available for this customer. Your provider must enable the add-on first.</p>':''}<p>HA restarts this VM after a host failure. It does not eliminate downtime or replace backups.</p><p>SLA: ${esc(p.slaVersion)} · MSA: ${esc(p.msaVersion)}</p><pre class="ha-terms">${esc(p.terms)}</pre><label class="check"><input name="accept" type="checkbox" required>I accept these SLA and MSA terms for this HA add-on.</label>`:'<p>Automatic recovery after host failure will end. The VM stays stopped.</p>'}
    <p data-error class="form-error" role="alert"></p><div class="row"><button class="btn primary" ${enabled&&!p.enabled?'disabled':''}>${enabled?'Enable HA':'Disable HA'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
  document.body.append(d);d.addEventListener('close',()=>d.remove(),{once:true});d.querySelector('[data-close]').onclick=()=>d.close();
  d.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=d.querySelector('button');b.disabled=true;
    try{await api(`/api/vms/${vm.vmid}/ha`,{method:'POST',body:{enabled,...(enabled?{policyRevision:p.revision,slaVersion:p.slaVersion,msaVersion:p.msaVersion,accept:d.querySelector('[name=accept]').checked}:{})}});d.close();await onSave();}
    catch(err){d.querySelector('[data-error]').textContent=err.message;b.disabled=false;}
  };d.showModal();
}
