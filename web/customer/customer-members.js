export async function manageCustomerMembers({ api, esc, toast, fail, confirmAction }) {
  const d = document.createElement('dialog');
  d.className = 'access-rule-modal';
  d.setAttribute('aria-label', 'Customer members');
  document.body.append(d);
  d.innerHTML = `<div class="settings access-editor"><div class="section-head"><h2>Customer members</h2><button class="btn" data-close>Close</button></div><div data-list></div><form class="settings"><div class="grid-2"><label>Existing user email<input name="email" type="email" required></label><label>Customer role<select name="role" aria-label="Customer role"><option value="member">Member (permission sets only)</option><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Customer administrator</option></select></label></div><button class="btn primary">Add or update member</button></form><p class="hint">Users must already have a panel account. Removing membership revokes access and preserves customer resources.</p><p class="form-error" data-error role="alert"></p></div>`;
  const report = (err) => {
    if (d.isConnected) d.querySelector('[data-error]').textContent = err.message;
    fail(err);
  };
  const load = async () => {
    const data = await api('/api/customer/members');
    if (!d.isConnected) return;
    d.querySelector('h2').textContent = `Members of ${data.customer.name}`;
    d.querySelector('[data-list]').innerHTML =
      `<div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Role</th><th>Source</th><th>Actions</th></tr></thead><tbody>${data.members.map((m) => `<tr><td>${esc(m.email)}${m.disabled ? ' (disabled)' : ''}</td><td>${esc(m.role)}</td><td>${esc(m.source)}</td><td><button class="btn danger" data-remove="${m.userId}">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
    d.querySelectorAll('[data-remove]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (
            !(await confirmAction(
              'Revoke this user’s access to this customer? Shared VMs stay with the customer.',
              'Remove member',
            ))
          )
            return;
          try {
            await api(`/api/customer/members/${b.dataset.remove}`, { method: 'DELETE' });
            await load();
            toast('Membership removed');
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
      await api('/api/customer/members', {
        method: 'PUT',
        body: { email: f.elements.email.value.trim(), role: f.elements.role.value },
      });
      await load();
      toast('Membership saved');
    } catch (err) {
      report(err);
    } finally {
      b.disabled = false;
    }
  };
  d.querySelector('[data-close]').onclick = () => d.close();
  d.onclose = () => d.remove();
  d.showModal();
  await load().catch(report);
}
