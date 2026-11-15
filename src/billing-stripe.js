import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { pve, clusterGuests } from './pve.js';
import { config } from './config.js';
import { customerById } from './tenancy.js';
import {
  billingSettings, billingAccount, ensureBillingAccount, billingSummary, billingError,
  assertBillingAccess, fingerprint, now, saveInvoiceDraft, recordBillingInventory,
} from './billing-state.js';

export const STRIPE_API_VERSION = '2026-10-28.endive';
let cachedClient;
const locks = new Map();
const idOf = v => typeof v === 'string' ? v : v?.id;
const fail = (message, status = 409) => { throw billingError(message, status); };
const modeMatches = (object, settings) => object.livemode === (settings.mode === 'live');
const metadata = (settings, customerId) => ({ panel_instance: settings.instanceId, panel_customer_id: String(customerId) });
const key = (settings, purpose) => `panel:${settings.instanceId}:${purpose}`;

export async function serializeBilling(customerId, fn) {
  const previous = locks.get(customerId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  locks.set(customerId, run);
  try { return await run; } finally { if (locks.get(customerId) === run) locks.delete(customerId); }
}

export async function stripeClient() {
  const settings = billingSettings({ secrets: true });
  if (!settings.secretKey) fail('Configure the Stripe secret key first');
  if (cachedClient?.revision === settings.revision) return cachedClient.client;
  const options = { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 15_000 };
  // An isolated HTTP simulator is available to tests only. Production always uses api.stripe.com.
  if (process.env.NODE_ENV === 'test' && process.env.STRIPE_TEST_API_URL) {
    const u = new URL(process.env.STRIPE_TEST_API_URL);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') fail('Invalid Stripe test endpoint');
    Object.assign(options, { host: u.hostname, port: Number(u.port), protocol: 'http' });
  }
  const client = new Stripe(settings.secretKey, options);
  try {
    const account = await client.accounts.retrieve();
    if (settings.stripeAccountId && account.id !== settings.stripeAccountId) fail('The Stripe key belongs to a different account');
    db.prepare('UPDATE billing_settings SET stripe_account_id=? WHERE id=1 AND revision=?').run(account.id, settings.revision);
    cachedClient = { revision: settings.revision, client };
    return client;
  } catch (err) {
    if (err.expose) throw err;
    fail('Stripe credentials could not be verified. Check the key and account permissions.', 502);
  }
}

export async function verifyBillingInventory(customerId) {
  const customer = customerById(customerId);
  if (!customer?.pools.length) return;
  const inventory = await clusterGuests(true), ids = new Set();
  for (const pool of customer.pools) {
    const result = await pve.get(`/pools/${encodeURIComponent(pool)}`);
    if (!Array.isArray(result?.members)) fail('Customer pool inventory cannot be verified.');
    for (const member of result.members) {
      if (!['qemu','lxc'].includes(member.type)) continue;
      const id = Number(member.vmid), guest = inventory.get(id);
      if (!guest) fail('A pool member is missing from the visible VM inventory. Verify provider VM audit permissions.');
      if (guest.template || id === config.vpn.gatewayVmid) continue;
      const row = db.prepare('SELECT customer_id FROM vms WHERE vmid=?').get(id);
      if (row && row.customer_id !== customerId) continue;
      if (!db.prepare('SELECT 1 FROM compute_allocations WHERE customer_id=? AND vmid=? AND ended_at IS NULL').get(customerId, id)) ids.add(id);
    }
  }
  if (customerById(customerId)?.revision !== customer.revision) fail('Customer settings changed. Retry billing verification.');
  recordBillingInventory(customerId, customer.revision, ids.size);
}

function itemsFor(summary) {
  if (!summary.complete || !summary.inventoryVerified || summary.unmanagedVms) fail('Configure all prices and adopt existing VMs before subscribing.');
  if (summary.lines.length > 20) fail('Stripe Checkout supports at most 20 recurring price items per customer.');
  return summary.lines.map(l => ({ price: l.stripePriceId, quantity: l.quantity }));
}

export async function publishBillingPrices(revision) {
  return serializeBilling('prices', async () => {
    const settings = billingSettings();
    if (settings.revision !== revision) fail('Billing settings changed. Reload before publishing.');
    if (!settings.draftRates.some(r => r.amountMinor !== null)) fail('Set at least one price before publishing.');
    const stripe = await stripeClient(), rates = [];
    for (const rate of settings.draftRates) {
      if (rate.amountMinor === null) { rates.push(rate); continue; }
      const prior = settings.activeRates.find(r => r.key === rate.key && r.amountMinor === rate.amountMinor && r.currency === settings.currency);
      if (prior?.stripePriceId) { rates.push({ ...rate, currency: settings.currency, stripePriceId: prior.stripePriceId }); continue; }
      const digest = fingerprint([revision, rate.key, rate.amountMinor, settings.currency]);
      const product = await stripe.products.create({ name: rate.label,
        metadata: { panel_instance: settings.instanceId, panel_rate: rate.key } }, { idempotencyKey: key(settings, `product:${fingerprint([rate.key, rate.label])}`) });
      const price = await stripe.prices.create({ product: product.id, currency: settings.currency,
        unit_amount: rate.amountMinor, recurring: { interval: 'month' }, tax_behavior: 'exclusive',
        metadata: { panel_instance: settings.instanceId, panel_rate: rate.key } }, { idempotencyKey: key(settings, `price:${digest}`) });
      if (!modeMatches(price, settings) || price.currency !== settings.currency || price.unit_amount !== rate.amountMinor) fail('Stripe returned a price in the wrong mode or currency.');
      rates.push({ ...rate, currency: settings.currency, stripePriceId: price.id });
    }
    const updated = db.prepare('UPDATE billing_settings SET active_rates=?,active_revision=?,revision=revision+1 WHERE id=1 AND revision=?')
      .run(JSON.stringify(rates), revision + 1, revision);
    if (!updated.changes) fail('Billing settings changed while Stripe prices were being published. Retry with the current revision.');
    db.prepare('UPDATE billing_customers SET payment_valid=0,validated_at=NULL').run();
    return billingSettings();
  });
}

export function billingReturnUrl() {
  const base = config.oidc.publicUrl.customer;
  if (!base) fail('Configure PANEL_PUBLIC_URL before enabling Stripe Checkout.');
  const u = new URL(base);
  if (u.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && u.hostname === '127.0.0.1')) fail('Stripe requires a public HTTPS customer portal.');
  u.hash = 'billing';
  return u.href;
}

export function stripeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['checkout.stripe.com', 'billing.stripe.com', 'invoice.stripe.com', 'pay.stripe.com'].includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

async function ensureStripeCustomer(customerId, stripe, settings) {
  let a = ensureBillingAccount(customerId);
  if (a.stripe_customer_id) {
    if (a.email) await stripe.customers.update(a.stripe_customer_id, { email: a.email });
    return a;
  }
  const customer = customerById(customerId), email = a.email || customer.contact_email;
  if (!email) fail('Set the customer billing email before starting a subscription.');
  const remote = await stripe.customers.create({ name: customer.name, email, metadata: metadata(settings, customerId) },
    { idempotencyKey: key(settings, `customer:${customerId}`) });
  if (!modeMatches(remote, settings)) fail('Stripe returned a customer in the wrong mode.');
  db.prepare('UPDATE billing_customers SET stripe_customer_id=?,updated_at=? WHERE customer_id=? AND stripe_customer_id IS NULL').run(remote.id, now(), customerId);
  return billingAccount(customerId);
}

async function attachCompletedCheckout(customerId, stripe, settings) {
  let a = billingAccount(customerId);
  if (a.checkout_request) {
    const request = JSON.parse(a.checkout_request);
    if (Date.now() - request.created > 23 * 60 * 60_000) fail('A previous Stripe request has an unknown outcome. The provider must reconcile it in Stripe.');
    const session = await stripe.checkout.sessions.create(request.payload, { idempotencyKey: key(settings, `checkout:${request.id}`) });
    if (!modeMatches(session, settings) || (session.status === 'open' && !stripeUrl(session.url))) fail('Stripe Checkout did not return a valid hosted URL.');
    db.prepare('UPDATE billing_customers SET checkout_session_id=?,checkout_request=NULL WHERE customer_id=?').run(session.id, customerId);
    a = billingAccount(customerId);
  }
  if (a.subscription_id || !a.checkout_session_id) return a;
  const session = await stripe.checkout.sessions.retrieve(a.checkout_session_id);
  if (!modeMatches(session, settings) || idOf(session.customer) !== a.stripe_customer_id || session.client_reference_id !== String(customerId)) fail('Stripe Checkout ownership could not be verified.');
  if (session.status === 'complete' && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(idOf(session.subscription));
    verifySubscription(sub, a, settings);
    db.prepare('UPDATE billing_customers SET subscription_id=?,checkout_session_id=NULL,checkout_request=NULL,updated_at=? WHERE customer_id=? AND subscription_id IS NULL').run(sub.id, now(), customerId);
  } else if (session.status === 'expired') {
    db.prepare('UPDATE billing_customers SET checkout_session_id=NULL WHERE customer_id=?').run(customerId);
  }
  return billingAccount(customerId);
}

export async function checkoutBilling(customerId) {
  return serializeBilling(customerId, async () => {
    const settings = billingSettings();
    if (!settings.enabled || !settings.webhookConfigured) fail('Billing is not enabled.');
    await verifyBillingInventory(customerId);
    const returnUrl = billingReturnUrl(), summary = billingSummary(customerId), lineItems = itemsFor(summary);
    const stripe = await stripeClient();
    let a = await ensureStripeCustomer(customerId, stripe, settings);
    a = await attachCompletedCheckout(customerId, stripe, settings);
    if (a.subscription_id) {
      const sub = await stripe.subscriptions.retrieve(a.subscription_id);
      verifySubscription(sub, a, settings);
      if (!['canceled', 'incomplete_expired'].includes(sub.status)) fail('This customer already has a subscription. Use the billing portal to manage it.');
      db.prepare('UPDATE billing_customers SET subscription_id=NULL,synced_hash=NULL,payment_valid=0 WHERE customer_id=?').run(customerId);
    }
    if (a.checkout_session_id) {
      const prior = await stripe.checkout.sessions.retrieve(a.checkout_session_id);
      if (prior.status === 'open') {
        // Expire the previous form so changed reservations cannot be checked out twice.
        await stripe.checkout.sessions.expire(prior.id);
      }
    }
    const payload = { mode: 'subscription', customer: a.stripe_customer_id,
      client_reference_id: String(customerId), line_items: lineItems,
      success_url: returnUrl, cancel_url: returnUrl, payment_method_collection: 'always', payment_method_types: ['card'],
      billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' },
      subscription_data: { metadata: metadata(settings, customerId) }, metadata: metadata(settings, customerId) };
    const request = { id: randomUUID(), payload, created: Date.now() };
    db.prepare('UPDATE billing_customers SET checkout_request=? WHERE customer_id=?').run(JSON.stringify(request), customerId);
    const session = await stripe.checkout.sessions.create(payload, { idempotencyKey: key(settings, `checkout:${request.id}`) });
    if (!modeMatches(session, settings) || !stripeUrl(session.url)) fail('Stripe Checkout did not return a valid hosted payment URL.');
    db.prepare("UPDATE billing_customers SET checkout_session_id=?,checkout_request=NULL,status='checkout_pending',payment_valid=0,updated_at=? WHERE customer_id=?")
      .run(session.id, now(), customerId);
    return { url: stripeUrl(session.url) };
  });
}

function verifySubscription(sub, a, settings) {
  if (!modeMatches(sub, settings) || idOf(sub.customer) !== a.stripe_customer_id || sub.metadata?.panel_instance !== settings.instanceId ||
    sub.metadata?.panel_customer_id !== String(a.customer_id)) fail('Stripe subscription ownership could not be verified.');
  if (sub.items?.has_more) fail('The subscription has too many items for automatic reconciliation.');
}

export async function reconcileBilling(customerId) {
  return serializeBilling(customerId, async () => {
    const settings = billingSettings();
    let a = billingAccount(customerId);
    await verifyBillingInventory(customerId);
    if (!a.stripe_customer_id) return a;
    try {
      const stripe = await stripeClient();
      if (a.email) await stripe.customers.update(a.stripe_customer_id, { email: a.email });
      a = await attachCompletedCheckout(customerId, stripe, settings);
      if (!a.subscription_id) return a;
      let sub = await stripe.subscriptions.retrieve(a.subscription_id, { expand: ['latest_invoice', 'default_payment_method'] });
      verifySubscription(sub, a, settings);
      if (a.sync_request) {
        const pending = JSON.parse(a.sync_request);
        if (Date.now() - pending.created > 23 * 60 * 60_000) fail('A Stripe subscription update has an unknown outcome. Provider reconciliation is required.');
        sub = await stripe.subscriptions.update(sub.id, pending.payload, { idempotencyKey: key(settings, `sync:${pending.id}`) });
        verifySubscription(sub, a, settings);
        db.prepare('UPDATE billing_customers SET sync_request=NULL WHERE customer_id=?').run(customerId);
      }
      const summary = billingSummary(customerId);
      let synced = false;
      if (settings.enabled && summary.complete && summary.inventoryVerified && !summary.unmanagedVms && ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status) && !sub.pause_collection) {
        const desired = itemsFor(summary);
        const desiredMap = new Map(desired.map(item => [item.price, item.quantity]));
        const actual = sub.items.data.map(item => [idOf(item.price), item.quantity]).sort();
        const target = [...desiredMap].sort();
        if (fingerprint(actual) !== fingerprint(target)) {
          const updates = sub.items.data.map(item => desiredMap.has(idOf(item.price))
            ? { id: item.id, quantity: desiredMap.get(idOf(item.price)), price: idOf(item.price) }
            : { id: item.id, deleted: true });
          const existing = new Set(sub.items.data.map(item => idOf(item.price)));
          updates.push(...desired.filter(item => !existing.has(item.price)));
          const payload = { items: updates, proration_behavior: ['past_due', 'unpaid'].includes(sub.status) ? 'none' : 'always_invoice',
            payment_behavior: 'allow_incomplete', expand: ['latest_invoice', 'default_payment_method'] };
          const request = { id: randomUUID(), created: Date.now(), payload };
          db.prepare('UPDATE billing_customers SET sync_request=? WHERE customer_id=?').run(JSON.stringify(request), customerId);
          sub = await stripe.subscriptions.update(sub.id, payload, { idempotencyKey: key(settings, `sync:${request.id}`) });
          verifySubscription(sub, a, settings);
          db.prepare('UPDATE billing_customers SET sync_request=NULL WHERE customer_id=?').run(customerId);
        }
        // If reservations changed during the network request, the next pass reconciles them.
        const confirmed = sub.items.data.map(item => [idOf(item.price), item.quantity]).sort();
        synced = fingerprint(confirmed) === fingerprint(target) && billingSummary(customerId).hash === summary.hash;
      }
      const invoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      const remoteCustomer = await stripe.customers.retrieve(a.stripe_customer_id);
      if (remoteCustomer.deleted || !modeMatches(remoteCustomer, settings)) fail('The Stripe customer is unavailable.');
      const hasPayment = !!(sub.default_payment_method || remoteCustomer.invoice_settings?.default_payment_method);
      const unpaid = await stripe.invoices.list({ customer: a.stripe_customer_id, status: 'open', limit: 100 });
      const overdue = unpaid.has_more || unpaid.data.some(i => i.amount_remaining > 0 && (!i.due_date || i.due_date < Date.now() / 1000));
      const settled = invoice?.status === 'paid';
      const paymentValid = synced && !overdue && !sub.pause_collection && !sub.cancel_at_period_end &&
        ((sub.status === 'active' && settled) || (sub.status === 'trialing' && hasPayment));
      const periodEnd = Math.max(0, ...sub.items.data.map(i => i.current_period_end ?? 0)) || null;
      db.prepare(`UPDATE billing_customers SET status=?,payment_valid=?,validated_at=?,period_end=?,cancel_at_period_end=?,
        synced_hash=?,last_error=NULL,invoice_url=?,updated_at=? WHERE customer_id=?`)
        .run(sub.status, paymentValid ? 1 : 0, now(), periodEnd, sub.cancel_at_period_end ? 1 : 0,
          synced ? summary.hash : null, stripeUrl(invoice?.hosted_invoice_url), now(), customerId);
      return billingAccount(customerId);
    } catch (err) {
      db.prepare('UPDATE billing_customers SET payment_valid=0,validated_at=NULL,last_error=?,updated_at=? WHERE customer_id=?')
        .run('Stripe verification is unavailable. Retry reconciliation.', now(), customerId);
      if (err.expose) throw err;
      fail('Stripe verification is unavailable. Check the provider configuration and retry.', 502);
    }
  });
}

export async function requireBillingAccess(customerId, extraKeys = []) {
  const a = billingAccount(customerId);
  if (!a.required && !a.subscription_id) return;
  try { await reconcileBilling(customerId); }
  catch { fail('Payment status cannot be verified. Open Billing or contact the provider.', 402); }
  assertBillingAccess(customerId, extraKeys);
}

export async function billingPortal(customerId) {
  const settings = billingSettings(), a = billingAccount(customerId);
  if (!settings.enabled || !a.stripe_customer_id) fail('No Stripe billing account is linked.');
  const stripe = await stripeClient();
  const portalConfig = await stripe.billingPortal.configurations.create({
    features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' } },
  }, { idempotencyKey: key(settings, 'portal-configuration:v1') });
  const session = await stripe.billingPortal.sessions.create({ customer: a.stripe_customer_id,
    configuration: portalConfig.id, return_url: billingReturnUrl() });
  if (!stripeUrl(session.url)) fail('Stripe did not return a valid billing portal URL.');
  return { url: stripeUrl(session.url) };
}

export async function createBillingDraft(customerId) {
  await verifyBillingInventory(customerId);
  const settings = billingSettings(), a = billingAccount(customerId), summary = billingSummary(customerId);
  itemsFor(summary);
  if (!a.subscription_id) return saveInvoiceDraft(customerId, { source: 'reservation-estimate', status: 'draft', currency: summary.currency,
    subtotalMinor: summary.subtotalMinor, totalMinor: summary.subtotalMinor, taxCalculated: false, lines: summary.lines,
    pricingRevision: summary.pricingRevision, notice: 'Not payable. Monthly reservation estimate before tax, discounts and proration.' });
  await reconcileBilling(customerId);
  const stripe = await stripeClient();
  const invoice = await stripe.invoices.createPreview({ customer: a.stripe_customer_id, subscription: a.subscription_id });
  if (!modeMatches(invoice, settings) || idOf(invoice.customer) !== a.stripe_customer_id || invoice.currency !== settings.currency) fail('Stripe invoice ownership could not be verified.');
  const lines = [];
  // Preview IDs can be used with the invoice line-items endpoint.
  for await (const line of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) {
    lines.push({ label: line.description ?? 'Subscription charge', quantity: line.quantity ?? 1, amountMinor: line.amount,
      period: line.period });
  }
  return saveInvoiceDraft(customerId, { source: 'stripe-preview', status: 'draft', stripePreviewId: invoice.id,
    currency: invoice.currency, subtotalMinor: invoice.subtotal, totalMinor: invoice.total, taxCalculated: true,
    lines, pricingRevision: summary.pricingRevision, notice: 'Not payable. Stripe preview includes current proration, discounts and applicable tax.' });
}

export async function billingInvoices(customerId, startingAfter) {
  const a = billingAccount(customerId), settings = billingSettings();
  if (!a.stripe_customer_id) return { items: [], hasMore: false };
  if (startingAfter !== undefined && (typeof startingAfter !== 'string' || !/^in_[A-Za-z0-9]+$/.test(startingAfter))) fail('Invalid invoice cursor', 400);
  const stripe = await stripeClient();
  const result = await stripe.invoices.list({ customer: a.stripe_customer_id, limit: 25, ...(startingAfter ? { starting_after: startingAfter } : {}) });
  for (const i of result.data) if (!modeMatches(i, settings) || idOf(i.customer) !== a.stripe_customer_id) fail('Stripe invoice ownership could not be verified.');
  return { items: result.data.map(i => ({ id: i.id, number: i.number, status: i.status, currency: i.currency,
    totalMinor: i.total, paidMinor: i.amount_paid, dueMinor: i.amount_remaining, createdAt: i.created,
    url: stripeUrl(i.hosted_invoice_url) })), hasMore: result.has_more };
}

export async function receiveBillingWebhook(rawBody, signature) {
  const settings = billingSettings({ secrets: true });
  if (!settings.webhookSecret || typeof signature !== 'string') fail('A valid Stripe signature is required', 400);
  let event;
  try { event = Stripe.webhooks.constructEvent(rawBody, signature, settings.webhookSecret, 300); }
  catch { fail('Invalid or expired Stripe signature', 400); }
  if (!modeMatches(event, settings) || event.account) fail('Stripe event mode or account does not match', 400);
  if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof event.type !== 'string') fail('Invalid Stripe event', 400);
  return serializeBilling(`event:${event.id}`, async () => {
    const prior = db.prepare('SELECT state FROM billing_webhook_events WHERE id=?').get(event.id);
    if (prior?.state === 'done') return { received: true, duplicate: true };
    db.prepare("INSERT OR IGNORE INTO billing_webhook_events(id,type,state,received_at) VALUES(?,?,'pending',?)").run(event.id, event.type, now());
    const supported = event.type.startsWith('customer.subscription.') || event.type.startsWith('invoice.') ||
      ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'customer.updated'].includes(event.type);
    if (supported) {
      const remoteId = event.type === 'customer.updated' ? event.data.object.id : idOf(event.data?.object?.customer);
      const a = typeof remoteId === 'string' ? db.prepare('SELECT customer_id FROM billing_customers WHERE stripe_customer_id=?').get(remoteId) : null;
      // Payload fields never grant access. Retrieve current subscription state from Stripe.
      if (a) await reconcileBilling(a.customer_id);
    }
    db.prepare("UPDATE billing_webhook_events SET state='done',processed_at=? WHERE id=?").run(now(), event.id);
    return { received: true };
  });
}

export function startBillingReconciliation(log) {
  let running = false;
  const run = async () => {
    if (running || !billingSettings().enabled) return;
    running = true;
    try {
      for (const a of db.prepare('SELECT b.customer_id FROM billing_customers b JOIN customers c ON c.id=b.customer_id WHERE b.stripe_customer_id IS NOT NULL AND c.deleted_at IS NULL').all()) {
        try { await reconcileBilling(a.customer_id); }
        catch { log.warn({ customerId: a.customer_id }, 'Billing reconciliation requires attention'); }
      }
    } finally { running = false; }
  };
  const timer = setInterval(run, 60_000); timer.unref();
  const first = setTimeout(run, 1000); first.unref();
}
