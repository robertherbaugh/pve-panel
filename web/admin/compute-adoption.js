export async function renderAdoption(host, { api, esc, catalog, customers }) {
  try {
    const { vms } = await api('/api/admin/compute-adoption');
    if (!host.isConnected) return;
    host.innerHTML = `<section class="security-card"><h3>Adopt an existing VM</h3>
      <p class="muted">Assign the VM to its customer first. Adoption records its current size and storage reservation and enables customer resize, reinstall and deletion. It preserves guest data and credentials.</p>
      <form class="create-form"><label>Assigned VM<select name="vmid" required><option value="">Choose a VM</option>${vms.map(v => `<option value="${v.vmid}">${v.vmid} — ${esc(v.name)} · ${esc(customers.find(c => c.id === v.customerId)?.name ?? 'Unknown customer')} · ${esc(v.node)} · ${esc(v.status)}</option>`).join('')}</select></label>
      <div class="grid-2"><label>Matching VM size<select name="sizeId">${catalog.sizes.filter(s => s.enabled).map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${s.cores} vCPU · ${s.memoryMb/1024} GiB</option>`).join('')}</select></label>
      <label>Existing storage class<select name="storageClassId">${catalog.classes.filter(c => c.enabled).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <label>Confirm VM name<input name="confirmName" required autocomplete="off"></label>
      <p class="hint">The VM must be stopped, match the customer's verified network, and use a mapped datastore. Review the customer's permissions before enabling lifecycle control.</p>
      <button class="btn primary">Adopt VM</button><p role="status" data-status></p></form></section>`;
    const form = host.querySelector('form');
    form.onsubmit = async e => {
      e.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try {
        const vm = vms.find(v => v.vmid === Number(form.vmid.value));
        if (!vm) throw new Error('Choose an assigned VM');
        const p = await api(`/api/admin/customers/${vm.customerId}/compute-profile`);
        await api(`/api/admin/compute-adoption/${vm.vmid}`, { method: 'POST', body: {
          customerId: vm.customerId, sizeId: form.sizeId.value, storageClassId: form.storageClassId.value,
          confirmName: form.confirmName.value, catalogRevision: catalog.revision, profileRevision: p.revision,
        } });
        form.querySelector(`option[value="${vm.vmid}"]`).remove();
        form.confirmName.value = ''; host.querySelector('[data-status]').textContent = 'VM adopted. Customer lifecycle controls are available.';
      } catch (err) { host.querySelector('[data-status]').textContent = err.message; }
      finally { button.disabled = false; }
    };
  } catch (err) { host.textContent = err.message; }
}
