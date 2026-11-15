// Additive migration. Legacy user IDs remain creator/history references.
export function migrateTenancy(db) {
  const add = (table, name, type) => {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    legacy_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    pools TEXT NOT NULL DEFAULT '[]', domains TEXT NOT NULL DEFAULT '[]',
    sso_groups TEXT NOT NULL DEFAULT '[]', sso_entitlements TEXT NOT NULL DEFAULT '[]',
    sso_match TEXT NOT NULL DEFAULT 'any', sso_required INTEGER NOT NULL DEFAULT 1,
    contact_email TEXT, max_servers INTEGER NOT NULL DEFAULT 0, max_cores INTEGER NOT NULL DEFAULT 0,
    max_memory_mb INTEGER NOT NULL DEFAULT 0, max_disk_gb INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS customer_memberships (
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('member','viewer','operator','admin')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','oidc')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(customer_id,user_id,source)
  );
  CREATE TABLE IF NOT EXISTS customer_membership_blocks (
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY(customer_id,user_id)
  );`);
  for (const [name, type] of Object.entries({
    expiry_mode: 'TEXT',
    expiry_days: 'INTEGER',
    expiry_date: 'TEXT',
    expiry_self_extend: 'INTEGER NOT NULL DEFAULT 0',
    max_backups: 'INTEGER',
  }))
    add('customers', name, type);
  add('users', 'tenant_initialized', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
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
    'audit_log',
  ]) {
    add(t, 'customer_id', 'INTEGER REFERENCES customers(id) ON DELETE RESTRICT');
    db.exec(`CREATE INDEX IF NOT EXISTS ${t}_customer ON ${t}(customer_id)`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const users = db.prepare('SELECT * FROM users WHERE tenant_initialized=0').all();
    for (const u of users) {
      const id = Number(
        db
          .prepare(
            `INSERT INTO customers(name,slug,legacy_user_id,sso_required,contact_email)
        VALUES(?,?,?,0,?)`,
          )
          .run(u.email, `personal-${u.id}`, u.id, u.email).lastInsertRowid,
      );
      db.prepare(
        'UPDATE customers SET expiry_mode=?,expiry_days=?,expiry_date=?,expiry_self_extend=?,max_backups=? WHERE id=?',
      ).run(u.expiry_mode, u.expiry_days, u.expiry_date, u.expiry_self_extend, u.max_backups, id);
      db.prepare("INSERT INTO customer_memberships(customer_id,user_id,role) VALUES(?,?,'admin')").run(
        id,
        u.id,
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
      ]) {
        db.prepare(`UPDATE ${t} SET customer_id=? WHERE user_id=? AND customer_id IS NULL`).run(id, u.id);
      }
      db.prepare('UPDATE users SET tenant_initialized=1 WHERE id=?').run(u.id);
    }
    const networkSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='networks'").get().sql;
    if (/user_id\s+INTEGER\s+UNIQUE/i.test(networkSql)) {
      db.exec(`ALTER TABLE networks RENAME TO networks_before_tenancy;
        CREATE TABLE networks(vnet TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          idx INTEGER UNIQUE NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),
          customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT);
        INSERT INTO networks SELECT * FROM networks_before_tenancy;
        DROP TABLE networks_before_tenancy;`);
    }
    const vpnSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='vpn_devices'").get().sql;
    if (/UNIQUE\s*\(user_id,\s*host\)/i.test(vpnSql)) {
      db.exec(`ALTER TABLE vpn_devices RENAME TO vpn_devices_before_tenancy;
        CREATE TABLE vpn_devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,public_key TEXT UNIQUE NOT NULL,host INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT(datetime('now')),customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
          UNIQUE(customer_id,host));
        INSERT INTO vpn_devices SELECT * FROM vpn_devices_before_tenancy;
        DROP TABLE vpn_devices_before_tenancy;`);
    }
    // Scope the previous global policy to one explicit imported customer.
    const stored = db.prepare("SELECT value FROM settings WHERE key='access_policy'").get();
    if (stored) {
      const policy = JSON.parse(stored.value);
      if (policy.rules.some((r) => !r.customerId)) {
        const pools = [...new Set(policy.rules.flatMap((r) => r.pools))];
        const groups = [...new Set(policy.rules.flatMap((r) => r.groups))];
        const entitlements = [...new Set(policy.rules.flatMap((r) => r.entitlements))];
        const id = Number(
          db
            .prepare(
              `INSERT INTO customers(name,slug,pools,domains,sso_groups,sso_entitlements)
          VALUES('Imported SSO access','imported-sso',?,?,?,?)`,
            )
            .run(
              JSON.stringify(pools),
              JSON.stringify(policy.allowedDomains ?? []),
              JSON.stringify(groups),
              JSON.stringify(entitlements),
            ).lastInsertRowid,
        );
        policy.rules = policy.rules.map((r) => ({ ...r, customerId: r.customerId ?? id }));
        policy.allowedDomains = [];
        db.prepare("UPDATE settings SET value=? WHERE key='access_policy'").run(JSON.stringify(policy));
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS networks_customer ON networks(customer_id);
      CREATE INDEX IF NOT EXISTS vpn_devices_customer ON vpn_devices(customer_id);
      DROP TRIGGER IF EXISTS protect_shared_creator;
      CREATE TRIGGER protect_shared_creator BEFORE DELETE ON users
      WHEN ${['vms', 'tasks', 'networks', 'vpn_devices', 'tailscale', 'backups', 'backup_jobs', 'backup_schedules', 'winupdates'].map((t) => `EXISTS(SELECT 1 FROM ${t} r JOIN customers c ON c.id=r.customer_id WHERE r.user_id=OLD.id AND (c.legacy_user_id IS NOT OLD.id OR EXISTS(SELECT 1 FROM customer_memberships m WHERE m.customer_id=c.id AND m.user_id<>OLD.id)))`).join(' OR ')}
        OR EXISTS(SELECT 1 FROM customer_memberships m JOIN customers c ON c.id=m.customer_id WHERE c.legacy_user_id=OLD.id AND m.user_id<>OLD.id)
      BEGIN SELECT RAISE(ABORT,'Disable the user to preserve customer resources'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS networks_customer_unique ON networks(customer_id) WHERE customer_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS vms_assigned_on_customer AFTER UPDATE OF customer_id ON vms WHEN NEW.customer_id IS NOT OLD.customer_id
      BEGIN UPDATE vms SET assigned_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE vmid=NEW.vmid; END;`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
