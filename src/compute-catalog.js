// Provider catalog and per-customer opt-in. Saving settings never mutates Proxmox.
import { db } from './db.js';
import { customerById } from './tenancy.js';

export const STORAGE_CLASSES = Object.freeze([
  { id: 'basic', name: 'Basic', media: 'HDD', description: 'Economical capacity on HDD storage.' },
  { id: 'standard', name: 'Standard', media: 'Enterprise SSD', description: 'Enterprise SSD storage, excluding NVMe.' },
  { id: 'fast', name: 'Fast', media: 'NVMe', description: 'NVMe storage for disk-intensive workloads.' },
]);
export const SERVICE_TIERS = ['basecamp', 'ridge', 'summit'];
const CLASS_IDS = STORAGE_CLASSES.map((c) => c.id);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const object = (v, keys, name) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some((k) => !keys.includes(k))) fail(`Invalid ${name}`);
  return v;
};
const integer = (v, min, max, name) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(`Invalid ${name}`);
  return v;
};
const bool = (v, name) => { if (typeof v !== 'boolean') fail(`Invalid ${name}`); return v; };
const text = (v, max, name, pattern = null) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || (pattern && !pattern.test(v))) fail(`Invalid ${name}`);
  return v.trim();
};
const identifier = (v, name) => text(v, 64, name, /^[a-z0-9][a-z0-9-]*$/);
const pveId = (v, name) => text(v, 100, name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const array = (v, max, name) => { if (!Array.isArray(v) || v.length > max) fail(`Invalid ${name}`); return v; };
const unique = (values, name) => { if (new Set(values).size !== values.length) fail(`Duplicate ${name}`); return values; };

// Revision rows retain previous offerings for review. Customer profiles are
// separate from identity membership, support rules and operation permissions.
db.exec(`
  CREATE TABLE IF NOT EXISTS compute_catalog_revisions (
    revision INTEGER PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS customer_compute_profiles (
    customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
const seed = {
  sizes: [
    { id: 'small', name: 'Small', cores: 1, memoryMb: 2048, minDiskGb: 8, enabled: false },
    { id: 'medium', name: 'Medium', cores: 2, memoryMb: 4096, minDiskGb: 8, enabled: false },
    { id: 'large', name: 'Large', cores: 4, memoryMb: 8192, minDiskGb: 8, enabled: false },
    { id: 'xlarge', name: 'Extra large', cores: 8, memoryMb: 16384, minDiskGb: 8, enabled: false },
  ],
  classes: CLASS_IDS.map((id) => ({ id, enabled: false, bindings: [] })),
  reserves: { memoryMb: 2048, diskGb: 20 },
};
db.prepare('INSERT OR IGNORE INTO compute_catalog_revisions(revision,value) VALUES(1,?)').run(JSON.stringify(seed));

export function computeCatalog() {
  const row = db.prepare('SELECT * FROM compute_catalog_revisions ORDER BY revision DESC LIMIT 1').get();
  const value = JSON.parse(row.value);
  return {
    ...value, revision: row.revision, updatedAt: row.created_at,
    classes: value.classes.map((c) => ({ ...STORAGE_CLASSES.find((s) => s.id === c.id), ...c })),
    backupClassId: 'basic', billingMode: 'reservation', rollout: 'customer-opt-in',
  };
}

function normalizeCatalog(input) {
  object(input, ['revision', 'sizes', 'classes', 'reserves'], 'catalog');
  const sizes = array(input.sizes, 100, 'sizes').map((s) => {
    object(s, ['id', 'name', 'cores', 'memoryMb', 'minDiskGb', 'enabled'], 'size');
    return {
      id: identifier(s.id, 'size ID'), name: text(s.name, 80, 'size name'),
      cores: integer(s.cores, 1, 128, 'vCPUs'), memoryMb: integer(s.memoryMb, 512, 1048576, 'memory'),
      minDiskGb: integer(s.minDiskGb, 1, 65536, 'minimum disk'), enabled: bool(s.enabled, 'size enabled'),
    };
  });
  unique(sizes.map((s) => s.id), 'size ID');
  const pairs = [];
  const classes = array(input.classes, 3, 'storage classes').map((c) => {
    object(c, ['id', 'enabled', 'bindings'], 'storage class');
    if (!CLASS_IDS.includes(c.id)) fail('Unknown storage class');
    const bindings = array(c.bindings, 128, 'storage mappings').map((b) => {
      object(b, ['node', 'storage', 'purpose'], 'storage mapping');
      const node = pveId(b.node, 'node'), storage = pveId(b.storage, 'storage');
      if (!['vm', 'backup'].includes(b.purpose)) fail('Invalid storage purpose');
      if (b.purpose === 'backup' && c.id !== 'basic') fail('Backups must use Basic storage');
      // A datastore has one media class, even if it serves several purposes.
      pairs.push({ key: `${node}/${storage}`, classId: c.id, purpose: b.purpose });
      return { node, storage, purpose: b.purpose };
    });
    unique(bindings.map((b) => `${b.node}/${b.storage}/${b.purpose}`), 'storage mapping');
    return { id: c.id, enabled: bool(c.enabled, 'class enabled'), bindings };
  });
  if (classes.length !== 3 || unique(classes.map((c) => c.id), 'storage class').length !== 3) fail('Configure Basic, Standard and Fast');
  if (pairs.some((a) => pairs.some((b) => a.key === b.key && a.classId !== b.classId))) fail('A datastore cannot belong to different storage classes on the same node');
  // Node-local datastores can share an ID while using different media.
  // Physical media and shared-datastore consistency require provider review.
  object(input.reserves, ['memoryMb', 'diskGb'], 'capacity reserves');
  const reserves = {
    memoryMb: integer(input.reserves.memoryMb, 0, 1048576, 'memory reserve'),
    diskGb: integer(input.reserves.diskGb, 0, 100000000, 'disk reserve'),
  };
  return { sizes, classes: CLASS_IDS.map((id) => classes.find((c) => c.id === id)), reserves };
}

export function saveComputeCatalog(input) {
  const value = normalizeCatalog(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = computeCatalog();
    if (input.revision !== current.revision) fail('The catalog changed. Reload before saving.', 409);
    const ids = new Set(value.sizes.map((s) => s.id));
    for (const row of db.prepare(`SELECT p.value FROM customer_compute_profiles p
      JOIN customers c ON c.id=p.customer_id WHERE c.deleted_at IS NULL`).all()) {
      const profile = JSON.parse(row.value);
      if (profile.sizeIds?.some((id) => !ids.has(id))) fail('A customer references this size. Disable it or update the customer before removing it.', 409);
    }
    db.prepare('INSERT INTO compute_catalog_revisions(revision,value) VALUES(?,?)').run(current.revision + 1, JSON.stringify(value));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return computeCatalog();
}

const profileDefaults = () => ({
  catalogEnabled: false, network: { bridge: 'vmbr0', vlan: null, verified: false },
  tier: 'basecamp', sizeIds: null, storageClassIds: [...CLASS_IDS], haAllowed: true,
  backupServiceEnabled: false, storageLimitsGb: { basic: 0, standard: 0, fast: 0 }, backupLimitGb: 0,
});
export function computeProfile(customerId) {
  if (!customerById(customerId)) fail('Customer not found', 404);
  const row = db.prepare('SELECT * FROM customer_compute_profiles WHERE customer_id=?').get(customerId);
  const value = { ...profileDefaults(), ...(row ? JSON.parse(row.value) : {}) };
  return {
    ...value, customerId, revision: row?.revision ?? 0,
    backupServiceIncluded: ['ridge', 'summit'].includes(value.tier),
    backupStorageIncluded: false, backupClassId: 'basic', haEnabledByDefault: false,
  };
}
export function saveComputeProfile(customerId, input) {
  object(input, ['catalogEnabled', 'network', 'revision', 'catalogRevision', 'tier', 'sizeIds', 'storageClassIds', 'haAllowed', 'backupServiceEnabled', 'storageLimitsGb', 'backupLimitGb'], 'customer offerings');
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, 'profile revision');
  integer(input.catalogRevision, 1, Number.MAX_SAFE_INTEGER, 'catalog revision');
  if (!SERVICE_TIERS.includes(input.tier)) fail('Unknown service tier');
  const network = input.network ?? { bridge: 'vmbr0', vlan: null, verified: false };
  object(network, ['bridge', 'vlan', 'verified'], 'guest network');
  const value = {
    catalogEnabled: bool(input.catalogEnabled ?? false, 'catalog enabled'),
    network: { bridge: pveId(network.bridge, 'guest bridge'), vlan: network.vlan === null ? null : integer(network.vlan, 1, 4094, 'guest VLAN'), verified: bool(network.verified, 'network verified') },
    tier: input.tier,
    sizeIds: input.sizeIds === null ? null : unique(array(input.sizeIds, 100, 'size IDs').map((s) => identifier(s, 'size ID')), 'size ID'),
    storageClassIds: unique(array(input.storageClassIds, 3, 'class IDs'), 'class ID'),
    haAllowed: bool(input.haAllowed, 'HA availability'), backupServiceEnabled: bool(input.backupServiceEnabled, 'backup service'),
    storageLimitsGb: {}, backupLimitGb: integer(input.backupLimitGb, 0, 100000000, 'backup limit'),
  };
  if (value.storageClassIds.some((id) => !CLASS_IDS.includes(id))) fail('Unknown storage class');
  object(input.storageLimitsGb, CLASS_IDS, 'storage limits');
  for (const id of CLASS_IDS) value.storageLimitsGb[id] = integer(input.storageLimitsGb[id], 0, 100000000, 'storage limit');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = computeProfile(customerId), catalog = computeCatalog();
    if (input.revision !== previous.revision || input.catalogRevision !== catalog.revision) fail('Customer offerings or catalog changed. Reload before saving.', 409);
    if (value.sizeIds?.some((id) => !catalog.sizes.some((s) => s.id === id))) fail('Unknown VM size');
    db.prepare(`INSERT INTO customer_compute_profiles(customer_id,revision,value) VALUES(?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(customerId, previous.revision + 1, JSON.stringify(value));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return computeProfile(customerId);
}
