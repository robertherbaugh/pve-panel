import { esc } from './ui.js';

export const money = (amount, currency = 'usd') => amount == null ? 'Not priced' : new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
export function billingSummaryHtml(summary) {
  return `<div class="billing-summary"><div><span class="muted small">Reserved monthly estimate</span><p class="billing-total">${money(summary.subtotalMinor, summary.currency)}${summary.complete ? '' : ' + unpriced resources'}</p></div><span class="pill ${summary.mode === 'live' ? 'pill-running' : ''}">${summary.mode === 'live' ? 'Live billing' : 'Stripe test mode'}</span></div>
    <p class="hint">Reserved compute and disk remain billable while VMs are stopped. This estimate excludes tax, discounts and proration. Stripe calculates the invoice total.</p>
    ${!summary.inventoryVerified ? '<p class="notice warn">Customer pool inventory could not be verified. Check provider audit access before activating payments.</p>' : ''}
    ${summary.unmanagedVms ? `<p class="notice warn">${summary.unmanagedVms} existing VM(s) need catalog adoption before billing can be activated. They are not included in this estimate.</p>` : ''}
    ${summary.pendingOperations ? `<p class="hint">${summary.pendingOperations} compute operation(s) are pending. Their final allocations have not entered billing.</p>` : ''}
    <div class="table-wrap"><table class="table" data-admin-table="Billing reservations"><thead><tr><th>Reservation</th><th>Quantity</th><th>Monthly unit price</th><th>Monthly total</th></tr></thead><tbody>${summary.lines.map(l => `<tr><td>${esc(l.label)}<span class="muted small access-block">${esc(l.unit)}</span></td><td>${l.quantity}</td><td>${money(l.unitAmountMinor, summary.currency)}</td><td>${money(l.amountMinor, summary.currency)}</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">${summary.backupServiceIncluded ? 'The service tier includes backup service. ' : ''}Backup storage is always separate Basic capacity, billed in reserved GiB.</p>`;
}
export function invoiceDraftsHtml(drafts) {
  return `<div class="table-wrap"><table class="table" data-admin-table="Draft invoices"><thead><tr><th>Created</th><th>Source</th><th>Total</th><th>Details</th></tr></thead><tbody>${drafts.map(d => `<tr><td>${esc(new Date(d.createdAt).toLocaleString())}</td><td>${d.source === 'stripe-preview' ? 'Stripe invoice preview' : 'Monthly reservation estimate'}</td><td>${money(d.totalMinor, d.currency)}</td><td><details><summary>Review draft</summary><p class="hint">${esc(d.notice)}</p><ul>${d.lines.map(l => `<li>${esc(l.label)} × ${l.quantity}: ${money(l.amountMinor, d.currency)}</li>`).join('')}</ul><span class="muted small">Draft ${esc(d.id)}</span></details></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No draft invoices.</td></tr>'}</tbody></table></div>`;
}
export function invoicesHtml(invoices) {
  return `<div class="table-wrap"><table class="table" data-admin-table="Stripe invoices"><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Due</th><th>Actions</th></tr></thead><tbody>${invoices.map(i => `<tr><td>${esc(i.number || i.id)}</td><td>${esc(i.status)}</td><td>${money(i.totalMinor, i.currency)}</td><td>${money(i.dueMinor, i.currency)}</td><td>${i.url ? `<a class="btn" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${i.status === 'paid' ? 'View invoice' : 'View or pay invoice'}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No Stripe invoices.</td></tr>'}</tbody></table></div>`;
}
