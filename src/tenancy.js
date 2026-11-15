import { db } from './db.js';
import { config } from './config.js';
import { authorizationFor } from './oidc-authorizations.js';

export const MEMBER_ROLES = ['member', 'viewer', 'operator', 'admin'];
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const array = (v, name, limit = 128) => {
  if (
    !Array.isArray(v) ||
    v.length > limit ||
    v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)
  )
    throw error(`Invalid ${name}`);
  return [...new Set(v.map((x) => x.trim()))];
};
const unpack = (row) =>
  row
    ? {
        ...row,
        pools: JSON.parse(row.pools),
        allowedDomains: JSON.parse(row.domains),
        sso: {
          groups: JSON.parse(row.sso_groups),
          entitlements: JSON.parse(row.sso_entitlements),
          match: row.sso_match,
          required: !!row.sso_required,
        },
        expiry: {
          mode: row.expiry_mode ?? '',
          days: row.expiry_days,
          date: row.expiry_date,
          selfExtend: !!row.expiry_self_extend,
        },
        maxBackups: row.max_backups,
        enabled: !!row.enabled,
        legacy: row.legacy_user_id !== null,
        limits: {
          servers: row.max_servers,
          cores: row.max_cores,
          memoryMb: row.max_memory_mb,
          diskGb: row.max_disk_gb,
        },
      }
    : null;
export function customerById(id) {
  return unpack(db.prepare('SELECT * FROM customers WHERE id=?').get(id));
}
export function allCustomers() {
  return db
    .prepare('SELECT * FROM customers ORDER BY name,id')
    .all()
    .map((r) => ({
      ...unpack(r),
      members: db
        .prepare('SELECT count(DISTINCT user_id) AS n FROM customer_memberships WHERE customer_id=?')
        .get(r.id).n,
      servers: db.prepare('SELECT count(*) AS n FROM vms WHERE customer_id=?').get(r.id).n,
    }));
}
export function personalCustomer(userId) {
  let row = db.prepare('SELECT * FROM customers WHERE legacy_user_id=?').get(userId);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!row && user && !user.tenant_initialized) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const id = Number(
        db
          .prepare(
            'INSERT INTO customers(name,slug,legacy_user_id,sso_required,contact_email) VALUES(?,?,?,0,?)',
          )
          .run(user.email, `personal-${user.id}`, user.id, user.email).lastInsertRowid,
      );
      db.prepare(
        'UPDATE customers SET expiry_mode=?,expiry_days=?,expiry_date=?,expiry_self_extend=?,max_backups=? WHERE id=?',
      ).run(
        user.expiry_mode,
        user.expiry_days,
        user.expiry_date,
        user.expiry_self_extend,
        user.max_backups,
        id,
      );
      db.prepare("INSERT INTO customer_memberships(customer_id,user_id,role) VALUES(?,?,'admin')").run(
        id,
        userId,
      );
      for (const t of [
        'vms',
        'tasks',
        'networks',
        'vpn_devices',
        'tailscale',
        'backups',
        'backup_jobs',
        'backup_schedules',
        'winupdates',
      ])
        db.prepare(`UPDATE ${t} SET customer_id=? WHERE user_id=? AND customer_id IS NULL`).run(id, userId);
      db.prepare('UPDATE users SET tenant_initialized=1 WHERE id=?').run(userId);
      db.exec('COMMIT');
      row = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return unpack(row);
}
export function hasSharedResources(userId) {
  const personal = personalCustomerId(userId);
  return (
    [
      'vms',
      'tasks',
      'networks',
      'vpn_devices',
      'tailscale',
      'backups',
      'backup_jobs',
      'backup_schedules',
      'winupdates',
    ].some(
      (t) =>
        !!db
          .prepare(`SELECT 1 FROM ${t} WHERE user_id=? AND (customer_id IS NULL OR customer_id<>?)`)
          .get(userId, personal ?? -1),
    ) ||
    !!db
      .prepare('SELECT 1 FROM customer_memberships WHERE user_id=? AND customer_id<>?')
      .get(userId, personal ?? -1) ||
    !!(
      personal &&
      db
        .prepare('SELECT 1 FROM customer_memberships WHERE customer_id=? AND user_id<>?')
        .get(personal, userId)
    )
  );
}
export function personalCustomerId(id) {
  return personalCustomer(id)?.id ?? null;
}
export function matchesClaims(sso, auth, domains = []) {
  if (!auth) return false;
  if (domains.length && (auth.email.split('@').length !== 2 || !domains.includes(auth.email.split('@')[1])))
    return false;
  const matches = [
    sso.groups.length ? sso.groups.some((g) => auth.groups.includes(g)) : null,
    sso.entitlements.length ? sso.entitlements.some((e) => auth.entitlements.includes(e)) : null,
  ].filter((v) => v !== null);
  return matches.length > 0 && (sso.match === 'all' ? matches.every(Boolean) : matches.some(Boolean));
}
export function availableCustomers(req) {
  const identity = db.prepare('SELECT disabled,deleting FROM users WHERE id=?').get(req.account.id);
  if (!identity || identity.disabled || identity.deleting) return [];
  personalCustomer(req.account.id);
  const auth = authorizationFor(req);
  return allCustomers().flatMap((c) => {
    if (!c.enabled || (c.sso.required && !auth)) return [];
    if (
      db
        .prepare('SELECT 1 FROM customer_membership_blocks WHERE customer_id=? AND user_id=?')
        .get(c.id, req.account.id)
    )
      return [];
    const manual = db
      .prepare("SELECT role FROM customer_memberships WHERE customer_id=? AND user_id=? AND source='manual'")
      .get(c.id, req.account.id);
    const mapped = matchesClaims(c.sso, auth, c.allowedDomains);
    if (!manual && !mapped) return [];
    return [{ ...c, role: manual?.role ?? 'member', membershipSource: manual ? 'manual' : 'oidc' }];
  });
}
// Re-evaluate membership and enabled state on every use, including open consoles.
export function customerContext(req) {
  const eligible = availableCustomers(req);
  const chosen = req.selectedCustomerId ?? req.customer?.id;
  return chosen != null
    ? (eligible.find((c) => c.id === chosen) ?? null)
    : (eligible.find((c) => c.membershipSource === 'oidc') ?? eligible[0] ?? null);
}
export function requireCustomer(req) {
  const c = customerContext(req);
  if (!c) throw error('Select a customer with an active membership', 403);
  req.customer = c;
  return c;
}
export function requireCustomerAdmin(req) {
  const c = requireCustomer(req);
  if (c.role !== 'admin') throw error('Customer administrator access is required', 403);
  return c;
}
export function customerMembers(id) {
  return db
    .prepare(
      `SELECT m.user_id AS userId,u.email,
      COALESCE(MAX(CASE WHEN m.source='manual' THEN m.role END),'member') AS role,
      CASE WHEN MAX(m.source='manual') THEN 'manual' ELSE 'oidc' END AS source,
      MAX(m.source='oidc') AS ssoMapped,u.disabled,MIN(m.created_at) AS createdAt
    FROM customer_memberships m JOIN users u ON u.id=m.user_id WHERE m.customer_id=? GROUP BY m.user_id ORDER BY u.email`,
    )
    .all(id);
}
export function setMembership(customerId, userId, role) {
  if (!customerById(customerId)) throw error('Customer not found', 404);
  const user = db.prepare('SELECT id,disabled,deleting FROM users WHERE id=?').get(userId);
  if (!user || user.disabled || user.deleting) throw error('Active user not found', 404);
  if (!MEMBER_ROLES.includes(role)) throw error('Invalid customer role');
  db.prepare('DELETE FROM customer_membership_blocks WHERE customer_id=? AND user_id=?').run(
    customerId,
    userId,
  );
  db.prepare(
    `INSERT INTO customer_memberships(customer_id,user_id,role,source) VALUES(?,?,?,'manual')
    ON CONFLICT(customer_id,user_id,source) DO UPDATE SET role=excluded.role`,
  ).run(customerId, userId, role);
}
export function removeMembership(customerId, userId) {
  db.prepare('DELETE FROM customer_memberships WHERE customer_id=? AND user_id=?').run(customerId, userId);
  db.prepare('INSERT OR IGNORE INTO customer_membership_blocks(customer_id,user_id) VALUES(?,?)').run(
    customerId,
    userId,
  );
}
export function rememberMemberships(user, claims) {
  const auth = {
    email: String(claims.email ?? '')
      .trim()
      .toLowerCase(),
    groups: claims[config.oidc.groupsClaim] ?? [],
    entitlements: claims[config.oidc.entitlementsClaim] ?? [],
  };
  db.prepare("DELETE FROM customer_memberships WHERE user_id=? AND source='oidc'").run(user.id);
  for (const c of allCustomers())
    if (
      c.enabled &&
      matchesClaims(c.sso, auth, c.allowedDomains) &&
      !db
        .prepare('SELECT 1 FROM customer_membership_blocks WHERE customer_id=? AND user_id=?')
        .get(c.id, user.id)
    ) {
      db.prepare(
        "INSERT OR IGNORE INTO customer_memberships(customer_id,user_id,role,source) VALUES(?,?,'member','oidc')",
      ).run(c.id, user.id);
    }
}
function validateCustomer(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Invalid customer');
  const allowed = [
    'name',
    'slug',
    'enabled',
    'pools',
    'allowedDomains',
    'sso',
    'limits',
    'expiry',
    'maxBackups',
    'contactEmail',
    'revision',
  ];
  if (Object.keys(input).some((k) => !allowed.includes(k))) throw error('Unknown customer field');
  const name = String(input.name ?? '').trim(),
    slug = String(input.slug ?? '').trim();
  if (!name || name.length > 100 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))
    throw error('Use a name and a unique lowercase customer ID');
  if (typeof input.enabled !== 'boolean') throw error('Customer enabled must be a boolean');
  const pools = array(input.pools ?? [], 'pools', 64),
    domains = array(input.allowedDomains ?? [], 'domains', 32).map((d) => d.toLowerCase());
  if (pools.some((p) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(p)))
    throw error('Use exact Proxmox pool IDs');
  if (domains.some((d) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)))
    throw error('Use exact email domains without wildcards');
  for (const c of allCustomers())
    if (c.id !== previous?.id && c.pools.some((p) => pools.includes(p)))
      throw error(`A selected pool already belongs to customer ${c.name}`, 409);
  const s = input.sso ?? {},
    sso = {
      groups: array(s.groups ?? [], 'groups'),
      entitlements: array(s.entitlements ?? [], 'entitlements'),
      match: s.match ?? 'any',
      required: s.required ?? true,
    };
  if (
    Object.keys(s).some((k) => !['groups', 'entitlements', 'match', 'required'].includes(k)) ||
    !['any', 'all'].includes(sso.match) ||
    typeof sso.required !== 'boolean'
  )
    throw error('Invalid SSO membership mapping');
  const limits = { servers: 0, cores: 0, memoryMb: 0, diskGb: 0, ...input.limits };
  if (
    Object.keys(limits).some((k) => !['servers', 'cores', 'memoryMb', 'diskGb'].includes(k)) ||
    Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 0 || v > 100_000_000)
  )
    throw error('Invalid customer limits');
  const expiry = { mode: '', days: null, date: null, selfExtend: false, ...input.expiry };
  if (
    Object.keys(expiry).some((k) => !['mode', 'days', 'date', 'selfExtend'].includes(k)) ||
    !['', 'after_creation', 'fixed_date'].includes(expiry.mode) ||
    typeof expiry.selfExtend !== 'boolean'
  )
    throw error('Invalid customer expiry settings');
  if (
    expiry.mode === 'after_creation' &&
    (!Number.isInteger(expiry.days) || expiry.days < 1 || expiry.days > 3650)
  )
    throw error('Expiry days must be between 1 and 3650');
  if (
    expiry.mode === 'fixed_date' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(expiry.date) ||
      Number.isNaN(Date.parse(expiry.date)) ||
      new Date(expiry.date).toISOString().slice(0, 10) !== expiry.date)
  )
    throw error('Choose a valid expiry date');
  const maxBackups = input.maxBackups ?? null;
  if (maxBackups !== null && (!Number.isInteger(maxBackups) || maxBackups < 0 || maxBackups > 100))
    throw error('Invalid backup limit');
  const contactEmail = 'contactEmail' in input ? input.contactEmail : (previous?.contact_email ?? null);
  if (
    contactEmail !== null &&
    (typeof contactEmail !== 'string' || contactEmail.length > 254 || !/^\S+@\S+\.\S+$/.test(contactEmail))
  )
    throw error('Invalid notification email');
  return {
    name,
    slug,
    enabled: input.enabled,
    pools,
    domains,
    sso,
    limits,
    expiry,
    maxBackups,
    contactEmail,
  };
}
export function saveCustomer(input, id = null, { policyReplacement = false } = {}) {
  const previous = id == null ? null : customerById(id);
  if (id != null && !previous) throw error('Customer not found', 404);
  const c = validateCustomer(input, previous);
  if (previous && input.revision !== previous.revision)
    throw error('Customer changed in another session. Reload before saving.', 409);
  if (db.prepare('SELECT id FROM customers WHERE slug=? AND id<>?').get(c.slug, id ?? -1))
    throw error('Customer ID already exists', 409);
  // Changing a boundary never silently broadens an existing permission set.
  const policy = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key='access_policy'").get()?.value ?? '{"rules":[]}',
  );
  if (
    !policyReplacement &&
    previous &&
    policy.rules.some((r) => r.customerId === id && r.pools.some((p) => !c.pools.includes(p)))
  )
    throw error('Remove this customer’s permission rules for those pools before changing the boundary', 409);
  const values = [
    c.name,
    c.slug,
    c.enabled ? 1 : 0,
    JSON.stringify(c.pools),
    JSON.stringify(c.domains),
    JSON.stringify(c.sso.groups),
    JSON.stringify(c.sso.entitlements),
    c.sso.match,
    c.sso.required ? 1 : 0,
    c.limits.servers,
    c.limits.cores,
    c.limits.memoryMb,
    c.limits.diskGb,
    c.expiry.mode || null,
    c.expiry.mode === 'after_creation' ? c.expiry.days : null,
    c.expiry.mode === 'fixed_date' ? c.expiry.date : null,
    c.expiry.selfExtend ? 1 : 0,
    c.maxBackups,
    c.contactEmail,
  ];
  if (previous)
    db.prepare(
      `UPDATE customers SET name=?,slug=?,enabled=?,pools=?,domains=?,sso_groups=?,sso_entitlements=?,sso_match=?,sso_required=?,max_servers=?,max_cores=?,max_memory_mb=?,max_disk_gb=?,expiry_mode=?,expiry_days=?,expiry_date=?,expiry_self_extend=?,max_backups=?,contact_email=?,revision=revision+1 WHERE id=?`,
    ).run(...values, id);
  else
    id = Number(
      db
        .prepare(
          `INSERT INTO customers(name,slug,enabled,pools,domains,sso_groups,sso_entitlements,sso_match,sso_required,max_servers,max_cores,max_memory_mb,max_disk_gb,expiry_mode,expiry_days,expiry_date,expiry_self_extend,max_backups,contact_email) VALUES(${values.map(() => '?').join(',')})`,
        )
        .run(...values).lastInsertRowid,
    );
  return customerById(id);
}
// Compatibility for version-1 API imports. All imported grants still receive
// an explicit tenant and share its pool boundary and SSO membership gate.
export function legacyPolicyCustomer(policy) {
  if (policy.rules.some((r) => r.customerId != null))
    throw error('Every rule must specify a customer when using customer-scoped policies');
  let old = allCustomers().find((c) => c.slug === 'imported-sso');
  const pools = [...new Set(policy.rules.flatMap((r) => r.pools))];
  const c = saveCustomer(
    {
      name: old?.name ?? 'Imported SSO access',
      slug: 'imported-sso',
      enabled: old?.enabled ?? true,
      pools,
      allowedDomains: policy.allowedDomains,
      sso: {
        required: true,
        match: 'any',
        groups: [...new Set(policy.rules.flatMap((r) => r.groups))],
        entitlements: [...new Set(policy.rules.flatMap((r) => r.entitlements))],
      },
      limits: old?.limits,
      expiry: old?.expiry,
      maxBackups: old?.maxBackups,
      revision: old?.revision,
    },
    old?.id,
    { policyReplacement: true },
  );
  return c.id;
}
