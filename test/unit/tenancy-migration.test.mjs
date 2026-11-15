import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateTenancy } from '../../src/tenancy-migration.js';

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,expiry_mode TEXT,expiry_days INTEGER,expiry_date TEXT,expiry_self_extend INTEGER DEFAULT 0,max_backups INTEGER);
 CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE vms(vmid INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,assigned_at TEXT);
 CREATE TABLE networks(vnet TEXT PRIMARY KEY,user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,idx INTEGER UNIQUE NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
 CREATE TABLE vpn_devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,public_key TEXT UNIQUE NOT NULL,host INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(user_id,host));
 INSERT INTO users(id,email,expiry_mode,expiry_days,expiry_self_extend,max_backups) VALUES(1,'first@example.com','after_creation',14,1,2),(2,'second@example.com',NULL,NULL,0,NULL);
 INSERT INTO vms VALUES(101,1,'2026-10-01T00:00:00Z');INSERT INTO networks(vnet,user_id,idx) VALUES('cust001',1,1);
 INSERT INTO vpn_devices(user_id,name,public_key,host) VALUES(1,'Laptop','public-test-key',2);`);
  for (const t of [
    'tasks',
    'tailscale',
    'backups',
    'backup_jobs',
    'backup_schedules',
    'winupdates',
    'audit_log',
  ])
    db.exec(`CREATE TABLE ${t}(id INTEGER PRIMARY KEY,user_id INTEGER); INSERT INTO ${t}(user_id) VALUES(1)`);
  return db;
}
test('legacy migration preserves resources and settings, scopes prior policy, and runs twice safely', () => {
  const db = legacyDatabase();
  try {
    const policy = {
      version: 1,
      enabled: true,
      allowedDomains: ['example.com'],
      rules: [
        { id: 'developers', groups: ['pve_dev'], entitlements: [], pools: ['tacid-dev'], actions: ['view'] },
        {
          id: 'operations',
          groups: [],
          entitlements: ['prod:operate'],
          pools: ['tacid-prod'],
          actions: ['view'],
        },
      ],
    };
    db.prepare('INSERT INTO settings VALUES(?,?)').run('access_policy', JSON.stringify(policy));
    migrateTenancy(db);
    const personal = db.prepare('SELECT * FROM customers WHERE legacy_user_id=1').get(),
      imported = db.prepare("SELECT * FROM customers WHERE slug='imported-sso'").get();
    assert.equal(personal.name, 'first@example.com');
    assert.equal(personal.expiry_days, 14);
    assert.equal(personal.max_backups, 2);
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
      assert.equal(
        db.prepare(`SELECT customer_id FROM ${t} WHERE user_id=1`).get().customer_id,
        personal.id,
        t,
      );
    assert.equal(db.prepare('SELECT assigned_at FROM vms').get().assigned_at, '2026-10-01T00:00:00Z');
    const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='access_policy'").get().value);
    assert.deepEqual(stored.allowedDomains, []);
    assert.ok(stored.rules.every((r) => r.customerId === imported.id));
    assert.deepEqual(JSON.parse(imported.domains), ['example.com']);
    assert.deepEqual(JSON.parse(imported.pools), ['tacid-dev', 'tacid-prod']);
    const before = db.prepare('SELECT * FROM customers ORDER BY id').all();
    migrateTenancy(db);
    assert.deepEqual(db.prepare('SELECT * FROM customers ORDER BY id').all(), before);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // A single creator may own networks/devices in multiple customers.
    db.prepare('INSERT INTO networks(vnet,user_id,idx,customer_id) VALUES(?,?,?,?)').run(
      'cust002',
      1,
      2,
      imported.id,
    );
    db.prepare('INSERT INTO vpn_devices(user_id,name,public_key,host,customer_id) VALUES(?,?,?,?,?)').run(
      1,
      'Second laptop',
      'different-public-test-key',
      2,
      imported.id,
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO networks(vnet,user_id,idx,customer_id) VALUES(?,?,?,?)')
          .run('duplicate', 2, 3, imported.id),
      /UNIQUE/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('networks_customer','vpn_devices_customer')",
        )
        .get().n,
      2,
    );
  } finally {
    db.close();
  }
});
test('deleting a creator cannot cascade into a shared customer VM', () => {
  const db = legacyDatabase();
  try {
    migrateTenancy(db);
    const personal = db.prepare('SELECT id FROM customers WHERE legacy_user_id=1').get().id;
    db.prepare("INSERT INTO customer_memberships(customer_id,user_id,role) VALUES(?,2,'viewer')").run(
      personal,
    );
    assert.throws(() => db.prepare('DELETE FROM users WHERE id=1').run(), /preserve customer resources/);
    assert.equal(db.prepare('SELECT count(*) n FROM vms').get().n, 1);
  } finally {
    db.close();
  }
});
