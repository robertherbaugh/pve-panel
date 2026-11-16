import { loading } from '/shared/ui.js';
import { sectionTabs } from './sections.js';
import { resourcePicker } from './resource-picker.js';

// Authentik owns membership. Each edit here maps trusted claims to resources.
export function renderAccessPolicy(container, { data, api, esc, toast, fail, confirmAction, onSave = () => {} }) {
  let policy = structuredClone(data.policy);
  let revision = data.revision;
  let resources = { pools: [], tags: [], vms: [], warnings: [] };
  let active = true, busy = false, editor = null;
  const labels = { view: 'View servers and graphs', power: 'Start, stop and restart', console: 'Browser console',
    'snapshot.create': 'Create snapshots', 'snapshot.delete': 'Delete snapshots', 'snapshot.rollback': 'Restore snapshots',
    'backup.read': 'List backups', 'backup.create': 'Create backups', 'backup.delete': 'Delete panel backups',
    'backup.restore': 'Restore backups (legacy owner)', 'backup.files': 'Browse and download backup files', 'backup.schedule': 'Schedule backups (owner)',
    'updates.read': 'View Windows updates', 'updates.run': 'Install Windows updates', resize: 'Resize own created servers',
    reinstall: 'Reinstall own legacy servers', delete: 'Delete own created servers', extend: 'Extend own servers',
    'private-access.read': 'Connect to OpenZiti services', 'private-access.manage': 'Manage OpenZiti VM services', 'tailscale.read': 'View own legacy Tailscale connection', 'tailscale.manage': 'Manage own legacy Tailscale connection', clone: 'Create servers from images' };
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const field = (name, label, value, hint = '', attrs = '') => `<label>${label}<input data-field="${name}" value="${esc(value)}" ${attrs}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const number = (name, label, value) => `<label>${label}<input type="number" min="1" data-field="${name}" value="${value ?? ''}"></label>`;
  const chips = (values) => values.map((v) => `<span class="badge">${esc(v)}</span>`).join(' ');
  const primaryActions = ['view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback', 'clone'];
  container.innerHTML = `
    <section class="security-card settings-card access-settings">
      <h2>Access permissions</h2>
      <p class="muted">Map SSO groups and application entitlements to servers and operations. Each permission set controls its own resources.</p>
      <form id="access-settings-form" class="settings">
        <label class="check"><input type="checkbox" name="enabled" ${policy.enabled ? 'checked' : ''}>Enable group and entitlement access</label>
        <p class="hint">Customer membership, resource boundaries and optional email domains are configured in Customers.</p>
        <div class="row"><button class="btn primary" type="submit">Save access settings</button><span data-access-status class="muted small"></span></div>
      </form>
    </section>
    <div class="section-head access-table-head"><div><h3>Permission sets</h3><p class="muted small">Edit a set to change its members, resources or operations. Toggles save immediately.</p></div><button type="button" class="btn primary" data-add-rule>Add permission set</button></div>
    <div class="table-wrap"><table class="table access-table" data-admin-table="Permission sets">
      <thead><tr><th>Permission set</th><th>SSO matching</th><th>Resources</th><th>Operations</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody data-access-rules></tbody>
    </table></div>
    <p data-policy-error class="form-error" role="alert"></p>
    <div class="access-inventory-status"><p class="muted small" data-inventory-status role="status">${loading('Loading Proxmox resources…')}</p><button type="button" class="btn" data-refresh-resources>Refresh Proxmox resources</button></div>
    <p class="muted small">SSO group changes take effect after a fresh sign-in. Shared access expires after the configured authorization lifetime, including open consoles.</p>`;
  sectionTabs(container, 'Permissions', [
    { id: 'sets', label: 'Permission sets', nodes: [container.querySelector('.access-table-head'), container.querySelector('.table-wrap')] },
    { id: 'settings', label: 'Access settings', nodes: [container.querySelector('.access-settings'), container.lastElementChild] },
    { id: 'resources', label: 'Resource discovery', nodes: [container.querySelector('.access-inventory-status')] },
  ], { before: container.firstElementChild });
  const settings = container.querySelector('#access-settings-form');
  const error = container.querySelector('[data-policy-error]');
  const rows = container.querySelector('[data-access-rules]');
  function renderRows() {
    container.querySelector('[data-access-status]').textContent = policy.enabled ? 'SSO access enabled' : 'SSO access disabled';
    rows.innerHTML = policy.rules.length ? policy.rules.map((r, i) => `
      <tr data-access-rule="${esc(r.id)}" class="${r.enabled === false ? 'access-rule-disabled' : ''}">
        <td><strong>${esc(r.name)}</strong><span class="muted small access-block">${esc(data.customers.find(c=>c.id===r.customerId)?.name??'Unknown customer')}</span><span class="muted small mono access-block">${esc(r.id)}</span></td>
        <td>${r.groups.length ? `<div class="access-claims"><span class="muted small">Groups</span>${chips(r.groups)}</div>` : ''}${r.groups.length && r.entitlements.length ? `<span class="muted small">${r.match === 'all' ? 'AND' : 'OR'}</span>` : ''}${r.entitlements.length ? `<div class="access-claims"><span class="muted small">Entitlements</span>${chips(r.entitlements)}</div>` : ''}</td>
        <td><div class="access-chips">${chips(r.pools)}</div>${r.tags?.length ? `<span class="muted small access-block">All tags: ${esc(r.tags.join(', '))}</span>` : ''}<span class="muted small access-block">${r.vmids?.length ? `${r.vmids.length} selected VM${r.vmids.length === 1 ? '' : 's'}` : 'All eligible VMs in these pools'}</span></td>
        <td><span class="access-operation-summary">${esc(r.actions.slice(0, 3).map((a) => labels[a] ?? a).join(', '))}</span>${r.actions.length > 3 ? `<span class="muted small access-block" title="${esc(r.actions.slice(3).map((a) => labels[a] ?? a).join(', '))}">+${r.actions.length - 3} more</span>` : ''}</td>
        <td><label class="access-switch"><input type="checkbox" role="switch" data-rule-toggle="${i}" aria-label="Enable ${esc(r.name)}" ${r.enabled !== false ? 'checked' : ''} ${busy ? 'disabled' : ''}><span aria-hidden="true"></span></label><span class="muted small access-block">${r.enabled !== false ? 'Enabled' : 'Disabled'}</span></td>
        <td><button type="button" class="btn" data-edit-rule="${i}" aria-label="Edit ${esc(r.name)}" ${busy ? 'disabled' : ''}>Edit</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">No permission sets yet. Add a set to map an SSO group or entitlement.</td></tr>';
  }
  async function persist(next) {
    if (busy) throw new Error('A permissions change is still saving.');
    busy = true; error.textContent = '';
    rows.querySelectorAll('button,input').forEach((control) => { control.disabled = true; });
    const buttons = [...settings.querySelectorAll('button'), container.querySelector('[data-add-rule]')];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const saved = await api('/api/admin/access-policy', { method: 'PUT', body: next, headers: revision ? { 'If-Match': revision } : {} });
      policy = structuredClone(saved.policy); revision = saved.revision; onSave(saved); toast('Access permissions saved');
    } finally {
      busy = false;
      if (active) { renderRows(); buttons.forEach((b) => { b.disabled = false; }); }
    }
  }
  function report(err, target = error) { target.textContent = err.message; fail(err); }
  async function refreshResources() {
    const button = container.querySelector('[data-refresh-resources]');
    const status = container.querySelector('[data-inventory-status]');
    button.disabled = true; status.innerHTML = loading('Loading Proxmox resources…');
    try {
      const inventory = await api('/api/admin/access-policy/resources');
      if (!active) return;
      resources = inventory;
      status.textContent = inventory.warnings.length ? inventory.warnings.join(' ') : `${inventory.pools.length} pools, ${inventory.tags.length} tags and ${inventory.vms.length} VMs from Proxmox.`;
      editor?.refresh();
    } catch (err) {
      if (active) status.textContent = `Proxmox resources could not be refreshed. Existing selections are preserved. ${err.message}`;
    } finally { if (active) button.disabled = false; }
  }
  function openEditor(index = null) {
    const r = index === null ? { id: `rule-${Date.now().toString(36)}`, name: '', enabled: true, groups: [], entitlements: [], match: 'any', pools: [], tags: [], vmids: [], actions: ['view'] } : structuredClone(policy.rules[index]);
    const dialog = document.createElement('dialog');
    const operations = (actions) => actions.map((a) => `<label class="check"><input type="checkbox" data-action="${esc(a)}" ${r.actions.includes(a) ? 'checked' : ''}>${esc(labels[a] ?? a)}</label>`).join('');
    const moreActions = data.actions.filter((a) => !primaryActions.includes(a));
    dialog.className = 'access-rule-modal'; dialog.setAttribute('aria-labelledby', 'access-editor-title');
    dialog.innerHTML = `<form class="settings access-editor">
      <div class="section-head"><h2 id="access-editor-title">${index === null ? 'Add' : 'Edit'} permission set</h2><button type="button" class="btn" data-close-editor aria-label="Close permission editor">Close</button></div>
      <div class="grid-2">${field('name', 'Display name', r.name, '', 'required maxlength="100"')}${field('id', 'Rule ID', r.id, 'A stable identifier using lowercase letters, numbers and hyphens.', `required maxlength="64" ${index !== null ? 'readonly' : ''}`)}</div>
      <label>Customer<select data-field="customerId" required><option value="">Select a customer</option>${data.customers.map(c=>`<option value="${c.id}" ${c.id===r.customerId?'selected':''}>${esc(c.name)}${c.enabled?'':' (disabled)'}</option>`).join('')}</select><span class="hint">This permission set applies only while the user is a member of this customer.</span></label>
      <label class="check"><input type="checkbox" data-field="enabled" ${r.enabled !== false ? 'checked' : ''}>Enable this permission set</label>
      <fieldset><legend>SSO matching</legend><div class="grid-2">${field('groups', 'OIDC groups', r.groups.join(', '), 'Exact group names, separated by commas.')}${field('entitlements', 'Application entitlements', r.entitlements.join(', '), 'Exact entitlement names for this application, separated by commas.')}</div>
        <label>Identity matching<select data-field="match"><option value="any" ${r.match !== 'all' ? 'selected' : ''}>Group OR entitlement</option><option value="all" ${r.match === 'all' ? 'selected' : ''}>Group AND entitlement</option></select></label></fieldset>
      <fieldset><legend>Proxmox resources</legend><div class="grid-2"><div><div data-picker="pools"></div><p class="hint">Select one or more resource pools.</p></div><div><div data-picker="tags"></div><p class="hint">Optional. A VM must have every selected tag and belong to a selected pool.</p></div></div>
        <div data-picker="vmids"></div><p class="hint">Optional. Search by VMID or VM name. Leave empty to include all eligible VMs in the selected pools.</p></fieldset>
      <fieldset><legend>Permitted operations</legend><div class="grid-2">${operations(primaryActions.filter((a) => data.actions.includes(a)))}</div>
        <details class="access-more-operations" ${moreActions.some((a) => r.actions.includes(a)) ? 'open' : ''}><summary>More operations</summary><div class="grid-2">${operations(moreActions)}</div></details></fieldset>
      <fieldset data-clone-fields ${r.actions.includes('clone') ? '' : 'hidden'}><legend>Server creation</legend><p class="muted small">New servers use the source image's node. Limits count all servers owned by each creator.</p>
        <label>Destination pool<select data-field="clonePool"></select></label>
        ${field('templates', 'Allowed image IDs', r.clone?.templates.join(', ') ?? '', 'Offered VM template numbers or container image IDs such as ct-1.')}${field('storages', 'Allowed disk storage IDs', r.clone?.storages.join(', ') ?? '')}
        <div class="grid-2">${number('servers', 'Servers per creator', r.clone?.limits.servers)}${number('cores', 'Total CPU cores per creator', r.clone?.limits.cores)}${number('memoryMb', 'Total memory per creator (MiB)', r.clone?.limits.memoryMb)}${number('diskGb', 'Total disk per creator (GiB)', r.clone?.limits.diskGb)}</div></fieldset>
      <p data-editor-error class="form-error" role="alert"></p>
      <div class="row access-editor-actions">${index !== null ? '<button type="button" class="btn danger" data-remove-rule>Delete permission set</button>' : ''}<span class="access-spacer"></span><button type="button" class="btn" data-cancel-editor>Cancel</button><button class="btn primary" type="submit">Save permission set</button></div></form>`;
    container.append(dialog);
    const form = dialog.querySelector('form');
    const value = (name) => form.querySelector(`[data-field="${name}"]`).value.trim();
    const poolChoices = () => resources.pools.filter(p=>data.customers.find(c=>c.id===Number(value('customerId')))?.pools.includes(p.id)).map((p) => ({ value: p.id, label: p.id, detail: [p.comment, p.available ? `${p.vmCount} eligible VM${p.vmCount === 1 ? '' : 's'}` : 'Pool inventory unavailable'].filter(Boolean).join(' · '), unavailable: !p.available }));
    const tagChoices = () => resources.tags.map((t) => ({ value: t.name, label: t.name, detail: `${t.vmCount} VM${t.vmCount === 1 ? '' : 's'}` }));
    const pickers = {};
    function vmChoices() {
      const pools = pickers.pools.values(), tags = pickers.tags.values();
      const selected = new Set(pickers.vmids?.values() ?? r.vmids.map(String));
      return resources.vms.flatMap((vm) => {
        const matches = vm.pools.some((p) => pools.includes(p)) && tags.every((tag) => vm.tags.includes(tag));
        if (!matches && !selected.has(String(vm.vmid))) return [];
        return [{ value: vm.vmid, label: `${vm.vmid} — ${vm.name}`, detail: [vm.node, vm.pools.join(', '), !matches ? 'Outside the selected pool/tag filters' : ''].filter(Boolean).join(' · '), unavailable: !matches }];
      });
    }
    function refreshDependent() {
      pickers.vmids?.update(vmChoices());
      const destination = form.querySelector('[data-field=clonePool]');
      const chosen = destination.value || r.clone?.pool || '', pools = pickers.pools.values();
      destination.innerHTML = `<option value="">Select a destination pool</option>${[...new Set([...pools, ...(chosen ? [chosen] : [])])].map((p) => `<option value="${esc(p)}">${esc(p)}${pools.includes(p) ? '' : ' (outside selected pools)'}</option>`).join('')}`;
      destination.value = chosen;
    }
    pickers.pools = resourcePicker(form.querySelector('[data-picker=pools]'), { label: 'Resource pools', selected: r.pools, choices: poolChoices(), esc, onChange: refreshDependent });
    pickers.tags = resourcePicker(form.querySelector('[data-picker=tags]'), { label: 'Required VM tags', selected: r.tags, choices: tagChoices(), esc, onChange: refreshDependent });
    pickers.vmids = resourcePicker(form.querySelector('[data-picker=vmids]'), { label: 'Specific VMs', selected: r.vmids, choices: vmChoices(), esc });
    refreshDependent();
    form.querySelector('[data-field=customerId]').onchange=()=>{pickers.pools.update(poolChoices());refreshDependent();};
    editor = { dialog, refresh() { pickers.pools.update(poolChoices()); pickers.tags.update(tagChoices()); refreshDependent(); } };
    dialog.addEventListener('close', () => { Object.values(pickers).forEach((p) => p.destroy()); dialog.remove(); if (editor?.dialog === dialog) editor = null; }, { once: true });
    dialog.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
    const close = () => { if (!busy) dialog.close(); };
    form.querySelector('[data-close-editor]').onclick = close; form.querySelector('[data-cancel-editor]').onclick = close;
    form.addEventListener('change', (e) => { if (e.target.dataset.action === 'clone') form.querySelector('[data-clone-fields]').hidden = !e.target.checked; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); const target = form.querySelector('[data-editor-error]'); target.textContent = '';
      const actions = [...form.querySelectorAll('[data-action]:checked')].map((x) => x.dataset.action);
      const nextRule = { customerId:Number(value('customerId')), id: value('id'), name: value('name'), enabled: form.querySelector('[data-field=enabled]').checked, groups: list(value('groups')), entitlements: list(value('entitlements')), match: value('match'), pools: pickers.pools.values(), tags: pickers.tags.values(), vmids: pickers.vmids.values().map(Number), actions,
        ...(actions.includes('clone') ? { clone: { pool: value('clonePool'), templates: list(value('templates')).map((t) => /^\d+$/.test(t) ? Number(t) : t), storages: list(value('storages')), limits: Object.fromEntries(['servers', 'cores', 'memoryMb', 'diskGb'].map((k) => [k, Number(value(k))])) } } : {}) };
      if (!nextRule.pools.length) { target.textContent = 'Select at least one resource pool.'; return; }
      const next = structuredClone(policy); if (index === null) next.rules.push(nextRule); else next.rules[index] = nextRule;
      const controls = [...form.querySelectorAll('button,input,select')].map((el) => [el, el.disabled]); controls.forEach(([el]) => { el.disabled = true; });
      try { await persist(next); dialog.close(); } catch (err) { report(err, target); }
      finally { controls.forEach(([el, disabled]) => { el.disabled = disabled; }); }
    });
    form.querySelector('[data-remove-rule]')?.addEventListener('click', async () => {
      if (busy || !await confirmAction(`Delete permission set “${r.name}”? Its shared grants will be removed.`, 'Delete permission set')) return;
      const next = structuredClone(policy); next.rules.splice(index, 1);
      try { await persist(next); dialog.close(); } catch (err) { report(err, form.querySelector('[data-editor-error]')); }
    });
    dialog.showModal(); form.querySelector('[data-field=name]').focus();
  }
  settings.addEventListener('submit', async (e) => { e.preventDefault(); try { await persist({ ...policy, enabled: settings.elements.namedItem('enabled').checked, allowedDomains: [] }); } catch (err) { report(err); } });
  container.querySelector('[data-add-rule]').onclick = () => openEditor();
  container.querySelector('[data-refresh-resources]').onclick = refreshResources;
  rows.addEventListener('click', (e) => { const button = e.target.closest('[data-edit-rule]'); if (button && !busy) openEditor(Number(button.dataset.editRule)); });
  rows.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-rule-toggle]') || busy) return;
    const next = structuredClone(policy); next.rules[Number(e.target.dataset.ruleToggle)].enabled = e.target.checked;
    try { await persist(next); } catch (err) { report(err); }
  });
  renderRows(); refreshResources();
  return () => { active = false; editor?.dialog.close(); };
}
