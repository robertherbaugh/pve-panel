import { resourcePicker } from './resource-picker.js';

export function renderComputeCatalog(host, { data, customers, api, esc, toast, fail, onSave }) {
  let catalog = data, active = true, dialog = null;
  const classes = () => catalog.classes;
  const field = (name, label, value, attrs = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
  const payload = () => ({
    revision: catalog.revision, sizes: catalog.sizes,
    classes: catalog.classes.map(({ id, enabled, bindings }) => ({ id, enabled, bindings })), reserves: catalog.reserves,
  });
  async function persist(body) {
    const saved = await api('/api/admin/compute-catalog', { method: 'PUT', body });
    catalog = saved; onSave(saved); toast('Compute catalog saved');
    if (active) render();
  }
  function open(title) {
    dialog?.close();
    const d = document.createElement('dialog');
    d.className = 'access-rule-modal'; d.setAttribute('aria-label', title);
    document.body.append(d); dialog = d;
    d.addEventListener('close', () => { d.remove(); if (dialog === d) dialog = null; }, { once: true });
    return d;
  }
  function bindForm(d, save) {
    const f = d.querySelector('form'), el = (name) => f.elements.namedItem(name);
    for (const b of d.querySelectorAll('[data-close]')) b.onclick = () => d.close();
    f.onsubmit = async (event) => {
      event.preventDefault();
      const button = f.querySelector('[type=submit]'); button.disabled = true;
      f.querySelector('[data-error]').textContent = '';
      try { await save(el); if (d.open) d.close(); }
      catch (err) { f.querySelector('[data-error]').textContent = err.message; }
      finally { button.disabled = false; }
    };
    d.showModal(); return { f, el };
  }
  const footer = `<p class="form-error" data-error role="alert"></p><div class="row end"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>`;
  const header = (title) => `<div class="section-head"><h2>${esc(title)}</h2><button type="button" class="btn" data-close>Close</button></div>`;

  function render() {
    host.innerHTML = `<div class="section-head"><div><h2 class="h2">Compute catalog</h2><p class="muted">Define VM sizes, storage destinations and customer offerings.</p></div><button class="btn" data-reload>Reload catalog</button></div>
      <div class="security-card compute-notice"><strong>Preview stage</strong><p>These offerings prepare the next provisioning flow. Current VM creation, quotas and backup jobs still use their existing settings. Saving this catalog does not move VMs, enable HA or change Proxmox networking.</p></div>
      <section class="compute-section"><div class="section-head"><div><h3>VM sizes</h3><p class="muted small">Disk capacity is separate. Disabled sizes remain available for configuration and review.</p></div><button class="btn primary" data-add-size>Add size</button></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Size</th><th>vCPU</th><th>Memory</th><th>Minimum disk</th><th>Status</th><th>Actions</th></tr></thead><tbody>${catalog.sizes.map((s) => `<tr><td><strong>${esc(s.name)}</strong><span class="access-block mono muted small">${esc(s.id)}</span></td><td>${s.cores}</td><td>${s.memoryMb / 1024} GiB</td><td>${s.minDiskGb} GiB</td><td>${s.enabled ? 'Enabled' : 'Disabled'}</td><td><button class="btn" data-size="${esc(s.id)}">Edit</button></td></tr>`).join('') || '<tr><td colspan="6">No sizes configured.</td></tr>'}</tbody></table></div></section>
      <section class="compute-section"><div class="section-head"><h3>Storage classes</h3></div><div class="compute-classes">${classes().map((c) => `<article class="security-card"><div class="section-head"><h4>${esc(c.name)}</h4><span class="pill">${c.enabled ? 'Enabled' : 'Disabled'}</span></div><p>${esc(c.description)}</p><p class="muted small">${c.bindings.filter((b) => b.purpose === 'vm').length} VM destinations${c.id === 'basic' ? ` · ${c.bindings.filter((b) => b.purpose === 'backup').length} backup destinations` : ''}</p><button class="btn" data-class="${c.id}">Edit ${esc(c.name)}</button></article>`).join('')}</div>
        <p class="hint">Backup storage always uses Basic. Verify the physical media before mapping a datastore. Proxmox storage types alone do not identify HDD, SSD or NVMe.</p></section>
      <section class="compute-section"><div class="section-head"><h3>Customer offerings</h3></div><p class="muted small">Service tier, sizes, storage and add-ons are separate from membership and VM permissions. HA remains off by default.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Actions</th></tr></thead><tbody>${customers.map((c) => `<tr><td>${esc(c.name)}${c.enabled ? '' : ' (disabled)'}</td><td><button class="btn" data-profile="${c.id}">Edit offerings</button></td></tr>`).join('') || '<tr><td colspan="2">Add a customer first.</td></tr>'}</tbody></table></div></section>
      <section class="security-card compute-section"><h3>Capacity preview</h3><p class="hint">Checks observed host and storage capacity only. It does not reserve resources or validate templates, networking, HA, maintenance state or allocation permissions.</p>
        <form data-preview class="settings"><div class="grid-2"><label>VM size<select name="sizeId" required>${catalog.sizes.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.enabled ? '' : ' (disabled)'}</option>`).join('')}</select></label><label>Storage class<select name="storageClassId">${classes().map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select></label>
        ${field('diskGb', 'Disk capacity (GiB)', Math.max(20, catalog.sizes[0]?.minDiskGb ?? 1), 'type="number" min="1" max="65536" required')}</div><button class="btn" type="submit">Check capacity</button><p data-error class="form-error" role="alert"></p></form><div data-preview-result aria-live="polite"></div>
        <form data-reserves class="settings compute-section"><h4>Capacity reserves for this preview</h4><div class="grid-2">${field('memoryMb', 'Host memory reserve (MiB)', catalog.reserves.memoryMb, 'type="number" min="0" max="1048576" required')}${field('diskGb', 'Datastore free space reserve (GiB)', catalog.reserves.diskGb, 'type="number" min="0" max="100000000" required')}</div><button class="btn" type="submit">Save reserves</button><p data-error class="form-error" role="alert"></p></form></section>
      <p class="hint">Reservation billing continues while VMs are stopped. Backup service fees and Basic storage usage are separate. No prices or invoices are active here.</p>`;
    host.querySelector('[data-add-size]').onclick = () => editSize();
    host.querySelectorAll('[data-size]').forEach((b) => { b.onclick = () => editSize(catalog.sizes.find((s) => s.id === b.dataset.size)); });
    host.querySelectorAll('[data-class]').forEach((b) => { b.onclick = () => editClass(classes().find((c) => c.id === b.dataset.class)); });
    host.querySelectorAll('[data-profile]').forEach((b) => { b.onclick = () => editProfile(Number(b.dataset.profile)).catch(fail); });
    host.querySelector('[data-reload]').onclick = async () => {
      try { catalog = await api('/api/admin/compute-catalog'); onSave(catalog); if (active) render(); }
      catch (err) { fail(err); }
    };
    host.querySelector('[data-reserves]').onsubmit = async (e) => {
      e.preventDefault(); const f = e.currentTarget, button = f.querySelector('button'); button.disabled = true;
      try { await persist({ ...payload(), reserves: { memoryMb: Number(f.elements.memoryMb.value), diskGb: Number(f.elements.diskGb.value) } }); }
      catch (err) { f.querySelector('[data-error]').textContent = err.message; }
      finally { button.disabled = false; }
    };
    host.querySelector('[data-preview]').onsubmit = async (e) => {
      e.preventDefault(); const f = e.currentTarget, el = f.elements, button = f.querySelector('button'); button.disabled = true;
      f.querySelector('[data-error]').textContent = '';
      const result = host.querySelector('[data-preview-result]'); result.textContent = 'Checking Proxmox capacity…';
      try {
        const preview = await api('/api/admin/compute-catalog/preview', { method: 'POST', body: { sizeId: el.sizeId.value, storageClassId: el.storageClassId.value, diskGb: Number(el.diskGb.value) } });
        if (!active) return;
        result.innerHTML = `<p class="muted small">Observed ${esc(preview.observedAt)} · Catalog revision ${preview.catalogRevision}</p>${preview.errors.map((s) => `<p class="form-error">${esc(s)}</p>`).join('')}<div class="table-wrap"><table class="table"><thead><tr><th>Node</th><th>Datastore</th><th>Capacity checks</th></tr></thead><tbody>${preview.candidates.map((c) => `<tr><td>${esc(c.node)}</td><td>${esc(c.storage)}</td><td>${c.passesCapacityChecks ? 'Passes observed capacity checks' : c.reasons.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div><p class="hint">No capacity reserved. Pending checks: ${preview.checksPending.map(esc).join(', ')}.</p>`;
      } catch (err) { result.textContent = ''; f.querySelector('[data-error]').textContent = err.message; }
      finally { button.disabled = false; }
    };
  }

  function editSize(existing = null) {
    const s = existing ?? { id: '', name: '', cores: 1, memoryMb: 2048, minDiskGb: 8, enabled: false }, title = existing ? 'Edit VM size' : 'Add VM size', d = open(title);
    d.innerHTML = `<form class="settings access-editor">${header(title)}<div class="grid-2">${field('id', 'Size ID', s.id, `required pattern="[a-z0-9][a-z0-9-]*" maxlength="64" ${existing ? 'readonly' : ''}`)}${field('name', 'Display name', s.name, 'required maxlength="80"')}${field('cores', 'vCPUs', s.cores, 'type="number" min="1" max="128" required')}${field('memoryMb', 'Memory (MiB)', s.memoryMb, 'type="number" min="512" max="1048576" required')}${field('minDiskGb', 'Minimum disk (GiB)', s.minDiskGb, 'type="number" min="1" max="65536" required')}</div><label class="check"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>Size enabled</label><p class="hint">Catalog changes do not resize existing VMs. vCPUs do not imply dedicated physical cores.</p>${footer}</form>`;
    bindForm(d, async (el) => {
      const size = { id: el('id').value, name: el('name').value.trim(), cores: Number(el('cores').value), memoryMb: Number(el('memoryMb').value), minDiskGb: Number(el('minDiskGb').value), enabled: el('enabled').checked };
      const body = payload(); body.sizes = existing ? body.sizes.map((x) => x.id === s.id ? size : x) : [...body.sizes, size];
      await persist(body);
    });
  }

  async function editClass(c) {
    const d = open(`Edit ${c.name}`), pickers = [];
    d.innerHTML = `<form class="settings access-editor">${header(`Edit ${c.name}`)}<p>${esc(c.description)}</p><label class="check"><input name="enabled" type="checkbox" ${c.enabled ? 'checked' : ''}>Storage class enabled</label><div data-vm></div>${c.id === 'basic' ? '<div data-backup></div>' : ''}<p class="hint">Mapping a destination declares its physical storage class. Verify the underlying media first. A mapping does not grant Proxmox permissions or prove HA support.</p><p class="muted small" data-inventory>Loading Proxmox inventory…</p>${footer}</form>`;
    for (const purpose of c.id === 'basic' ? ['vm', 'backup'] : ['vm']) {
      const picker = resourcePicker(d.querySelector(`[data-${purpose}]`), { label: purpose === 'vm' ? 'VM destinations' : 'Backup destinations (Basic only)', selected: c.bindings.filter((b) => b.purpose === purpose).map((b) => `${b.node}/${b.storage}`), choices: [], esc });
      pickers.push({ purpose, picker });
    }
    d.addEventListener('close', () => pickers.forEach(({ picker }) => picker.destroy()), { once: true });
    bindForm(d, async (el) => {
      const binding = { id: c.id, enabled: el('enabled').checked, bindings: pickers.flatMap(({ purpose, picker }) => picker.values().map((value) => { const [node, storage] = value.split('/'); return { node, storage, purpose }; })) };
      const body = payload(); body.classes = body.classes.map((x) => x.id === c.id ? binding : x); await persist(body);
    });
    try {
      const inventory = await api('/api/admin/compute-catalog/inventory');
      if (!active || !d.open) return;
      for (const { purpose, picker } of pickers) picker.update(inventory.nodes.flatMap((n) => n.storages.filter((s) => s.content.includes(purpose === 'vm' ? 'images' : 'backup')).map((s) => ({ value: `${n.node}/${s.storage}`, label: `${s.storage} on ${n.node}`, detail: [s.type ?? 'Unknown storage type', s.active === true ? 'active' : 'availability unverified', s.availableBytes === null ? 'free space unavailable' : `${Math.floor(s.availableBytes / 2 ** 30)} GiB free`].join(' · '), unavailable: n.status !== 'online' || s.active !== true }))));
      d.querySelector('[data-inventory]').textContent = [...inventory.errors, ...inventory.nodes.filter((n) => n.error).map((n) => `${n.node}: ${n.error}`)].join(' ') || 'Inventory loaded. Missing destinations require Proxmox audit permissions or a working node connection.';
    } catch (err) { if (d.open) d.querySelector('[data-inventory]').textContent = err.message; }
  }

  async function editProfile(id) {
    const p = await api(`/api/admin/customers/${id}/compute-profile`);
    if (!active) return;
    const customer = customers.find((c) => c.id === id), d = open(`Offerings for ${customer.name}`);
    d.innerHTML = `<form class="settings access-editor">${header(`Offerings for ${customer.name}`)}<label>Service tier<select name="tier">${['basecamp', 'ridge', 'summit'].map((tier) => `<option value="${tier}" ${tier === p.tier ? 'selected' : ''}>${tier[0].toUpperCase() + tier.slice(1)}</option>`).join('')}</select></label><label class="check"><input name="allSizes" type="checkbox" ${p.sizeIds === null ? 'checked' : ''}>Allow all enabled sizes, including future sizes</label><div data-sizes></div><div data-classes></div><label class="check"><input name="haAllowed" type="checkbox" ${p.haAllowed ? 'checked' : ''}>Allow the optional HA add-on</label><p class="hint">HA remains off by default. Activation needs eligible infrastructure and the customer's applicable SLA/MSA acceptance.</p><label class="check"><input name="backupServiceEnabled" type="checkbox" ${p.backupServiceEnabled ? 'checked' : ''}>Backup service selected</label><p class="hint" data-backup-fee></p><fieldset><legend>Storage limits</legend><p class="hint">GiB per storage class. 0 means no additional class cap. Existing aggregate customer limits still apply when provisioning integration is available.</p><div class="grid-2">${classes().map((c) => field(c.id, `${c.name} disk limit (GiB)`, p.storageLimitsGb[c.id], 'type="number" min="0" max="100000000" required')).join('')}${field('backupLimitGb', 'Backup storage limit (GiB)', p.backupLimitGb, 'type="number" min="0" max="100000000" required')}</div></fieldset>${footer}</form>`;
    const sizes = resourcePicker(d.querySelector('[data-sizes]'), { label: 'Allowed VM sizes', selected: p.sizeIds ?? [], choices: catalog.sizes.map((s) => ({ value: s.id, label: s.name, detail: `${s.cores} vCPU · ${s.memoryMb / 1024} GiB${s.enabled ? '' : ' · disabled globally'}` })), esc });
    const storage = resourcePicker(d.querySelector('[data-classes]'), { label: 'Allowed storage classes', selected: p.storageClassIds, choices: classes().map((c) => ({ value: c.id, label: c.name, detail: c.description })), esc });
    d.addEventListener('close', () => { sizes.destroy(); storage.destroy(); }, { once: true });
    const { el } = bindForm(d, async (el) => {
      await api(`/api/admin/customers/${id}/compute-profile`, { method: 'PUT', body: {
        revision: p.revision, catalogRevision: catalog.revision, tier: el('tier').value,
        sizeIds: el('allSizes').checked ? null : sizes.values(), storageClassIds: storage.values(),
        haAllowed: el('haAllowed').checked, backupServiceEnabled: el('backupServiceEnabled').checked,
        storageLimitsGb: Object.fromEntries(classes().map((c) => [c.id, Number(el(c.id).value)])), backupLimitGb: Number(el('backupLimitGb').value),
      } }); toast('Customer offerings saved');
    });
    const update = () => {
      d.querySelector('[data-sizes]').hidden = el('allSizes').checked;
      d.querySelector('[data-backup-fee]').textContent = `${el('tier').value === 'basecamp' ? 'Backup service is a paid add-on.' : 'Backup service fee is included.'} Basic backup storage usage is charged separately in every tier. Selecting the service does not create a schedule.`;
    };
    el('allSizes').onchange = update; el('tier').onchange = update; update();
  }
  render();
  return () => { active = false; dialog?.close(); };
}
