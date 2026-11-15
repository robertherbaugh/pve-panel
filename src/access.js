import { rememberAuthorization, forgetAuthorization, authorizationFor } from './oidc-authorizations.js';
export { rememberAuthorization, forgetAuthorization, authorizationFor };
// OIDC-derived, application-scoped authorization. Local account ownership is
// retained for legacy assignments; policy-created servers always require policy.
import { db } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests } from './pve.js';
import { customerContext, customerById, legacyPolicyCustomer } from './tenancy.js';

export const ACTIONS = Object.freeze([
  'view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback',
  'backup.read', 'backup.create', 'backup.delete', 'backup.restore', 'backup.files', 'backup.schedule',
  'updates.read', 'updates.run', 'resize', 'reinstall', 'delete', 'extend', 'tailscale.read', 'tailscale.manage', 'clone',
]);
export const DEFAULT_POLICY = Object.freeze({ version: 1, enabled: false, allowedDomains: [], rules: [] });
const KEY = 'access_policy';
const OWNER_ACTIONS = ['resize', 'reinstall', 'extend', 'tailscale.read', 'tailscale.manage', 'backup.schedule', 'backup.restore'];
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
  if (domains.some((d) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d))) throw fail('Use exact email domains without wildcards');
  const ruleIds = new Set();
  const rules = input.rules.map((r) => {
    keys(r, ['id', 'customerId', 'name', 'enabled', 'groups', 'entitlements', 'match', 'pools', 'tags', 'vmids', 'actions', 'clone'], 'rule');
    if(r.customerId!=null&&(!Number.isSafeInteger(r.customerId)||!customerById(r.customerId))) throw fail('Choose an existing customer for each permission set');
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw fail('Rule enabled must be a boolean');
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id) || ruleIds.has(r.id)) throw fail('Rule IDs must be unique lowercase identifiers');
    ruleIds.add(r.id);
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100) throw fail('Rule needs a name of 1–100 characters');
    const groups = strings(r.groups ?? [], 'groups');
    const entitlements = strings(r.entitlements ?? [], 'entitlements');
    if (!groups.length && !entitlements.length) throw fail('Rule needs at least one group or entitlement');
    if (!['any', 'all'].includes(r.match ?? 'any')) throw fail('match must be any or all');
    const resourcePools = strings(r.pools, 'pools', 16);
    if (!resourcePools.length || resourcePools.some((p) => !poolName(p))) throw fail('Use exact pool IDs without wildcards');
    if(r.customerId!=null&&resourcePools.some(p=>!customerById(r.customerId).pools.includes(p))) throw fail('Permission pools must belong to the selected customer');
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
    return { id: r.id, customerId:r.customerId??null, name: r.name.trim(), enabled: r.enabled ?? true, groups, entitlements, match: r.match ?? 'any', pools: resourcePools,
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
  db.exec('BEGIN IMMEDIATE');
  try {
  if(policy.rules.some(r=>r.customerId==null)) {
    const id=legacyPolicyCustomer(policy);
    policy.rules=policy.rules.map(r=>({...r,customerId:r.customerId??id}));
  } else if(policy.allowedDomains.length && policy.rules.length) throw fail('Configure email domains on the customer’s SSO membership settings');
  policy.allowedDomains=[];
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(KEY, JSON.stringify(policy));
  db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  pools.clear();
  return policy;
}

export function matchingRules(req) {
  const policy = accessPolicy();
  const auth = authorizationFor(req);
  const customer=customerContext(req);
  if (!policy.enabled || !auth || !customer) return [];
  if (policy.allowedDomains.length && (auth.email.split('@').length !== 2 || !policy.allowedDomains.includes(auth.email.split('@')[1]))) return [];
  return policy.rules.filter((r) => {
    if (r.enabled === false || r.customerId!==customer.id || r.pools.some(p=>!customer.pools.includes(p))) return false;
    const matches = [r.groups.length ? r.groups.some((g) => auth.groups.includes(g)) : null,
      r.entitlements.length ? r.entitlements.some((e) => auth.entitlements.includes(e)) : null].filter((v) => v !== null);
    return r.match === 'all' ? matches.every(Boolean) : matches.some(Boolean);
  });
}

export async function poolMembers(pool) {
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
export async function customerHasGuest(customer, guest, row) {
  if(!customer || !guest || guest.template || Number(guest.vmid)===config.vpn.gatewayVmid) return false;
  if(row?.customer_id!=null && row.customer_id!==customer.id) return false;
  if(!customer.pools.length) return row?.customer_id===customer.id;
  const memberships=await Promise.all(customer.pools.map(poolMembers));
  return memberships.some(ids=>ids.has(Number(guest.vmid)));
}
const roleActions = {
  member:[],viewer:['view'],operator:['view','power','console','snapshot.create','snapshot.delete','snapshot.rollback'],
  admin:ACTIONS.filter(a=>a!=='clone'),
};
export async function permittedActions(req, guest) {
  const customer=customerContext(req);
  const row=guest?db.prepare('SELECT * FROM vms WHERE vmid=?').get(Number(guest.vmid)):null;
  if(!await customerHasGuest(customer,guest,row)) return [];
  const tags=new Set(String(guest.tags??'').split(';').filter(Boolean));
  const matching=matchingRules(req).filter(r=>(!r.vmids.length||r.vmids.includes(Number(guest.vmid)))&&r.tags.every(t=>tags.has(t)));
  const membership=new Map(await Promise.all([...new Set(matching.flatMap(r=>r.pools))].map(async pool=>[pool,await poolMembers(pool)])));
  const currentCustomer=customerContext(req);
  if(!currentCustomer || currentCustomer.id!==customer.id) return [];
  const current=new Set(matchingRules(req).map(r=>JSON.stringify(r)));
  return [...new Set([...(roleActions[currentCustomer.role]??[]),...matching.filter(r=>current.has(JSON.stringify(r))&&r.pools.some(p=>membership.get(p).has(Number(guest.vmid))))
    .flatMap(r=>r.actions.filter(a=>a!=='clone'))])];
}
export async function authorizedRow(req,vmid,action='view') {
  if(!Number.isSafeInteger(vmid)||vmid<100) throw missing();
  const customer=customerContext(req);
  if(!customer) throw missing();
  const row=db.prepare('SELECT * FROM vms WHERE vmid=?').get(vmid);
  if(row?.customer_id!=null&&row.customer_id!==customer.id) throw missing();
  // Preserve legacy ownership only inside its migrated personal customer.
  if(row?.customer_id===customer.id&&customer.legacy&&!customer.pools.length&&customer.role==='admin'&&!row.access_managed) return row;
  if(row?.customer_id===customer.id&&row.state!=='ready') {
    if(customer.role==='admin' || row.user_id===req.account.id&&cloneRules(req).some(r=>r.actions.includes(action)&&r.id===JSON.parse(row.spec??'{}').accessRuleId)) {
      if(['view','delete'].includes(action)) return row;
    }
    throw missing();
  }
  const guest=(await clusterGuests()).get(vmid);
  const actions=await permittedActions(req,guest);
  if(!actions.includes('view')||!actions.includes(action)) throw missing();
  if(OWNER_ACTIONS.includes(action)&&row?.user_id!==req.account.id&&customer.role!=='admin') throw missing();
  if(row?.access_managed&&LEGACY_ONLY.includes(action)) throw missing();
  if(row?.access_managed&&action==='resize') {
    const spec=JSON.parse(row.spec??'{}');
    if(!cloneRules(req).some(r=>r.id===spec.accessRuleId&&r.clone.pool===spec.pool)) throw missing();
  }
  if(!row&&!['view','power','console','snapshot.create','snapshot.delete','snapshot.rollback','delete'].includes(action)) throw missing();
  const deletion = db.prepare('SELECT state,error FROM vm_deletions WHERE vmid=? AND finished_at IS NULL').get(vmid);
  return row??{vmid,customer_id:customer.id,user_id:null,type:guest.type,state:deletion ? deletion.state === 'review' ? 'failed' : 'deleting' : 'ready',error:deletion?.error,label:null,created_by_customer:0,access_managed:1};
}
export async function visibleRows(req) {
  const customer=customerContext(req);
  if(!customer) return [];
  const own=db.prepare('SELECT * FROM vms WHERE customer_id=? ORDER BY vmid').all(customer.id);
  const rows=new Map();
  for(const row of own) { try { rows.set(row.vmid,await authorizedRow(req,row.vmid)); } catch(e) { if(e.statusCode!==404) throw e; } }
  if(matchingRules(req).length||customer.role!=='member') {
    for(const guest of (await clusterGuests()).values()) {
      if(rows.has(Number(guest.vmid))) continue;
      try { rows.set(Number(guest.vmid),await authorizedRow(req,Number(guest.vmid))); } catch(e) { if(e.statusCode!==404) throw e; }
    }
  }
  return [...rows.values()].sort((a,b)=>a.vmid-b.vmid);
}
export async function capabilities(req,row,guest) {
  const customer=customerContext(req);
  if(!customer || row.customer_id!==customer.id) return [];
  if(customer.legacy&&!customer.pools.length&&customer.role==='admin'&&!row.access_managed) return ACTIONS.filter(a=>a!=='clone');
  const available=await permittedActions(req,guest);
  return available.filter(a=>{
    if(OWNER_ACTIONS.includes(a)&&row.user_id!==req.account.id&&customer.role!=='admin') return false;
    if(LEGACY_ONLY.includes(a)&&row.access_managed) return false;
    if(a==='resize'&&row.access_managed) {
      const spec=JSON.parse(row.spec??'{}');
      if(!cloneRules(req).some(r=>r.id===spec.accessRuleId&&r.clone.pool===spec.pool)) return false;
    }
    if(row.user_id===null&&!['view','power','console','snapshot.create','snapshot.delete','snapshot.rollback','delete'].includes(a)) return false;
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
    'POST /api/vms/:vmid/ha': 'power', 'POST /api/vms/:vmid/resize': 'resize', 'POST /api/vms/:vmid/reinstall': 'reinstall',
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
