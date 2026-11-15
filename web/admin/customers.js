import { resourcePicker } from './resource-picker.js';

export function renderCustomers(host, { data, users, api, esc, toast, fail, confirmAction, onSave }) {
  let customers = data.customers,
    inventory = null,
    active = true,
    dialog = null;
  const list = (v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const roles = ['member', 'viewer', 'operator', 'admin'];
  const roleOptions = (role) =>
    roles.map((r) => `<option ${r === role ? 'selected' : ''}>${r}</option>`).join('');
  const field = (name, label, value = '', attrs = '') =>
    `<label>${label}<input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
  function render() {
    host.innerHTML = `<div class="section-head"><div><h2 class="h2">Customers</h2><p class="muted">Each customer has its own users, resources and limits. Users may belong to several customers.</p></div><button class="btn primary" data-add-customer>Add customer</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Resource pools</th><th>Membership</th><th>Users</th><th>Status</th><th>Actions</th></tr></thead><tbody>${customers.map((c) => `<tr data-customer="${c.id}"><td><strong>${esc(c.name)}</strong><span class="muted small access-block">${esc(c.slug)}${c.legacy ? ' · migrated personal customer' : ''}</span></td><td>${c.pools.length ? c.pools.map((p) => `<span class="badge">${esc(p)}</span>`).join(' ') : '<span class="muted">Explicit VM assignments</span>'}</td><td>${c.sso.groups.length || c.sso.entitlements.length ? 'SSO mapping' : 'Manual membership'}${c.allowedDomains.length ? `<span class="muted small access-block">${esc(c.allowedDomains.join(', '))}</span>` : ''}</td><td>${c.members}</td><td><span class="pill ${c.enabled ? 'pill-running' : ''}">${c.enabled ? 'Enabled' : 'Disabled'}</span></td><td class="actions"><button class="btn" data-members>Members</button><button class="btn" data-edit-customer>Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No customers yet.</td></tr>'}</tbody></table></div>
      <p class="muted small">A pool can belong to one customer. SSO mappings establish membership; permission sets grant operations inside that customer. Domains alone never grant membership.</p>`;
    host.querySelector('[data-add-customer]').onclick = () => edit();
    host
      .querySelectorAll('[data-edit-customer]')
      .forEach(
        (b) =>
          (b.onclick = () => edit(customers.find((c) => c.id === Number(b.closest('tr').dataset.customer)))),
      );
    host
      .querySelectorAll('[data-members]')
      .forEach(
        (b) =>
          (b.onclick = () =>
            members(customers.find((c) => c.id === Number(b.closest('tr').dataset.customer)))),
      );
  }
  async function reload() {
    const saved = await api('/api/admin/customers');
    customers = saved.customers;
    onSave(saved);
    if (active) render();
  }
  function open(title) {
    dialog?.close();
    const d = document.createElement('dialog');
    d.className = 'access-rule-modal';
    d.setAttribute('aria-label', title);
    document.body.append(d);
    dialog = d;
    d.addEventListener(
      'close',
      () => {
        d.remove();
        if (dialog === d) dialog = null;
      },
      { once: true },
    );
    return d;
  }
  async function edit(c = null) {
    const title = c ? 'Edit customer' : 'Add customer',
      d = open(title);
    const s = c?.sso ?? { required: true, groups: [], entitlements: [], match: 'any' },
      expiry = c?.expiry ?? {};
    d.innerHTML = `<form class="settings access-editor"><div class="section-head"><h2>${title}</h2><button type="button" class="btn" data-close>Close</button></div>
      <div class="grid-2">${field('name', 'Customer name', c?.name, 'required maxlength="100"')}${field('slug', 'Customer ID', c?.slug, 'required pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64"')}</div>
      <label class="check"><input name="enabled" type="checkbox" ${!c || c.enabled ? 'checked' : ''}>Customer enabled</label>
      <fieldset><legend>Resource boundary</legend><div data-pools></div><p class="hint">Only these Proxmox pools belong to this customer. Empty means access is limited to VMs explicitly assigned to the customer. A permission set can narrow this boundary.</p><p class="muted small" data-inventory>Loading Proxmox pools…</p></fieldset>
      <fieldset><legend>SSO membership</legend><div class="grid-2">${field('groups', 'OIDC groups', s.groups.join(', '))}${field('entitlements', 'Application entitlements', s.entitlements.join(', '))}</div>
        <p class="hint">Exact values, separated by commas. A matching trusted claim adds the user as a member with no VM operations until a permission set grants them.</p>
        <label>Membership matching<select name="match"><option value="any" ${s.match === 'any' ? 'selected' : ''}>Group OR entitlement</option><option value="all" ${s.match === 'all' ? 'selected' : ''}>Group AND entitlement</option></select></label>
        ${field('domains', 'Email domains (optional)', c?.allowedDomains.join(', '), 'placeholder="rcadea.cloud"')}<p class="hint">Optional extra filter on automatic SSO membership. Leave empty to trust the group or entitlement mapping. Domains never grant access by themselves.</p>
        <label class="check"><input name="ssoRequired" type="checkbox" ${s.required ? 'checked' : ''}>Require a current SSO authorization for every member</label><p class="hint">When enabled, manual members also need a fresh SSO sign-in. When disabled, manual members may use any enabled sign-in method.</p></fieldset>
      <fieldset><legend>Shared limits</legend><p class="hint">Aggregate limits across all customer servers and creators. 0 means no additional customer cap. Cloning still requires an explicit permission set with per-creator limits.</p><div class="grid-2">${[
        ['servers', 'Servers'],
        ['cores', 'CPU cores'],
        ['memoryMb', 'Memory (MiB)'],
        ['diskGb', 'Disk (GiB)'],
      ]
        .map(([key, label]) =>
          field(key, label, c?.limits[key] ?? 0, 'type="number" min="0" max="100000000" required'),
        )
        .join('')}</div></fieldset>
      <fieldset><legend>Lifecycle</legend><div class="grid-2">${field('contactEmail', 'Notification email', c?.contact_email, 'type="email"')}${field('maxBackups', 'Backups per server', c?.maxBackups, 'type="number" min="0" max="100" placeholder="Default from Settings"')}</div>
        <label>Servers expire<select name="expiryMode"><option value="">Never</option><option value="after_creation">After a number of days</option><option value="fixed_date">On a date</option></select></label><div class="grid-2">${field('expiryDays', 'Days after creation', expiry.days, 'type="number" min="1" max="3650"')}${field('expiryDate', 'End date', expiry.date, 'type="date"')}</div>
        <label class="check"><input name="selfExtend" type="checkbox" ${expiry.selfExtend ? 'checked' : ''}>Customer may extend each server once</label></fieldset>
      <p class="form-error" data-error role="alert"></p><div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save customer</button></div></form>`;
    const f = d.querySelector('form'),
      el = (n) => f.elements.namedItem(n);
    el('expiryMode').value = expiry.mode ?? '';
    const showExpiry = () => {
      el('expiryDays').closest('label').hidden = el('expiryMode').value !== 'after_creation';
      el('expiryDays').required = el('expiryMode').value === 'after_creation';
      el('expiryDate').closest('label').hidden = el('expiryMode').value !== 'fixed_date';
      el('expiryDate').required = el('expiryMode').value === 'fixed_date';
    };
    el('expiryMode').onchange = showExpiry;
    showExpiry();
    const picker = resourcePicker(f.querySelector('[data-pools]'), {
      label: 'Customer resource pools',
      selected: c?.pools ?? [],
      choices: [],
      esc,
    });
    d.addEventListener('close', () => picker.destroy(), { once: true });
    d.querySelector('[data-close]').onclick = d.querySelector('[data-cancel]').onclick = () => d.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const button = f.querySelector('.primary');
      button.disabled = true;
      const body = {
        name: el('name').value.trim(),
        slug: el('slug').value.trim(),
        enabled: el('enabled').checked,
        pools: picker.values(),
        allowedDomains: list(el('domains').value),
        sso: {
          groups: list(el('groups').value),
          entitlements: list(el('entitlements').value),
          match: el('match').value,
          required: el('ssoRequired').checked,
        },
        limits: Object.fromEntries(
          ['servers', 'cores', 'memoryMb', 'diskGb'].map((k) => [k, Number(el(k).value)]),
        ),
        contactEmail: el('contactEmail').value.trim() || null,
        maxBackups: el('maxBackups').value === '' ? null : Number(el('maxBackups').value),
        expiry: {
          mode: el('expiryMode').value,
          days: el('expiryDays').value ? Number(el('expiryDays').value) : null,
          date: el('expiryDate').value || null,
          selfExtend: el('selfExtend').checked,
        },
        ...(c ? { revision: c.revision } : {}),
      };
      try {
        await api(`/api/admin/customers${c ? `/${c.id}` : ''}`, { method: c ? 'PUT' : 'POST', body });
        d.close();
        toast('Customer saved');
        await reload();
      } catch (err) {
        f.querySelector('[data-error]').textContent = err.message;
        fail(err);
      } finally {
        button.disabled = false;
      }
    };
    d.showModal();
    el('name').focus();
    try {
      inventory ??= await api('/api/admin/access-policy/resources');
      if (!d.isConnected) return;
      picker.update(
        inventory.pools.map((p) => ({
          value: p.id,
          label: p.id,
          detail: [p.comment, customers.find((o) => o.id !== c?.id && o.pools.includes(p.id))?.name]
            .filter(Boolean)
            .join(' · '),
          unavailable: customers.some((o) => o.id !== c?.id && o.pools.includes(p.id)),
        })),
      );
      f.querySelector('[data-inventory]').textContent = inventory.warnings.join(' ');
    } catch (err) {
      if (d.isConnected)
        f.querySelector('[data-inventory]').textContent =
          `Pool inventory unavailable. Existing selections are preserved. ${err.message}`;
    }
  }
  async function members(c) {
    const d = open(`Members of ${c.name}`);
    d.innerHTML = `<div class="settings access-editor"><div class="section-head"><h2>Members of ${esc(c.name)}</h2><button class="btn" data-close>Close</button></div><p class="hint">Member: permission sets only. Viewer: view. Operator: view, console, power and snapshots. Admin: manage membership and customer resources. Cloning always requires a permission set.</p><div data-member-list></div><form class="settings" data-add-member><div class="grid-2"><label>Existing user<select name="userId" aria-label="Existing user" required><option value="">Select a user</option>${users
      .filter((u) => !u.disabled)
      .map((u) => `<option value="${u.id}">${esc(u.email)}</option>`)
      .join(
        '',
      )}</select></label><label>Customer role<select name="role" aria-label="Customer role">${roleOptions('member')}</select></label></div><button class="btn primary">Add or update member</button></form><p class="muted small">Removing a member revokes both manual and automatic membership. Re-add the user to approve access again. Customer VMs and backups stay with the customer.</p><p data-error class="form-error" role="alert"></p></div>`;
    d.querySelector('[data-close]').onclick = () => d.close();
    const report = (err) => {
      if (d.isConnected) d.querySelector('[data-error]').textContent = err.message;
      fail(err);
    };
    const load = async () => {
      const result = await api(`/api/admin/customers/${c.id}/members`);
      if (!d.isConnected) return;
      d.querySelector('[data-member-list]').innerHTML =
        `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Source</th><th>Actions</th></tr></thead><tbody>${result.members.map((m) => `<tr><td>${esc(m.email)}${m.disabled ? ' (disabled)' : ''}</td><td>${esc(m.role)}</td><td>${m.source === 'oidc' ? 'SSO mapping' : 'Manual'}</td><td><button class="btn danger" data-remove="${m.userId}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No users yet. SSO members appear after sign-in.</td></tr>'}</tbody></table></div>`;
      d.querySelectorAll('[data-remove]').forEach(
        (b) =>
          (b.onclick = async () => {
            if (
              !(await confirmAction(
                'Revoke this user’s access to this customer? Shared resources are preserved.',
                'Remove member',
              ))
            )
              return;
            try {
              await api(`/api/admin/customers/${c.id}/members/${b.dataset.remove}`, { method: 'DELETE' });
              await load();
              await reload();
            } catch (err) {
              report(err);
            }
          }),
      );
    };
    d.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.currentTarget,
        b = f.querySelector('button');
      b.disabled = true;
      try {
        await api(`/api/admin/customers/${c.id}/members`, {
          method: 'PUT',
          body: { userId: Number(f.elements.userId.value), role: f.elements.role.value },
        });
        await load();
        await reload();
        toast('Membership saved');
      } catch (err) {
        report(err);
      } finally {
        b.disabled = false;
      }
    };
    d.showModal();
    load().catch(report);
  }
  render();
  return () => {
    active = false;
    dialog?.close();
  };
}
