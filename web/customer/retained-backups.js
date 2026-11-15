import {api,esc,bytes,confirmAction} from '/shared/ui.js';
export async function renderRetainedBackups(host) {
  try {
    const {archives}=await api('/api/retained-backups');if(!host.isConnected)return;
    host.innerHTML=`<section class="security-card"><h2>Retained backups</h2><p class="muted">Archives from deleted VMs still reserve Basic backup storage. Deleting an archive is permanent.</p><div class="table-wrap"><table class="table"><thead><tr><th>VM / Archive</th><th>Reserved</th><th>Created</th><th>Action</th></tr></thead><tbody>${archives.map(a=>`<tr><td>${a.vmid}<span class="access-block mono small">${esc(a.archive)}</span></td><td>${bytes(a.reservedBytes)}</td><td>${esc(a.createdAt)}</td><td><button class="btn danger" data-delete="${a.id}">Delete archive</button></td></tr>`).join('')||'<tr><td colspan="4">No retained archives from deleted VMs.</td></tr>'}</tbody></table></div><p data-status role="status"></p></section>`;
    host.querySelectorAll('[data-delete]').forEach(b=>{b.onclick=async()=>{
      if(!await confirmAction('Permanently delete this retained backup archive?','Delete archive'))return;b.disabled=true;
      try{await api(`/api/retained-backups/${b.dataset.delete}`,{method:'DELETE'});await renderRetainedBackups(host);}
      catch(err){host.querySelector('[data-status]').textContent=err.message;b.disabled=false;}
    };});
  }catch(err){host.textContent=err.message;}
}
