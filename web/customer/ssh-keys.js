import { api, esc, confirmAction } from '/shared/ui.js';
export async function renderSshKeys(host) {
  host.innerHTML='<section class="security-card"><h2>SSH keys</h2><p>Loading saved keys…</p></section>';
  try {
    const {keys}=await api('/api/ssh-keys');
    if (!host.isConnected) return;
    host.innerHTML=`<section class="security-card"><h2>SSH keys</h2><p class="hint">Save public keys for new servers. Removing a saved key does not remove it from existing servers.</p><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Fingerprint</th><th>Actions</th></tr></thead><tbody>${keys.map(k=>`<tr><td>${esc(k.name)}</td><td class="mono small">${esc(k.fingerprint)}</td><td><button class="btn" data-remove-key="${k.id}">Remove</button></td></tr>`).join('')||'<tr><td colspan="3">No saved SSH keys.</td></tr>'}</tbody></table></div><form class="settings" data-add-key><label>Key name<input name="name" required maxlength="80" placeholder="Work laptop"></label><label>SSH public key<textarea name="publicKey" required rows="3" maxlength="16000" spellcheck="false" placeholder="ssh-ed25519 AAAA…"></textarea></label><button class="btn primary">Save SSH key</button><p class="form-error" role="alert"></p></form></section>`;
    const error=host.querySelector('.form-error');
    host.querySelector('[data-add-key]').onsubmit=async e=>{
      e.preventDefault();const f=e.currentTarget,button=f.querySelector('button');button.disabled=true;error.textContent='';
      try {await api('/api/ssh-keys',{method:'POST',body:{name:f.elements.name.value,publicKey:f.elements.publicKey.value}});await renderSshKeys(host);}catch(err){error.textContent=err.message;}finally{button.disabled=false;}
    };
    host.querySelectorAll('[data-remove-key]').forEach(b=>{b.onclick=async()=>{
      if (!await confirmAction('Remove this saved SSH key? Existing servers keep their installed keys.','Remove key')) return;
      b.disabled=true;try{await api(`/api/ssh-keys/${b.dataset.removeKey}`,{method:'DELETE'});await renderSshKeys(host);}catch(err){error.textContent=err.message;b.disabled=false;}
    };});
  } catch(err){if(host.isConnected)host.textContent=err.message;}
}
