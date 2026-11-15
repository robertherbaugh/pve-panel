import {api,esc} from '/shared/ui.js';
export async function renderComputeServices(host) {
  let data;
  try {data=await api('/api/compute-services');}catch(err){host.textContent=err.message;return;}
  if(!host.isConnected || !data.enabled) return;
  host.innerHTML=`<section class="security-card"><h2>Customer add-ons</h2><p class="muted">Service tier: ${esc(data.tier)}. Backup archives use Basic storage.</p><form>
    <label class="check"><input name="backups" type="checkbox" ${data.backupServiceEnabled?'checked':''} ${data.canManage?'':'disabled'}>Backup service</label>
    <p class="hint">${data.backupServiceIncluded?'Your tier includes the backup service fee.':'The backup service is an optional add-on.'} Backup storage is separate${data.backupLimitGb?`, with a ${data.backupLimitGb} GiB limit`:''}.</p>
    <p class="hint">Turning this off removes automatic schedules and new backups. Existing archives remain available and continue to reserve storage. Turning it on does not enable a schedule.</p>
    ${data.canManage?'<button class="btn primary">Save add-ons</button>':'<p class="muted">A customer administrator manages add-ons.</p>'}<p role="status" data-status></p></form></section>`;
  const form=host.querySelector('form');
  form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;
    try{data=await api('/api/compute-services',{method:'PUT',body:{revision:data.revision,backupServiceEnabled:form.backups.checked}});host.querySelector('[data-status]').textContent='Customer add-ons saved.';}
    catch(err){host.querySelector('[data-status]').textContent=err.message;}finally{button.disabled=false;}
  };
}
