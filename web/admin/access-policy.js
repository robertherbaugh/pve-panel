// Application permissions are edited independently from identity membership.
// Authentik owns groups/entitlements; this page maps them to panel operations.
export function renderAccessPolicy(container, { data, api, esc, toast, fail }) {
  const policy = structuredClone(data.policy);
  const labels = { view: 'View servers and graphs', power: 'Start, stop and restart', console: 'Browser console',
    'snapshot.create': 'Create snapshots', 'snapshot.delete': 'Delete snapshots', 'snapshot.rollback': 'Restore snapshots',
    'backup.read': 'List backups', 'backup.create': 'Create backups', 'backup.delete': 'Delete panel backups',
    'backup.restore': 'Restore backups (legacy owner)', 'backup.files': 'Browse and download backup files', 'backup.schedule': 'Schedule backups (owner)',
    'updates.read': 'View Windows updates', 'updates.run': 'Install Windows updates', resize: 'Resize own created servers',
    reinstall: 'Reinstall own legacy servers', delete: 'Delete own created servers', extend: 'Extend own servers',
    'tailscale.read': 'View own legacy Tailscale connection', 'tailscale.manage': 'Manage own legacy Tailscale connection', clone: 'Create servers from images' };
  const field = (name, label, value, hint = '') => `<label>${label}<input data-field="${name}" value="${esc(value)}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const number = (name, label, value) => `<label>${label}<input type="number" min="1" data-field="${name}" value="${value ?? ''}"></label>`;
  container.innerHTML = `
    <form id="access-policy-form" class="settings">
      <section class="security-card settings-card">
        <h2>Access permissions</h2>
        <p class="muted">Use OIDC groups, application entitlements, or both to share servers. Rules grant access only to the selected pools and operations. Existing individual assignments continue to work.</p>
        <label class="check"><input type="checkbox" name="enabled" ${policy.enabled ? 'checked' : ''}>Enable group and entitlement access</label>
        <label>Allowed email domains<input name="domains" value="${esc(policy.allowedDomains.join(', '))}" placeholder="tacticalid.io"><span class="hint">Exact domains, separated by commas. A matching domain alone grants no access.</span></label>
        <p class="muted">Group changes take effect after a fresh single sign-on. Claim-based access expires within the configured authorization lifetime (five minutes by default), including open consoles. Rule edits apply immediately; pool and tag inventories are cached for five seconds. Open consoles recheck access every five seconds.</p>
      </section>
      <div data-access-rules>${policy.rules.map((r) => `
        <fieldset class="security-card settings-card" data-access-rule>
          <legend>${esc(r.name)}</legend>
          <div class="grid-2">${field('id', 'Rule ID', r.id)}${field('name', 'Display name', r.name)}</div>
          <div class="grid-2">
            ${field('groups', 'OIDC groups', (r.groups ?? []).join(', '), 'Exact group names, separated by commas.')}
            ${field('entitlements', 'Application entitlements', (r.entitlements ?? []).join(', '), 'Exact entitlement names for this application, separated by commas.')}
          </div>
          <label>Identity matching<select data-field="match"><option value="any" ${r.match !== 'all' ? 'selected' : ''}>Group OR entitlement</option><option value="all" ${r.match === 'all' ? 'selected' : ''}>Group AND entitlement</option></select></label>
          <div class="grid-2">
            ${field('pools', 'Resource pools', r.pools.join(', '), 'Exact Proxmox pool IDs; no wildcards.')}
            ${field('tags', 'Required VM tags (optional)', (r.tags ?? []).join(', '), 'The VM must have every listed tag as well as belong to an allowed pool.')}
          </div>
          ${field('vmids', 'Specific VM IDs (optional)', (r.vmids ?? []).join(', '), 'Leave empty to include every eligible VM in the selected pools.')}
          <fieldset><legend>Permitted operations</legend><div class="grid-2">${data.actions.map((a) => `<label class="check"><input type="checkbox" data-action="${esc(a)}" ${r.actions.includes(a) ? 'checked' : ''}>${esc(labels[a] ?? a)}</label>`).join('')}</div></fieldset>
          <fieldset data-clone-fields ${r.actions.includes('clone') ? '' : 'hidden'}><legend>Server creation</legend>
            <p class="muted">Creation keeps the source image's node. Limits apply to all servers owned by each creator. Other group members can use the server but cannot take over its owner-specific lifecycle. Reinstallation, backup restoration and scheduled backups remain legacy owner features.</p>
            ${field('clonePool', 'Destination pool', r.clone?.pool ?? '')}
            ${field('templates', 'Allowed image IDs', r.clone?.templates.join(', ') ?? '', 'VM template numbers or container image IDs such as ct-1.')}
            ${field('storages', 'Allowed disk storage IDs', r.clone?.storages.join(', ') ?? '')}
            <div class="grid-2">${number('servers', 'Servers per creator', r.clone?.limits.servers)}${number('cores', 'Total CPU cores per creator', r.clone?.limits.cores)}${number('memoryMb', 'Total memory per creator (MiB)', r.clone?.limits.memoryMb)}${number('diskGb', 'Total disk per creator (GiB)', r.clone?.limits.diskGb)}</div>
          </fieldset>
          <button type="button" class="btn danger" data-remove-rule>Remove rule</button>
        </fieldset>`).join('')}</div>
      <div class="row"><button type="button" class="btn" data-add-rule>Add rule</button><button class="btn primary" type="submit">Save permissions</button></div>
      <p data-policy-error class="form-error" role="alert"></p>
    </form>`;
  const form = container.querySelector('form');
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  function read() {
    return { version: 1, enabled: form.enabled.checked, allowedDomains: list(form.domains.value),
      rules: [...form.querySelectorAll('[data-access-rule]')].map((el) => {
        const value = (f) => el.querySelector(`[data-field="${f}"]`).value.trim();
        const actions = [...el.querySelectorAll('[data-action]:checked')].map((x) => x.dataset.action);
        return { id: value('id'), name: value('name'), groups: list(value('groups')), entitlements: list(value('entitlements')),
          match: value('match'), pools: list(value('pools')), tags: list(value('tags')), vmids: list(value('vmids')).map(Number), actions,
          ...(actions.includes('clone') ? { clone: { pool: value('clonePool'), templates: list(value('templates')).map((t) => /^\d+$/.test(t) ? Number(t) : t),
            storages: list(value('storages')), limits: Object.fromEntries(['servers', 'cores', 'memoryMb', 'diskGb'].map((k) => [k, Number(value(k))])) } } : {}) };
      }) };
  }
  const render = (next) => renderAccessPolicy(container, { data: { policy: next, actions: data.actions }, api, esc, toast, fail });
  form.addEventListener('change', (event) => {
    if (event.target.dataset.action === 'clone') event.target.closest('[data-access-rule]').querySelector('[data-clone-fields]').hidden = !event.target.checked;
  });
  form.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-rule]');
    const remove = event.target.closest('[data-remove-rule]');
    if (!add && !remove) return;
    if (remove) remove.closest('[data-access-rule]').remove();
    const next = read();
    if (add) next.rules.push({ id: `rule-${Date.now().toString(36)}`, name: 'New rule', groups: [], entitlements: [], match: 'any', pools: [], tags: [], vmids: [], actions: ['view'] });
    render(next);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    form.querySelector('[data-policy-error]').textContent = '';
    try {
      const saved = await api('/api/admin/access-policy', { method: 'PUT', body: read() });
      toast('Access permissions saved');
      render(saved.policy);
    } catch (error) { form.querySelector('[data-policy-error]').textContent = error.message; fail(error); }
    finally { button.disabled = false; }
  });
}
