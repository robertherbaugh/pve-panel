import { api, esc, fail, loading, confirmAction, toast } from '/shared/ui.js';
import { money, billingSummaryHtml, invoiceDraftsHtml, invoicesHtml } from '/shared/billing-ui.js';
import { markedSections } from './sections.js';

export function renderBilling(host, { data, reload }) {
  const settings = data.settings;
  let active = true, dialog;
  const rates = new Map(settings.draftRates.map(r => [r.key, r]));
  const published = new Map(settings.activeRates.map(r => [r.key, r]));
  host.innerHTML = `
    <section data-section="Customers"><div class="section-head"><div><h2>Customer billing</h2><p class="muted">Organizations own subscriptions and invoices. User limits do not define prices.</p></div><button class="btn" data-refresh-billing>Refresh</button></div>
      <div class="table-wrap"><table class="table" data-admin-table="Customer billing"><thead><tr><th>Customer</th><th>Payment requirement</th><th>Subscription</th><th>Monthly estimate</th><th>Actions</th></tr></thead><tbody>${data.customers.map(c => `<tr data-billing-customer="${c.id}"><td>${esc(c.name)}</td><td>${c.account.required ? 'Required' : 'Not required'}</td><td>${esc(c.account.status)}${c.account.lastError ? '<span class="tag warn">Needs attention</span>' : ''}</td><td>${money(c.summary.subtotalMinor, c.summary.currency)}${c.summary.complete ? '' : ' + unpriced'}</td><td><button class="btn" data-open-billing="${c.id}">Manage billing</button></td></tr>`).join('')}</tbody></table></div></section>
    <section data-section="Prices"><div class="section-head"><div><h2>Monthly reservation prices</h2><p class="muted">Compute sizes exclude disk. Blank means unpriced. Enter 0 for an included service.</p></div></div>
      <form data-price-form><div class="table-wrap"><table class="table" data-admin-table="Billing prices"><thead><tr><th>Item</th><th>Unit</th><th>Draft price (${esc(settings.currency.toUpperCase())})</th><th>Published price</th></tr></thead><tbody>${data.definitions.map(d => `<tr><td>${esc(d.label)}</td><td>${esc(d.unit)}</td><td><input type="number" min="0" max="1000000" step="0.01" data-price="${esc(d.key)}" aria-label="Monthly price for ${esc(d.label)}" value="${rates.get(d.key)?.amountMinor == null ? '' : (rates.get(d.key).amountMinor / 100).toFixed(2)}" placeholder="Not priced"></td><td>${money(published.get(d.key)?.amountMinor, settings.currency)}</td></tr>`).join('')}</tbody></table></div>
      <div class="row billing-toolbar"><button class="btn primary">Save draft prices</button><button type="button" class="btn" data-publish-prices ${settings.keyConfigured ? '' : 'disabled'}>Publish prices to Stripe</button><span class="hint">Published revision: ${settings.activeRevision || 'None'}</span></div></form>
      <p class="hint">Publishing applies the prices to subscribed reservations during reconciliation. Stripe prorates subscription changes. Existing invoice history remains in Stripe.</p></section>
    <section data-section="Stripe"><form class="settings" data-stripe-form><h2>Stripe connection</h2>
      <label class="check"><input type="checkbox" name="enabled" ${settings.enabled ? 'checked' : ''}>Enable billing</label>
      <div class="grid-2"><label>Mode<select name="mode"><option value="test" ${settings.mode === 'test' ? 'selected' : ''}>Test</option><option value="live" ${settings.mode === 'live' ? 'selected' : ''}>Live</option></select></label><label>Currency<select name="currency">${['usd', 'eur', 'gbp', 'cad', 'aud'].map(c => `<option value="${c}" ${c === settings.currency ? 'selected' : ''}>${c.toUpperCase()}</option>`).join('')}</select></label></div>
      <label>Stripe secret key<input name="secretKey" type="password" autocomplete="new-password" placeholder="${settings.keyConfigured ? 'Configured — leave blank to keep' : 'sk_test_…'}"></label>
      <label>Webhook signing secret<input name="webhookSecret" type="password" autocomplete="new-password" placeholder="${settings.webhookConfigured ? 'Configured — leave blank to keep' : 'whsec_…'}"></label>
      <p class="hint">Credentials are encrypted in the database. Card details stay on Stripe’s hosted pages.</p>
      <p>Stripe webhook URL: <code>${esc(data.webhookUrl ?? 'Set PANEL_PUBLIC_URL first')}</code></p>
      <p class="hint">Use API version ${esc(data.apiVersion)}. Subscribe to checkout.session.completed, customer.subscription.*, invoice.* and customer.updated. The webhook path must be reachable without gateway sign-in.</p>
      <p class="hint">First save credentials with billing disabled. Then publish prices. Enable billing after the signed webhook is configured. Require payment for each customer when ready.</p>
      <button class="btn primary">Save Stripe settings</button></form></section>`;
  markedSections(host, 'Billing');
  host.querySelector('[data-refresh-billing]').onclick = reload;
  host.querySelectorAll('[data-open-billing]').forEach(b => { b.onclick = () => openCustomer(Number(b.dataset.openBilling)); });
  const input = () => ({ revision: settings.revision, enabled: settings.enabled, mode: settings.mode, currency: settings.currency,
    rates: data.definitions.map(d => ({ key: d.key, amountMinor: rates.get(d.key)?.amountMinor ?? null })) });
  host.querySelector('[data-price-form]').onsubmit = async event => {
    event.preventDefault();
    const body = input();
    body.rates = [...host.querySelectorAll('[data-price]')].map(e => ({ key: e.dataset.price, amountMinor: e.value === '' ? null : Math.round(Number(e.value) * 100) }));
    await action(event.submitter, async () => { await api('/api/admin/billing', { method: 'PUT', body }); toast('Draft prices saved'); await reload(); });
  };
  host.querySelector('[data-publish-prices]').onclick = async event => {
    const button = event.currentTarget;
    if (!await confirmAction('Publish the saved draft prices? Subscribed customers will use these prices after reconciliation. Stripe prorates changes.', 'Publish prices')) return;
    await action(button, async () => { await api('/api/admin/billing/publish', { method: 'POST', body: { revision: settings.revision } }); toast('Stripe prices published'); await reload(); });
  };
  host.querySelector('[data-stripe-form]').onsubmit = async event => {
    event.preventDefault();
    const f = event.target, body = { ...input(), enabled: f.enabled.checked, mode: f.mode.value, currency: f.currency.value };
    if (f.secretKey.value) body.secretKey = f.secretKey.value;
    if (f.webhookSecret.value) body.webhookSecret = f.webhookSecret.value;
    if (body.enabled && body.mode === 'live' && !await confirmAction('Enable live Stripe billing? Customers can start paid subscriptions. Required customers need verified payment for new reservations.', 'Enable live billing')) return;
    await action(event.submitter, async () => { await api('/api/admin/billing', { method: 'PUT', body }); f.secretKey.value = ''; f.webhookSecret.value = ''; toast('Stripe settings saved'); await reload(); });
  };
  async function action(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.innerHTML; button.innerHTML = loading('Working…');
    try { await fn(); } catch (err) { fail(err); }
    finally { button.disabled = false; button.innerHTML = label; }
  }
  async function openCustomer(id) {
    dialog?.close();
    const d = document.createElement('dialog'); dialog = d; d.className = 'access-rule-modal'; d.setAttribute('aria-label', 'Customer billing');
    d.innerHTML = `<p role="status">${loading()}</p>`; document.body.append(d); d.addEventListener('close', () => d.remove(), { once: true }); d.showModal();
    let customer, invoices = [];
    async function render() {
      if (!active || !d.isConnected) return;
      const { account, summary } = customer;
      d.innerHTML = `<div class="settings access-editor"><div class="section-head"><h2>Billing for ${esc(customer.customer.name)}</h2><button type="button" class="btn" data-close>Close</button></div>
        <form data-account><label>Billing email<input type="email" name="email" value="${esc(account.email ?? '')}" maxlength="254"></label><label class="check"><input type="checkbox" name="required" ${account.required ? 'checked' : ''}>Require a verified paid subscription for new reservations</label><button class="btn primary">Save customer billing</button></form>
        <p role="status">Subscription: <strong>${esc(account.status)}</strong>. Payment: ${account.paymentValid ? 'Verified' : 'Not verified'}.${account.cancelAtPeriodEnd ? ' Cancellation is scheduled.' : ''}</p>
        ${account.lastError ? `<p class="form-error">${esc(account.lastError)}</p>` : ''}${billingSummaryHtml(summary)}
        <div class="row"><button class="btn" data-reconcile>Reconcile with Stripe</button><button class="btn" data-draft ${summary.complete ? '' : 'disabled'}>Create draft invoice</button><button class="btn" data-invoices>Load invoices</button></div>
        <h3>Draft invoices</h3><div data-draft-list>${invoiceDraftsHtml(customer.drafts)}</div><button class="btn" data-more-drafts ${customer.draftsHasMore ? '' : 'hidden'}>Load older drafts</button><div data-invoice-list>${invoicesHtml(invoices)}</div><button class="btn" data-more hidden>Load older invoices</button></div>`;
      d.querySelector('[data-close]').onclick = () => d.close();
      d.querySelector('[data-account]').onsubmit = async event => { event.preventDefault(); await action(event.submitter, async () => {
        customer = await api(`/api/admin/customers/${id}/billing`, { method: 'PUT', body: { required: event.target.required.checked, email: event.target.email.value.trim() || null } }); await render();
      }); };
      d.querySelector('[data-reconcile]').onclick = event => action(event.currentTarget, async () => { customer = await api(`/api/admin/customers/${id}/billing/reconcile`, { method: 'POST' }); await render(); });
      d.querySelector('[data-draft]').onclick = event => action(event.currentTarget, async () => { await api(`/api/admin/customers/${id}/billing/drafts`, { method: 'POST' }); customer = await api(`/api/admin/customers/${id}/billing`); await render(); });
      const loadInvoices = async (button, after) => action(button, async () => {
        const result = await api(`/api/admin/customers/${id}/billing/invoices${after ? `?after=${encodeURIComponent(after)}` : ''}`);
        invoices = after ? [...invoices, ...result.items] : result.items;
        d.querySelector('[data-invoice-list]').innerHTML = invoicesHtml(invoices);
        const more = d.querySelector('[data-more]'); more.hidden = !result.hasMore; more.onclick = () => loadInvoices(more, invoices.at(-1)?.id);
      });
      d.querySelector('[data-more-drafts]').onclick = event => action(event.currentTarget, async () => {
        const result = await api(`/api/admin/customers/${id}/billing/drafts?before=${encodeURIComponent(customer.drafts.at(-1).id)}`);
        customer.drafts.push(...result.items); customer.draftsHasMore = result.hasMore;
        d.querySelector('[data-draft-list]').innerHTML = invoiceDraftsHtml(customer.drafts); d.querySelector('[data-more-drafts]').hidden = !result.hasMore;
      });
      d.querySelector('[data-invoices]').onclick = event => loadInvoices(event.currentTarget);
    }
    try { customer = await api(`/api/admin/customers/${id}/billing`); await render(); }
    catch (err) { d.close(); fail(err); }
  }
  return () => { active = false; dialog?.close(); };
}
