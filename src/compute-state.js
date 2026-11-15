import { randomUUID, createHmac } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { seal, open } from './secrets.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
db.exec(`
  CREATE TABLE IF NOT EXISTS compute_operations (
    id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    vmid INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    request_key TEXT, request_hash TEXT, plan TEXT NOT NULL, credentials TEXT,
    upid TEXT, task_node TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(customer_id,request_key)
  );
  CREATE INDEX IF NOT EXISTS compute_operations_vm ON compute_operations(vmid,created_at);
  CREATE TABLE IF NOT EXISTS compute_reservations (
    operation_id TEXT PRIMARY KEY REFERENCES compute_operations(id), vmid INTEGER NOT NULL,
    node TEXT NOT NULL, storage TEXT NOT NULL, storage_key TEXT NOT NULL,
    cores INTEGER NOT NULL, memory_mb INTEGER NOT NULL, disk_gb INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('held','committed','released'))
  );
  CREATE TABLE IF NOT EXISTS compute_ha_reservations (
    vmid INTEGER NOT NULL, node TEXT NOT NULL, cores INTEGER NOT NULL, memory_mb INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'held', PRIMARY KEY(vmid,node)
  );
  CREATE TABLE IF NOT EXISTS compute_staging_reservations (
    operation_id TEXT PRIMARY KEY REFERENCES compute_operations(id), vmid INTEGER NOT NULL,
    node TEXT NOT NULL, storage TEXT NOT NULL, storage_key TEXT NOT NULL,
    disk_gb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'held'
  );
  CREATE TABLE IF NOT EXISTS compute_operation_steps (
    operation_id TEXT NOT NULL REFERENCES compute_operations(id), name TEXT NOT NULL,
    state TEXT NOT NULL, upid TEXT, task_node TEXT, PRIMARY KEY(operation_id,name)
  );
  CREATE TABLE IF NOT EXISTS compute_allocations (
    id TEXT PRIMARY KEY, vmid INTEGER NOT NULL, customer_id INTEGER NOT NULL,
    offering TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS compute_allocations_open ON compute_allocations(vmid) WHERE ended_at IS NULL;
  CREATE TABLE IF NOT EXISTS compute_allocation_events (
    id INTEGER PRIMARY KEY, allocation_id TEXT NOT NULL REFERENCES compute_allocations(id),
    kind TEXT NOT NULL, offering TEXT NOT NULL, occurred_at TEXT NOT NULL
  );
`);
export const requestHash = (spec) => createHmac('sha256', config.jwtSecret).update(JSON.stringify(Object.fromEntries(Object.entries(spec).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const parse = (r) => r ? { ...r, plan: JSON.parse(r.plan) } : null;
export const operationById = (id) => parse(db.prepare('SELECT * FROM compute_operations WHERE id=?').get(id));
export function priorRequest(customerId, userId, key, hash) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) fail('Provide an Idempotency-Key of 8–100 letters, numbers, underscores or hyphens', 400);
  const row = parse(db.prepare('SELECT * FROM compute_operations WHERE customer_id=? AND request_key=?').get(customerId, key));
  if (row && (row.user_id !== userId || row.request_hash !== hash)) fail('This request key already identifies a different request');
  return row;
}
export function beginOperation({ customerId, userId, vmid, kind = 'create', key = null, hash = null, plan, credentials = null, onReserve = () => {} }) {
  const id = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (key && priorRequest(customerId, userId, key, hash)) fail('This request has already been reserved');
    if (db.prepare("SELECT 1 FROM compute_operations WHERE vmid=? AND state NOT IN ('complete','cancelled')").get(vmid)) fail('Another compute operation holds this VM');
    db.prepare(`INSERT INTO compute_operations(id,customer_id,user_id,vmid,kind,state,request_key,request_hash,plan,credentials)
      VALUES(?,?,?,?,?,'reserved',?,?,?,?)`).run(id, customerId, userId, vmid, kind, key, hash, JSON.stringify(plan), credentials ? seal(`compute:${id}`, JSON.stringify(credentials)) : null);
    db.prepare(`INSERT INTO compute_reservations(operation_id,vmid,node,storage,storage_key,cores,memory_mb,disk_gb,state)
      VALUES(?,?,?,?,?,?,?,?,'held')`).run(id, vmid, plan.node, plan.storage, plan.storageKey, plan.cores, plan.memoryMb, plan.reserveDiskGb ?? plan.diskGb);
    if (plan.staging) db.prepare('INSERT INTO compute_staging_reservations(operation_id,vmid,node,storage,storage_key,disk_gb) VALUES(?,?,?,?,?,?)')
      .run(id, vmid, plan.sourceNode, plan.staging.storage, plan.staging.storageKey, plan.staging.diskGb);
    onReserve(id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return operationById(id);
}
export function operationCredentials(id) {
  const row = operationById(id);
  return row?.credentials ? JSON.parse(open(`compute:${id}`, row.credentials)) : {};
}
export function updateOperation(id, state, { upid = null, taskNode = null, error = null } = {}) {
  db.prepare(`UPDATE compute_operations SET state=?,upid=COALESCE(?,upid),task_node=COALESCE(?,task_node),error=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(state, upid, taskNode, error, id);
}
export function heldReservations() {
  return db.prepare("SELECT * FROM compute_reservations WHERE state IN ('held','committed') UNION ALL SELECT operation_id,vmid,node,storage,storage_key,0 AS cores,0 AS memory_mb,disk_gb,state FROM compute_staging_reservations WHERE state='held' UNION ALL SELECT 'ha:'||vmid,vmid,node,'' AS storage,'' AS storage_key,cores,memory_mb,0 AS disk_gb,'held' AS state FROM compute_ha_reservations WHERE state!='released'").all();
}
export const activeComputeOperation = (vmid) => parse(db.prepare("SELECT * FROM compute_operations WHERE vmid=? AND state NOT IN ('complete','cancelled') ORDER BY created_at DESC LIMIT 1").get(vmid));
export function assertComputeIdle(vmid) {
  if (db.prepare('SELECT 1 FROM vm_deletions WHERE vmid=? AND finished_at IS NULL').get(vmid)) fail('This VM has a pending deletion. Reconcile its existing task first.');
  if (activeComputeOperation(vmid)) fail('This VM has an unresolved compute operation. The provider must reconcile it first.');
}
export const computeManaged = (vmid) => !!allocationFor(vmid) || !!activeComputeOperation(vmid);
export function computeOperations() {
  return db.prepare('SELECT id FROM compute_operations ORDER BY created_at DESC LIMIT 200').all().map(({ id }) => {
    const o = operationById(id);
    return { id: o.id, vmid: o.vmid, customerId: o.customer_id, kind: o.kind, state: o.state, error: o.error,
      node: o.plan.node, storage: o.plan.storage, sizeId: o.plan.offering?.sizeId, createdAt: o.created_at, updatedAt: o.updated_at };
  });
}
export const pendingOperations = () => db.prepare("SELECT id FROM compute_operations WHERE state NOT IN ('complete','cancelled','review')").all().map((r) => operationById(r.id));
export const allocationFor = (vmid) => {
  const row = db.prepare('SELECT * FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').get(vmid);
  return row ? { ...row, offering: JSON.parse(row.offering) } : null;
};
export function recordAllocation(vmid, customerId, offering, kind = 'created') {
  const now = new Date().toISOString(), value = JSON.stringify(offering);
  const old = allocationFor(vmid);
  if (old && old.customer_id !== customerId) fail('Allocation ownership must be reconciled before changing it');
  if (old && JSON.stringify(old.offering) === value && kind === 'created') return old;
  const id = old?.id ?? randomUUID();
  if (old) db.prepare('UPDATE compute_allocations SET offering=? WHERE id=?').run(value, id);
  else db.prepare('INSERT INTO compute_allocations(id,vmid,customer_id,offering,started_at) VALUES(?,?,?,?,?)').run(id, vmid, customerId, value, now);
  db.prepare('INSERT INTO compute_allocation_events(allocation_id,kind,offering,occurred_at) VALUES(?,?,?,?)').run(id, kind, value, now);
  return allocationFor(vmid);
}
export function completeOperation(id, onComplete = () => {}) {
  const op = operationById(id);
  if (!op) fail('Compute operation not found', 404);
  if (op.state === 'complete') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    recordAllocation(op.vmid, op.customer_id, op.plan.offering, op.kind === 'create' ? 'created' : op.kind);
    onComplete();
    db.prepare("UPDATE compute_reservations SET state='released' WHERE vmid=? AND operation_id!=? AND state='committed'").run(op.vmid, id);
    db.prepare('UPDATE compute_reservations SET cores=?,memory_mb=?,disk_gb=? WHERE operation_id=?').run(op.plan.offering.cores,op.plan.offering.memoryMb,op.plan.offering.diskGb,id);
    db.prepare("UPDATE compute_reservations SET state='committed' WHERE operation_id=?").run(id);
    db.prepare("UPDATE compute_operations SET state='complete',credentials=NULL,error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
// Call only after the caller has verified that the VM and held resources are gone.
export const operationStep = (id, name) => db.prepare('SELECT * FROM compute_operation_steps WHERE operation_id=? AND name=?').get(id, name);
export function setOperationStep(id, name, state, upid = null, taskNode = null) {
  db.prepare('INSERT INTO compute_operation_steps(operation_id,name,state,upid,task_node) VALUES(?,?,?,?,?) ON CONFLICT(operation_id,name) DO UPDATE SET state=excluded.state,upid=COALESCE(excluded.upid,upid),task_node=COALESCE(excluded.task_node,task_node)').run(id, name, state, upid, taskNode);
}
export const releaseStaging = id => db.prepare("UPDATE compute_staging_reservations SET state='released' WHERE operation_id=?").run(id);
export function releaseCompute(vmid) {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = allocationFor(vmid);
    if (old) {
      db.prepare('UPDATE compute_allocations SET ended_at=? WHERE id=?').run(now, old.id);
      db.prepare("INSERT INTO compute_allocation_events(allocation_id,kind,offering,occurred_at) VALUES(?,'deleted',?,?)").run(old.id, JSON.stringify(old.offering), now);
    }
    db.prepare("UPDATE compute_reservations SET state='released' WHERE vmid=?").run(vmid);
    db.prepare("UPDATE compute_staging_reservations SET state='released' WHERE vmid=?").run(vmid);
    db.prepare("UPDATE compute_ha_reservations SET state='released' WHERE vmid=?").run(vmid);
    db.prepare("UPDATE compute_operations SET state='cancelled',credentials=NULL,updated_at=? WHERE vmid=? AND state!='complete'").run(now, vmid);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
export function allocationHistory(customerId) {
  return db.prepare(`SELECT a.id,a.vmid,a.started_at,a.ended_at,e.kind,e.offering,e.occurred_at
    FROM compute_allocations a JOIN compute_allocation_events e ON e.allocation_id=a.id
    WHERE a.customer_id=? ORDER BY e.id DESC LIMIT 1000`).all(customerId).map((r) => ({ ...r, offering: JSON.parse(r.offering) }));
}
