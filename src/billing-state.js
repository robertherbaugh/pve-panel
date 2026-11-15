// Monetary values use integer minor units. Stripe owns invoice proration and tax.
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { seal, open } from './secrets.js';
import { customerById } from './tenancy.js';
import { computeCatalog, computeProfile, SERVICE_TIERS, STORAGE_CLASSES } from './compute-catalog.js';

export const billingError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, expose: true });
const fail = (message, statusCode) => { throw billingError(message, statusCode); };
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inventories = new Map();
export const forgetBillingInventory = customerId => inventories.delete(customerId);
export function recordBillingInventory(customerId, revision, unmanaged) { inventories.set(customerId, { revision, unmanaged, at: Date.now() }); }
export const now = () => new Date().toISOString();
const money = n => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;
export const objectKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));

db.exec(`
  CREATE TABLE IF NOT EXISTS billing_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
    instance_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'test', currency TEXT NOT NULL DEFAULT 'usd',
    draft_rates TEXT NOT NULL DEFAULT '[]', active_rates TEXT NOT NULL DEFAULT '[]',
    active_revision INTEGER NOT NULL DEFAULT 0, stripe_account_id TEXT,
    secret_key TEXT, webhook_secret TEXT
  );
  CREATE TABLE IF NOT EXISTS billing_customers (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
    required INTEGER NOT NULL DEFAULT 0, email TEXT, stripe_customer_id TEXT UNIQUE,
    subscription_id TEXT UNIQUE, checkout_session_id TEXT, checkout_request TEXT, sync_request TEXT,
    status TEXT NOT NULL DEFAULT 'not_configured', payment_valid INTEGER NOT NULL DEFAULT 0,
    validated_at TEXT, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    synced_hash TEXT, last_error TEXT, invoice_url TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS billing_invoice_drafts (
    id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
    created_at TEXT NOT NULL, document TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS billing_drafts_customer ON billing_invoice_drafts(customer_id,created_at);
  CREATE TABLE IF NOT EXISTS billing_webhook_events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL,
    received_at TEXT NOT NULL, processed_at TEXT
  );
`);
db.prepare('INSERT OR IGNORE INTO billing_settings(id,revision,instance_id) VALUES(1,0,?)').run(randomUUID());

export function billingSettings({ secrets = false } = {}) {
  const r = db.prepare('SELECT * FROM billing_settings WHERE id=1').get();
  return {
    revision: r.revision, enabled: !!r.enabled, mode: r.mode, currency: r.currency,
    instanceId: r.instance_id, stripeAccountId: r.stripe_account_id,
    draftRates: JSON.parse(r.draft_rates), activeRates: JSON.parse(r.active_rates), activeRevision: r.active_revision,
    keyConfigured: !!r.secret_key, webhookConfigured: !!r.webhook_secret,
    ...(secrets ? { secretKey: r.secret_key ? open('billing:stripe', r.secret_key) : null,
      webhookSecret: r.webhook_secret ? open('billing:webhook', r.webhook_secret) : null } : {}),
  };
}

export function priceDefinitions() {
  return [
    ...SERVICE_TIERS.map(id => ({ key: `tier:${id}`, label: `${id[0].toUpperCase()}${id.slice(1)} service`, unit: 'customer / month' })),
    ...computeCatalog().sizes.map(s => ({ key: `size:${s.id}`, label: `${s.name} compute`, unit: 'VM / month' })),
    ...STORAGE_CLASSES.map(s => ({ key: `disk:${s.id}`, label: `${s.name} VM storage`, unit: 'GiB / month' })),
    { key: 'addon:ha', label: 'High availability', unit: 'VM / month' },
    { key: 'addon:backups', label: 'Backup service', unit: 'customer / month' },
    { key: 'backup:basic', label: 'Basic backup storage', unit: 'reserved GiB / month' },
  ];
}

export function saveBillingSettings(input) {
  if (!objectKeys(input, ['revision', 'enabled', 'mode', 'currency', 'rates', 'secretKey', 'webhookSecret'])) fail('Invalid billing settings');
  const current = billingSettings();
  if (input.revision !== current.revision) fail('Billing settings changed. Reload before saving.', 409);
  if (typeof input.enabled !== 'boolean' || !['test', 'live'].includes(input.mode) || !['usd', 'eur', 'gbp', 'cad', 'aud'].includes(input.currency)) fail('Choose a supported currency and Stripe mode');
  const linked = db.prepare('SELECT 1 FROM billing_customers WHERE stripe_customer_id IS NOT NULL LIMIT 1').get();
  if (linked && (input.mode !== current.mode || input.currency !== current.currency)) fail('Stripe mode and currency cannot change after customers are linked.', 409);
  const changedCurrencyOrMode = input.mode !== current.mode || input.currency !== current.currency;
  if (changedCurrencyOrMode && input.enabled) fail('Publish prices in the new currency or mode before enabling billing.');
  if (input.secretKey && (typeof input.secretKey !== 'string' || !new RegExp(`^(sk|rk)_${input.mode}_[A-Za-z0-9]{8,}$`).test(input.secretKey))) fail('The Stripe secret key must match the selected mode');
  if (input.webhookSecret && (typeof input.webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]{8,}$/.test(input.webhookSecret))) fail('Enter a Stripe webhook signing secret');
  if (input.enabled && (!(current.keyConfigured || input.secretKey) || !(current.webhookConfigured || input.webhookSecret) || !current.activeRevision)) fail('Configure credentials and publish prices before enabling billing');
  const definitions = new Map(priceDefinitions().map(p => [p.key, p]));
  if (!Array.isArray(input.rates) || input.rates.length > 120) fail('Invalid billing prices');
  const seen = new Set();
  const rates = input.rates.map(r => {
    if (!objectKeys(r, ['key', 'amountMinor']) || !definitions.has(r.key) || seen.has(r.key) || !(r.amountMinor === null || money(r.amountMinor))) fail('Prices must be unique and use nonnegative integer minor units');
    seen.add(r.key);
    return { ...definitions.get(r.key), amountMinor: r.amountMinor };
  });
  const update = db.prepare(`UPDATE billing_settings SET revision=revision+1,enabled=?,mode=?,currency=?,draft_rates=?,
    secret_key=COALESCE(?,secret_key),webhook_secret=COALESCE(?,webhook_secret) WHERE id=1 AND revision=?`)
    .run(input.enabled ? 1 : 0, input.mode, input.currency, JSON.stringify(rates),
      input.secretKey ? seal('billing:stripe', input.secretKey) : null,
      input.webhookSecret ? seal('billing:webhook', input.webhookSecret) : null, input.revision);
  if (!update.changes) fail('Billing settings changed. Reload before saving.', 409);
  if (changedCurrencyOrMode) db.prepare("UPDATE billing_settings SET active_rates='[]',active_revision=0 WHERE id=1").run();
  // A changed API credential must be verified against the linked Stripe account.
  if (input.secretKey) db.prepare('UPDATE billing_customers SET payment_valid=0,validated_at=NULL').run();
  return billingSettings();
}

export function billingAccount(customerId) {
  if (!customerById(customerId)) fail('Customer not found', 404);
  const r = db.prepare('SELECT * FROM billing_customers WHERE customer_id=?').get(customerId);
  return r ?? { customer_id: customerId, required: 0, email: null, stripe_customer_id: null, subscription_id: null,
    checkout_session_id: null, checkout_request: null, sync_request: null, status: 'not_configured', payment_valid: 0, validated_at: null, period_end: null,
    cancel_at_period_end: 0, synced_hash: null, last_error: null, invoice_url: null };
}

export function ensureBillingAccount(customerId) {
  billingAccount(customerId);
  db.prepare('INSERT OR IGNORE INTO billing_customers(customer_id,updated_at) VALUES(?,?)').run(customerId, now());
  return billingAccount(customerId);
}

export function saveBillingAccount(customerId, input) {
  if (!objectKeys(input, ['required', 'email']) || typeof input.required !== 'boolean' ||
    (input.email !== null && (typeof input.email !== 'string' || input.email.length > 254 || !/^\S+@\S+\.\S+$/.test(input.email)))) fail('Enter a valid billing email and payment requirement');
  ensureBillingAccount(customerId);
  if (input.required && !billingAccount(customerId).required) {
    const summary = billingSummary(customerId);
    if (!billingSettings().enabled || !summary.complete || !summary.inventoryVerified || summary.unmanagedVms) fail('Enable billing, configure all prices and adopt existing VMs before requiring payments.', 409);
  }
  db.prepare('UPDATE billing_customers SET required=?,email=?,updated_at=? WHERE customer_id=?').run(input.required ? 1 : 0, input.email, now(), customerId);
  return billingAccount(customerId);
}

export function billingSummary(customerId) {
  const profile = computeProfile(customerId), settings = billingSettings();
  const definitions = new Map(priceDefinitions().map(d => [d.key, d]));
  const rates = new Map(settings.activeRates.map(r => [r.key, r]));
  const quantities = new Map();
  const add = (key, count) => {
    if (!Number.isSafeInteger(count) || count < 0) fail('Reserved billing quantities need provider reconciliation', 409);
    quantities.set(key, (quantities.get(key) ?? 0) + count);
  };
  add(`tier:${profile.tier}`, 1);
  const allocations = db.prepare('SELECT vmid,offering FROM compute_allocations WHERE customer_id=? AND ended_at IS NULL ORDER BY vmid').all(customerId);
  for (const row of allocations) {
    const a = JSON.parse(row.offering);
    add(`size:${a.sizeId}`, 1); add(`disk:${a.storageClassId}`, a.diskGb);
    if (a.haEnabled) add('addon:ha', 1);
  }
  if (profile.backupServiceEnabled && !profile.backupServiceIncluded) add('addon:backups', 1);
  const backup = db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) bytes FROM compute_backup_reservations WHERE customer_id=? AND state!='released'").get(customerId);
  if (backup.bytes > 0) add('backup:basic', Math.ceil(backup.bytes / 2 ** 30));
  const lines = [...quantities].filter(([, quantity]) => quantity > 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, quantity]) => {
    const rate = rates.get(key), amount = rate?.amountMinor == null ? null : rate.amountMinor * quantity;
    if (amount !== null && !Number.isSafeInteger(amount)) fail('The billing amount exceeds the supported limit', 409);
    return { key, label: rate?.label ?? definitions.get(key)?.label ?? key, unit: rate?.unit ?? '', quantity,
      unitAmountMinor: rate?.amountMinor ?? null, amountMinor: amount, stripePriceId: rate?.stripePriceId ?? null };
  });
  const complete = lines.every(l => l.amountMinor !== null && l.stripePriceId);
  const subtotalMinor = lines.reduce((n, l) => n + (l.amountMinor ?? 0), 0);
  if (!Number.isSafeInteger(subtotalMinor)) fail('The billing total exceeds the supported limit', 409);
  const assignedUnmanaged = db.prepare(`SELECT count(*) n FROM vms v WHERE v.customer_id=? AND NOT EXISTS
    (SELECT 1 FROM compute_allocations a WHERE a.customer_id=v.customer_id AND a.vmid=v.vmid AND a.ended_at IS NULL)`).get(customerId).n;
  const customer = customerById(customerId), inventory = inventories.get(customerId);
  const inventoryVerified = !customer.pools.length || !!(inventory && inventory.revision === customer.revision && Date.now() - inventory.at < 5 * 60_000);
  const unmanagedVms = Math.max(assignedUnmanaged, inventoryVerified ? inventory?.unmanaged ?? 0 : 0);
  const pendingOperations = db.prepare("SELECT count(*) n FROM compute_operations WHERE customer_id=? AND state NOT IN ('complete','cancelled')").get(customerId).n;
  return { customerId, currency: settings.currency, enabled: settings.enabled, mode: settings.mode,
    pricingRevision: settings.activeRevision, lines, subtotalMinor, complete, inventoryVerified, unmanagedVms, pendingOperations,
    backupServiceIncluded: profile.backupServiceIncluded, backupStorageClass: 'basic',
    measure: 'reserved-monthly', taxIncluded: false,
    hash: fingerprint({ revision: settings.activeRevision, lines: lines.map(l => [l.stripePriceId, l.quantity]) }) };
}

export function offeringCostIncreases(before, after) {
  const rates = new Map(billingSettings().activeRates.map(r => [r.key, r.amountMinor]));
  const cost = a => {
    const size = rates.get(`size:${a.sizeId}`), disk = rates.get(`disk:${a.storageClassId}`);
    return size == null || disk == null ? null : size + disk * a.diskGb;
  };
  const previous = cost(before), next = cost(after);
  return previous === null || next === null || next > previous;
}

export function assertBillingAccess(customerId, extraKeys = []) {
  const account = billingAccount(customerId);
  if (!account.required && !account.subscription_id) return;
  const settings = billingSettings(), summary = billingSummary(customerId);
  const priced = new Set(settings.activeRates.filter(r => r.stripePriceId && r.amountMinor !== null).map(r => r.key));
  if (!settings.enabled || !summary.complete || !summary.inventoryVerified || summary.unmanagedVms || extraKeys.some(k => !priced.has(k))) fail('Billing is not ready for this reservation. Contact the provider.', 402);
  if (!account.payment_valid || !['active', 'trialing'].includes(account.status) || account.cancel_at_period_end ||
    !account.validated_at || Date.now() - Date.parse(account.validated_at) > 5 * 60_000 || account.synced_hash !== summary.hash) fail('A current paid subscription is required. Open Billing to check or update payment.', 402);
}

export function saveInvoiceDraft(customerId, document) {
  const id = randomUUID(), createdAt = now();
  db.prepare('INSERT INTO billing_invoice_drafts(id,customer_id,created_at,document) VALUES(?,?,?,?)').run(id, customerId, createdAt, JSON.stringify(document));
  return { id, customerId, createdAt, ...document };
}
export function invoiceDraftPage(customerId, before) {
  billingAccount(customerId);
  let cursor;
  if (before !== undefined) {
    if (typeof before !== 'string' || !/^[a-f0-9-]{36}$/.test(before)) fail('Invalid draft cursor');
    cursor = db.prepare('SELECT created_at,id FROM billing_invoice_drafts WHERE customer_id=? AND id=?').get(customerId, before);
    if (!cursor) fail('Draft cursor not found', 404);
  }
  const rows = cursor
    ? db.prepare('SELECT * FROM billing_invoice_drafts WHERE customer_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 26').all(customerId, cursor.created_at, cursor.id)
    : db.prepare('SELECT * FROM billing_invoice_drafts WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 26').all(customerId);
  return { items: rows.slice(0,25).map(r => ({ id:r.id, customerId:r.customer_id, createdAt:r.created_at, ...JSON.parse(r.document) })), hasMore: rows.length > 25 };
}
