export async function renderRemoteAccess(host,{api,esc,onSave}) {
  try {
    const p=await api('/api/admin/remote-access');if(!host.isConnected)return;
    host.innerHTML=`<section class="security-card"><h3>Private access enrollment</h3><p class="hint">Provider configuration and status are also available under Private Access.</p><p class="muted">Customers connect a VM with a key scoped to their account. Existing connections stay on their current control server until reconnected.</p><form class="create-form">
      <label>Control server<select name="provider"><option value="tailscale" ${p.provider==='tailscale'?'selected':''}>Tailscale</option><option value="headscale" ${p.provider==='headscale'?'selected':''}>Headscale</option></select></label>
      <label>Headscale HTTPS URL<input name="loginServer" type="url" value="${esc(p.loginServer)}" placeholder="https://headscale.rcadea.cloud"></label>
      <p class="hint">The guest uses the Tailscale client with this login server. Scope Headscale users, keys and ACLs to each customer. This does not change guest bridges, VLANs or Proxmox SDN.</p>
      <button class="btn primary">Save private access</button><p data-status role="status"></p></form></section>`;
    const f=host.querySelector('form');f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;
      try{await api('/api/admin/remote-access',{method:'PUT',body:{provider:f.provider.value,loginServer:f.loginServer.value}});host.querySelector('[data-status]').textContent='Private access settings saved.';await onSave?.();}
      catch(err){host.querySelector('[data-status]').textContent=err.message;}finally{b.disabled=false;}
    };
  }catch(err){host.textContent=err.message;}
}
