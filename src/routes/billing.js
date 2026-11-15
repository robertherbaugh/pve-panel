import { db, audit } from '../db.js';
import { customerById, allCustomers, requireCustomerAdmin } from '../tenancy.js';
import {
  billingSettings, saveBillingSettings, priceDefinitions, billingSummary,
  billingAccount, saveBillingAccount, invoiceDraftPage, billingError, forgetBillingInventory,
} from '../billing-state.js';
import {
  publishBillingPrices, reconcileBilling, checkoutBilling, billingPortal,
  createBillingDraft, billingInvoices, receiveBillingWebhook, billingReturnUrl, STRIPE_API_VERSION, verifyBillingInventory,
} from '../billing-stripe.js';

const params = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const safe = fn => async (...args) => {
  try { return await fn(...args); }
  catch (err) {
    if (err.expose || err.statusCode && err.statusCode < 500) throw err;
    throw billingError('Stripe could not complete this request. Check the billing configuration and retry.', 502);
  }
};
function publicAccount(a) {
  return { customerId: a.customer_id, required: !!a.required, email: a.email, linked: !!a.stripe_customer_id,
    subscribed: !!a.subscription_id, status: a.status, paymentValid: !!a.payment_valid,
    validatedAt: a.validated_at, periodEnd: a.period_end, cancelAtPeriodEnd: !!a.cancel_at_period_end,
    lastError: a.last_error, invoiceUrl: a.invoice_url };
}
const detail = async id => {
  try { await verifyBillingInventory(id); } catch { forgetBillingInventory(id); }
  const drafts = invoiceDraftPage(id); return ({ customer: { id, name: customerById(id)?.name }, summary: billingSummary(id),
  account: publicAccount(billingAccount(id)), drafts: drafts.items, draftsHasMore: drafts.hasMore }); };

export async function adminBillingRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.get('/api/admin/billing', async () => {
    let webhookUrl = null;
    try { webhookUrl = new URL('/api/billing/webhook', billingReturnUrl()).href; } catch { /* public URL is not configured */ }
    return { settings: billingSettings(), definitions: priceDefinitions(), apiVersion: STRIPE_API_VERSION, webhookUrl,
      customers: await Promise.all(allCustomers().map(async c => ({ id: c.id, name: c.name, ...await detail(c.id) }))) };
  });
  app.put('/api/admin/billing', async req => {
    const result = saveBillingSettings(req.body);
    audit(req, null, 'admin_billing_settings', { revision: result.revision, mode: result.mode, enabled: result.enabled });
    return result;
  });
  app.post('/api/admin/billing/publish', safe(async req => {
    if (!req.body || !Number.isSafeInteger(req.body.revision) || Object.keys(req.body).some(k => k !== 'revision')) throw billingError('Provide the current pricing revision');
    const result = await publishBillingPrices(req.body.revision);
    audit(req, null, 'admin_billing_prices_published', { revision: result.activeRevision, mode: result.mode });
    return result;
  }));
  app.get('/api/admin/customers/:id/billing', { schema: { params } }, req => detail(Number(req.params.id)));
  app.put('/api/admin/customers/:id/billing', { schema: { params } }, async req => {
    const id = Number(req.params.id); await verifyBillingInventory(id);
    const a = saveBillingAccount(id, req.body);
    audit({ account: req.account, ip: req.ip, customerId: id }, null, 'admin_customer_billing', { required: !!a.required, email: a.email });
    return detail(id);
  });
  app.post('/api/admin/customers/:id/billing/reconcile', { schema: { params } }, safe(async req => {
    const id = Number(req.params.id);
    await reconcileBilling(id);
    audit({ account: req.account, ip: req.ip, customerId: id }, null, 'admin_billing_reconciled');
    return detail(id);
  }));
  app.get('/api/admin/customers/:id/billing/drafts', { schema: { params } }, req => invoiceDraftPage(Number(req.params.id), req.query.before));
  app.post('/api/admin/customers/:id/billing/drafts', { schema: { params } }, safe(async req => {
    const id = Number(req.params.id), draft = await createBillingDraft(id);
    audit({ account: req.account, ip: req.ip, customerId: id }, null, 'admin_billing_draft', { draftId: draft.id, source: draft.source });
    return draft;
  }));
  app.get('/api/admin/customers/:id/billing/invoices', { schema: { params } }, safe(req => billingInvoices(Number(req.params.id), req.query.after)));
}

export async function customerBillingRoutes(app) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.get('/api/billing', async req => detail(requireCustomerAdmin(req).id));
  app.put('/api/billing', async req => {
    const id = requireCustomerAdmin(req).id;
    if (!req.body || Object.keys(req.body).some(k => k !== 'email')) throw billingError('Only the billing email can be changed');
    saveBillingAccount(id, { required: !!billingAccount(id).required, email: req.body.email });
    audit(req, null, 'customer_billing_email');
    return detail(id);
  });
  app.post('/api/billing/checkout', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, safe(req => checkoutBilling(requireCustomerAdmin(req).id)));
  app.post('/api/billing/portal', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, safe(req => billingPortal(requireCustomerAdmin(req).id)));
  app.post('/api/billing/refresh', safe(async req => {
    const id = requireCustomerAdmin(req).id;
    await reconcileBilling(id);
    return detail(id);
  }));
  app.get('/api/billing/invoices', safe(req => billingInvoices(requireCustomerAdmin(req).id, req.query.after)));
  app.get('/api/billing/drafts', req => invoiceDraftPage(requireCustomerAdmin(req).id, req.query.before));
  app.post('/api/billing/drafts', safe(req => createBillingDraft(requireCustomerAdmin(req).id)));
}

export async function billingWebhookRoutes(app) {
  // This parser is encapsulated to this plugin. Signature verification uses the exact bytes.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.post('/api/billing/webhook', { bodyLimit: 1024 * 1024, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    safe(req => receiveBillingWebhook(req.body, req.headers['stripe-signature'])));
}
