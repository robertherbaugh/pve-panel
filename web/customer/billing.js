import { api, esc, loading, fail, toast } from '/shared/ui.js';
import {
  billingSummaryHtml,
  invoiceDraftsHtml,
  invoicesHtml,
} from '/shared/billing-ui.js';
import { sectionTabs } from '/shared/sections.js';

export function renderCustomerBilling(host) {
  let current = true,
    data,
    invoices = [],
    more = false,
    emailDraft,
    pageRoot;
  const customer = document.querySelector('#customer-context')?.value;
  const present = () =>
    current &&
    host.isConnected &&
    pageRoot?.isConnected &&
    document.querySelector('#customer-context')?.value === customer;
  async function action(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = loading('Working…');
    try {
      await fn();
    } catch (err) {
      if (present()) fail(err);
    } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  }
  async function refresh() {
    data = await api('/api/billing');
    if (present()) render();
  }
  async function loadInvoices(button, after) {
    await action(button, async () => {
      const result = await api(
        `/api/billing/invoices${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      );
      if (!present()) return;
      invoices = after ? [...invoices, ...result.items] : result.items;
      more = result.hasMore;
      render();
    });
  }
  function render() {
    const { account, summary } = data;
    const canSubscribe =
      !account.subscribed ||
      ['canceled', 'incomplete_expired'].includes(account.status);
    host.innerHTML = `<div class="page billing-page"><header class="page-head"><div><h1>Billing</h1><p class="lede">Reservations and invoices for ${esc(data.customer.name)}.</p></div></header>
      ${!summary.enabled ? '<p class="notice">Billing has not been enabled by your provider. Reservations are shown for review.</p>' : ''}
      <section class="security-card" data-billing-section="subscription"><h2>Subscription and payment</h2><p role="status">Subscription: <strong>${esc(account.status)}</strong>. Payment: ${account.paymentValid ? 'Verified' : 'Not verified'}.</p>
      ${account.required ? '<p class="hint">A verified subscription is required for new billable reservations. Existing servers remain available while payment is resolved.</p>' : ''}
      ${account.cancelAtPeriodEnd ? '<p class="notice warn">Cancellation is scheduled at the end of the billing period. New billable reservations are disabled.</p>' : ''}
      ${account.periodEnd ? `<p class="hint">Current period ends ${esc(new Date(account.periodEnd * 1000).toLocaleDateString())}.</p>` : ''}
      ${account.lastError ? `<p class="form-error">${esc(account.lastError)}</p>` : ''}
      <form class="row billing-email-form" data-email><label>Billing email<input type="email" name="email" required maxlength="254" value="${esc(emailDraft ?? account.email ?? '')}"></label><button class="btn">Save billing email</button></form>
      <div class="row billing-toolbar"><button class="btn primary" data-checkout ${summary.enabled && summary.complete && summary.inventoryVerified && !summary.unmanagedVms && canSubscribe ? '' : 'disabled'}>${canSubscribe ? 'Subscribe with Stripe' : 'Subscription linked'}</button><button class="btn" data-portal ${summary.enabled && account.linked ? '' : 'disabled'}>Manage payment and subscription</button><button class="btn" data-refresh>Verify payment</button></div>
      <p class="hint">Stripe securely collects card details. Checkout completion is verified with Stripe before payment grants access. Use the payment portal to cancel a subscription.</p></section>
      <section class="security-card" data-billing-section="cost"><h2>Cost summary</h2>${billingSummaryHtml(summary)}<button class="btn" data-draft ${summary.complete && !summary.unmanagedVms ? '' : 'disabled'}>Create draft invoice</button></section>
      <section class="security-card" data-billing-section="drafts"><h2>Draft invoices</h2>${invoiceDraftsHtml(data.drafts)}${data.draftsHasMore ? '<button class="btn" data-more-drafts>Load older drafts</button>' : ''}</section>
      <section class="security-card" data-billing-section="invoices"><div class="section-head"><h2>Stripe invoices</h2><button class="btn" data-invoices>Load invoices</button></div>${invoicesHtml(invoices)}${more ? '<button class="btn" data-more>Load older invoices</button>' : ''}</section></div>`;
    pageRoot = host.firstElementChild;
    const sections = [
      ['subscription', 'Subscription'],
      ['cost', 'Cost summary'],
      ['drafts', 'Draft invoices'],
      ['invoices', 'Stripe invoices'],
    ].map(([id, label]) => ({
      id,
      label,
      nodes: [pageRoot.querySelector(`[data-billing-section="${id}"]`)],
    }));
    sectionTabs(pageRoot, 'Billing', sections, {
      before: sections[0].nodes[0],
      selectionKey: `customer-billing:${customer}`,
    });
    host.querySelector('[data-email] input').oninput = (event) => {
      emailDraft = event.target.value;
    };
    host.querySelector('[data-email]').onsubmit = (event) => {
      event.preventDefault();
      const email = event.target.email.value.trim();
      action(event.submitter, async () => {
        await api('/api/billing', { method: 'PUT', body: { email } });
        emailDraft = undefined;
        toast('Billing email saved');
        await refresh();
      });
    };
    for (const [selector, path] of [
      ['[data-checkout]', 'checkout'],
      ['[data-portal]', 'portal'],
    ]) {
      host.querySelector(selector).onclick = (event) =>
        action(event.currentTarget, async () => {
          const result = await api(`/api/billing/${path}`, { method: 'POST' });
          if (present()) location.assign(result.url);
        });
    }
    host.querySelector('[data-refresh]').onclick = (event) =>
      action(event.currentTarget, async () => {
        await api('/api/billing/refresh', { method: 'POST' });
        await refresh();
      });
    host.querySelector('[data-draft]').onclick = (event) =>
      action(event.currentTarget, async () => {
        await api('/api/billing/drafts', { method: 'POST' });
        await refresh();
      });
    host
      .querySelector('[data-more-drafts]')
      ?.addEventListener('click', (event) =>
        action(event.currentTarget, async () => {
          const result = await api(
            `/api/billing/drafts?before=${encodeURIComponent(data.drafts.at(-1).id)}`,
          );
          if (!present()) return;
          data.drafts.push(...result.items);
          data.draftsHasMore = result.hasMore;
          render();
        }),
      );
    host.querySelector('[data-invoices]').onclick = (event) =>
      loadInvoices(event.currentTarget);
    host
      .querySelector('[data-more]')
      ?.addEventListener('click', (event) =>
        loadInvoices(event.currentTarget, invoices.at(-1)?.id),
      );
  }
  host.innerHTML = `<p role="status">${loading('Loading billing…')}</p>`;
  pageRoot = host.firstElementChild;
  refresh().catch((err) => {
    if (present()) {
      host.textContent = 'Billing could not be loaded.';
      fail(err);
    }
  });
  return () => {
    current = false;
  };
}
