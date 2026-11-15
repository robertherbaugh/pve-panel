// OIDC-derived, application-scoped authorization. Local account ownership is
// retained for legacy assignments; policy-created servers always require policy.
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests } from './pve.js';

export const ACTIONS = Object.freeze([
  'view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback',
  'backup.read', 'backup.create', 'backup.delete', 'backup.restore', 'backup.files', 'backup.schedule',
  'updates.read', 'updates.run', 'resize', 'reinstall', 'delete', 'extend', 'tailscale.read', 'tailscale.manage', 'clone',
]);
export const DEFAULT_POLICY = Object.freeze({ version: 1, enabled: false, allowedDomains: [], rules: [] });
const KEY = 'access_policy';
const OWNER_ACTIONS = ['resize', 'reinstall', 'delete', 'extend', 'tailscale.read', 'tailscale.manage', 'backup.schedule', 'backup.restore'];
const LEGACY_ONLY = ['reinstall', 'backup.schedule', 'backup.restore', 'tailscale.read', 'tailscale.manage'];
const pools = new Map();
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const missing = () => fail('Server not found', 404);
const strings = (v, name, max = 128) => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x || x.length > 200)) {
    throw fail(`${name} must be an array of at most ${max} nonempty strings (200 characters each)`);
  }
  return [...new Set(v)];
};
const keys = (o, allowed, name) => {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !allowed.includes(k))) {
    throw fail(`Invalid or unknown fields in ${name}`);
  }
};
const ids = (v, name) => {
  if (!Array.isArray(v) || v.length > 128 || v.some((x) => !Number.isSafeInteger(x) || x < 100)) throw fail(`Invalid ${name}`);
  return [...new Set(v)];
};
const poolName = (v) => typeof v === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(v);
const tagName = (v) => /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/.test(v);

export function validatePolicy(input) {
  keys(input, ['version', 'enabled', 'allowedDomains', 'rules'], 'policy');
  if (input.version !== 1 || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 64) {
    throw fail('Policy needs version 1, enabled, and at most 64 rules');
  }
  const domains = strings(input.allowedDomains, 'allowedDomains', 32).map((d) => d.toLowerCase());
  if (input.enabled && !domains.length) throw fail('An enabled policy needs allowedDomains');
  if (domains.some((d) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d))) throw fail('Use exact email domains without wildcards');
  const ruleIds = new Set();
  const rules = input.rules.map((r) => {
    keys(r, ['id', 'name', 'groups', 'entitlements', 'match', 'pools', 'tags', 'vmids', 'actions', 'clone'], 'rule');
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id) || ruleIds.has(r.id)) throw fail('Rule IDs must be unique lowercase identifiers');
    ruleIds.add(r.id);
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100) throw fail('Rule needs a name of 1–100 characters');
    const groups = strings(r.groups ?? [], 'groups');
    const entitlements = strings(r.entitlements ?? [], 'entitlements');
    if (!groups.length && !entitlements.length) throw fail('Rule needs at least one group or entitlement');
    if (!['any', 'all'].includes(r.match ?? 'any')) throw fail('match must be any or all');
    const resourcePools = strings(r.pools, 'pools', 16);
    if (!resourcePools.length || resourcePools.some((p) => !poolName(p))) throw fail('Use exact pool IDs without wildcards');
    const tags = strings(r.tags ?? [], 'tags', 32);
    if (tags.some((t) => !tagName(t))) throw fail('Invalid exact Proxmox tag');
    const vmids = ids(r.vmids ?? [], 'VM IDs');
    const actions = strings(r.actions, 'actions', ACTIONS.length);
    if (!actions.length || actions.some((a) => !ACTIONS.includes(a))) throw fail('Unknown or empty actions');
    if (actions.some((a) => a !== 'clone') && !actions.includes('view')) throw fail('VM operations also require view in the same rule');
    if (actions.includes('clone') && !actions.includes('view')) throw fail('Clone rules also need view for the new servers');
    let clone;
    if (actions.includes('clone')) {
      keys(r.clone, ['pool', 'templates', 'storages', 'limits'], 'clone');
      if (!resourcePools.includes(r.clone.pool)) throw fail('Clone destination must belong to the rule pools');
      if (vmids.length) throw fail('Clone rules cannot restrict VM IDs');
      const templates = r.clone.templates;
      if (!Array.isArray(templates) || !templates.length || templates.length > 128
        || templates.some((t) => !(Number.isSafeInteger(t) && t >= 100) && !(typeof t === 'string' && /^ct-[0-9]{1,9}$/.test(t)))) throw fail('Clone needs exact offered template IDs');
      const storages = strings(r.clone.storages, 'clone.storages', 32);
      if (!storages.length || storages.some((s) => !poolName(s))) throw fail('Clone needs exact allowed storage IDs');
      keys(r.clone.limits, ['servers', 'cores', 'memoryMb', 'diskGb'], 'clone.limits');
      for (const [k, max] of Object.entries({ servers: 1000, cores: 4096, memoryMb: 16777216, diskGb: 1048576 })) {
        if (!Number.isSafeInteger(r.clone.limits[k]) || r.clone.limits[k] < 1 || r.clone.limits[k] > max) throw fail(`Invalid clone limit ${k}`);
      }
      clone = { pool: r.clone.pool, templates: [...new Set(templates)], storages, limits: { ...r.clone.limits } };
    } else if (r.clone !== undefined) throw fail('Clone settings require clone action');
    return { id: r.id, name: r.name.trim(), groups, entitlements, match: r.match ?? 'any', pools: resourcePools,
      tags, vmids, actions, ...(clone ? { clone } : {}) };
  });
  if (new Set(rules.flatMap((r) => r.pools)).size > 64) throw fail('At most 64 distinct pools are supported');
  return { version: 1, enabled: input.enabled, allowedDomains: [...new Set(domains)], rules };
}

export function accessPolicy() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  return row ? JSON.parse(row.value) : structuredClone(DEFAULT_POLICY);
}
export function saveAccessPolicy(input) {
  const policy = validatePolicy(input);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(KEY, JSON.stringify(policy));
  pools.clear();
  return policy;
}

/** Only call with claims returned by openid-client's validated code exchange. */
export function rememberAuthorization(user, claims) {
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.oidc.issuer || claims.sub !== user.oidc_subject || !Number.isFinite(claims.exp) || claims.exp <= now) {
    throw fail('Invalid OIDC authorization identity');
  }
  if (config.oidc.requireVerifiedEmail && claims.email_verified !== true) throw fail('OIDC email must be verified');
  const identity = {
    groups: strings(claims[config.oidc.groupsClaim] ?? [], 'OIDC groups'),
    entitlements: strings(claims[config.oidc.entitlementsClaim] ?? [], 'OIDC entitlements'),
    emailVerified: claims.email_verified === true,
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
  };
  const id = crypto.randomBytes(24).toString('base64url');
  const expires = Math.min(claims.exp, now + config.oidc.authorizationMaxAge);
  db.prepare('DELETE FROM oidc_authorizations WHERE expires_at < ?').run(now - 86400);
  db.prepare(`INSERT INTO oidc_authorizations (id,user_id,issuer,subject,claims,expires_at)
    VALUES (?,?,?,?,?,?)`).run(id, user.id, claims.iss, claims.sub, JSON.stringify(identity), expires);
  return id;
}
export function authorizationFor(req) {
  if (!req.user?.az) return null;
  const row = db.prepare(`SELECT a.* FROM oidc_authorizations a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND a.issuer=u.oidc_issuer AND a.subject=u.oidc_subject`).get(req.user.az, req.account.id);
  if (!row || row.issuer !== config.oidc.issuer || row.expires_at <= Date.now() / 1000) return null;
  const identity = JSON.parse(row.claims);
  if (config.oidc.requireVerifiedEmail && identity.emailVerified !== true) return null;
  return { ...identity, expiresAt: row.expires_at };
}
export function forgetAuthorization(req) {
  if (req.user?.az) db.prepare('DELETE FROM oidc_authorizations WHERE id=? AND user_id=?').run(req.user.az, req.account.id);
}
export function matchingRules(req) {
  const policy = accessPolicy();
  const auth = authorizationFor(req);
  if (!policy.enabled || !auth || !policy.allowedDomains.includes(auth.email.split('@')[1]) || auth.email.split('@').length !== 2) return [];
  return policy.rules.filter((r) => {
    const matches = [r.groups.length ? r.groups.some((g) => auth.groups.includes(g)) : null,
      r.entitlements.length ? r.entitlements.some((e) => auth.entitlements.includes(e)) : null].filter((v) => v !== null);
    return r.match === 'all' ? matches.every(Boolean) : matches.some(Boolean);
  });
}

async function poolMembers(pool) {
  const cached = pools.get(pool);
  if (cached && Date.now() - cached.at < 5000) return cached.members;
  // Pool.Audit is needed. A failure is never replaced with a cached grant.
  try {
    const data = await pve.get(`/pools/${encodeURIComponent(pool)}`, undefined, { signal: AbortSignal.timeout(10_000) });
    if (!Array.isArray(data?.members)) throw new Error('Missing pool members');
    const members = new Set(data.members.filter((m) => ['qemu', 'lxc'].includes(m.type)).map((m) => Number(m.vmid)));
    pools.set(pool, { at: Date.now(), members });
    return members;
  } catch {
    pools.delete(pool);
    return new Set();
  }
}
export async function permittedActions(req, guest) {
  if (!guest || guest.template || guest.vmid === config.vpn.gatewayVmid) return [];
  const tags = new Set(String(guest.tags ?? '').split(';').filter(Boolean));
  const matching = matchingRules(req).filter((r) => (!r.vmids.length || r.vmids.includes(Number(guest.vmid))) && r.tags.every((t) => tags.has(t)));
  const membership = new Map(await Promise.all([...new Set(matching.flatMap((r) => r.pools))].map(async (pool) => [pool, await poolMembers(pool)])));
  const current = new Set(matchingRules(req).map((r) => JSON.stringify(r)));
  return [...new Set(matching.filter((r) => current.has(JSON.stringify(r)) && r.pools.some((p) => membership.get(p).has(Number(guest.vmid))))
    .flatMap((r) => r.actions.filter((a) => a !== 'clone')))];
}

export async function authorizedRow(req, vmid, action = 'view') {
  if (!Number.isSafeInteger(vmid) || vmid < 100) throw missing();
  const row = db.prepare('SELECT * FROM vms WHERE vmid=?').get(vmid);
  if (row?.user_id === req.account.id && !row.access_managed) return row;
  if (row?.user_id === req.account.id && row.access_managed && row.state !== 'ready') {
    const spec = JSON.parse(row.spec ?? '{}');
    const rule = cloneRules(req).find((r) => r.id === spec.accessRuleId && r.clone.pool === spec.pool);
    if (rule?.actions.includes(action) && ['view', 'delete'].includes(action)) return row;
  }
  if (row?.access_managed && action === 'resize') {
    const spec = JSON.parse(row.spec ?? '{}');
    if (!cloneRules(req).some((r) => r.id === spec.accessRuleId && r.clone.pool === spec.pool)) throw missing();
  }
  const guest = (await clusterGuests()).get(vmid);
  const actions = await permittedActions(req, guest);
  if (!actions.includes('view') || !actions.includes(action)) throw missing();
  if (row && row.state !== 'ready' && row.user_id !== req.account.id) throw missing();
  if (OWNER_ACTIONS.includes(action)
    && row?.user_id !== req.account.id) throw missing();
  // Reinstallation, backup restore and background schedules need a policy-aware
  // lifecycle. Keep these owner-only legacy features closed on managed clones.
  if (row?.access_managed && LEGACY_ONLY.includes(action)) throw missing();
  // Ownership-specific features still use their existing row and boundary.
  // Unassigned guests get no backup history, lifecycle or account-specific data.
  if (!row && !['view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback'].includes(action)) throw missing();
  return row ?? { vmid, user_id: null, type: guest.type, state: 'ready', label: null, created_by_customer: 0, access_managed: 1 };
}
export async function visibleRows(req) {
  const own = db.prepare('SELECT * FROM vms WHERE user_id=? ORDER BY vmid').all(req.account.id);
  const rows = new Map(own.filter((r) => !r.access_managed).map((r) => [r.vmid, r]));
  for (const row of own.filter((r) => r.access_managed && r.state !== 'ready')) {
    try { rows.set(row.vmid, await authorizedRow(req, row.vmid)); } catch (err) { if (err.statusCode !== 404) throw err; }
  }
  if (matchingRules(req).length) {
    for (const guest of (await clusterGuests()).values()) {
      if (rows.has(Number(guest.vmid))) continue;
      try { rows.set(Number(guest.vmid), await authorizedRow(req, Number(guest.vmid))); } catch (err) { if (err.statusCode !== 404) throw err; }
    }
  }
  return [...rows.values()].sort((a, b) => a.vmid - b.vmid);
}
export async function capabilities(req, row, guest) {
  const legacy = row.user_id === req.account.id && !row.access_managed;
  if (legacy) return ACTIONS.filter((a) => a !== 'clone');
  const available = await permittedActions(req, guest);
  return available.filter((a) => {
    if (a === 'resize' && row.access_managed) {
      const spec = JSON.parse(row.spec ?? '{}');
      if (!cloneRules(req).some((r) => r.id === spec.accessRuleId && r.clone.pool === spec.pool)) return false;
    }
    if (LEGACY_ONLY.includes(a) && row.access_managed) return false;
    if (OWNER_ACTIONS.includes(a) && row.user_id !== req.account.id) return false;
    if (row.user_id === null && !['view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback'].includes(a)) return false;
    return true;
  });
}
export function routeAction(req) {
  const key = `${req.method} ${req.routeOptions.url}`;
  return ({
    'GET /api/vms/:vmid': 'view', 'GET /api/vms/:vmid/rrd': 'view',
    'POST /api/vms/:vmid/power/:action': 'power',
    'GET /api/vms/:vmid/snapshots': 'view', 'POST /api/vms/:vmid/snapshots': 'snapshot.create',
    'DELETE /api/vms/:vmid/snapshots/:name': 'snapshot.delete', 'POST /api/vms/:vmid/snapshots/:name/rollback': 'snapshot.rollback',
    'GET /api/vms/:vmid/backups': 'backup.read', 'POST /api/vms/:vmid/backups': 'backup.create',
    'DELETE /api/vms/:vmid/backups': 'backup.delete', 'POST /api/vms/:vmid/backups/restore': 'backup.restore',
    'GET /api/vms/:vmid/backups/files': 'backup.files', 'GET /api/vms/:vmid/backups/download': 'backup.files',
    'PUT /api/vms/:vmid/backups/schedule': 'backup.schedule',
    'GET /api/vms/:vmid/updates': 'updates.read', 'POST /api/vms/:vmid/updates': 'updates.run',
    'POST /api/vms/:vmid/resize': 'resize', 'POST /api/vms/:vmid/reinstall': 'reinstall',
    'DELETE /api/vms/:vmid': 'delete', 'POST /api/vms/:vmid/extend': 'extend',
    'GET /api/vms/:vmid/tailscale': 'tailscale.read', 'POST /api/vms/:vmid/tailscale': 'tailscale.manage',
    'DELETE /api/vms/:vmid/tailscale': 'tailscale.manage',
  })[key] ?? null; // New routes default to ownership-only until explicitly mapped.
}
export function cloneRules(req) { return matchingRules(req).filter((r) => r.clone && r.actions.includes('clone')); }
export function withLimits(account, rule) {
  return { ...account, can_create: 1, max_servers: rule.clone.limits.servers, max_cores: rule.clone.limits.cores,
    max_memory_mb: rule.clone.limits.memoryMb, max_disk_gb: rule.clone.limits.diskGb };
}
export function cloneRule(req, id) {
  const rule = cloneRules(req).find((r) => r.id === id);
  if (!rule) throw fail('This cloning destination is not available', 403);
  return rule;
}
export function authorizationStatus(req) {
  const auth = authorizationFor(req);
  return { enabled: accessPolicy().enabled, expiresAt: auth?.expiresAt ?? null,
    refreshRequired: !!req.user?.az && !auth, signInUrl: config.oidc.enabled ? `${config.oidc.publicUrl.customer}/api/auth/oidc/start` : null };
}
