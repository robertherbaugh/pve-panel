import { randomUUID } from 'node:crypto';
import { assertNoPrivateAccess } from './private-access-guard.js';
import { db, audit } from './db.js';
import { config } from './config.js';
import { pve, clusterGuests, guestPath, waitTask, invalidateGuestCache, PveError } from './pve.js';
import { assertComputeIdle, releaseCompute } from './compute-state.js';
import { assertNoHa } from './compute-ha.js';
import { activeRun } from './winupdate.js';
import { forgetServerBackups } from './backups.js';

const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode, expose: true }); };
const active = new Set();
const byId = id => db.prepare('SELECT * FROM vm_deletions WHERE id=?').get(id);
export function deletionFor(vmid) {
  return db.prepare('SELECT * FROM vm_deletions WHERE vmid=? AND finished_at IS NULL').get(vmid);
}
function idle(vmid, row) {
  assertNoPrivateAccess(vmid, 'deleting');
  assertComputeIdle(vmid);
  if (['creating', 'deleting'].includes(row?.state) || activeRun(vmid) || db.prepare("SELECT 1 FROM backup_jobs WHERE vmid=? AND state IN ('queued','running')").get(vmid)) fail('Wait until the server’s current operation finishes');
}
export async function startVmDeletion(req, row, { admin = false, authorize } = {}) {
  const vmid = row.vmid;
  idle(vmid, row);
  const guest = (await clusterGuests(true)).get(vmid);
  if (vmid === config.vpn.gatewayVmid || guest?.template) fail('This server is protected', 403);
  if (!guest) {
    // Only legacy failed records can be removed without a live guest.
    idle(vmid, row);
    releaseCompute(vmid);
    db.prepare('DELETE FROM vms WHERE vmid=?').run(vmid);
    audit(req, vmid, admin ? 'admin_server_deleted' : 'server_deleted');
    return { removed: true };
  }
  if (!admin && guest.status !== 'stopped') fail('Shut down the server before deleting it');
  await assertNoHa(vmid);
  const cfg = await pve.get(`${guestPath(guest)}/config`);
  if (cfg.lock || guest.lock) fail('Wait until Proxmox unlocks this VM');
  // Recheck authorization and assignment after all remote preflight calls.
  if (authorize) await authorize();
  const current = db.prepare('SELECT * FROM vms WHERE vmid=?').get(vmid);
  if (row.user_id == null ? !!current : (current?.customer_id ?? null) !== (row.customer_id ?? null)) fail('The server assignment changed. Reload before deleting.');
  idle(vmid, current);
  const id = randomUUID();
  db.prepare(`INSERT INTO vm_deletions(id,vmid,customer_id,user_id,node,type,name,state,admin) VALUES(?,?,?,?,?,?,?,'reserved',?)`)
    .run(id, vmid, row.customer_id ?? null, req.account.id, guest.node, guest.type, guest.name ?? '', admin ? 1 : 0);
  db.prepare("UPDATE vms SET state='deleting',error=NULL WHERE vmid=?").run(vmid);
  audit({ account: req.account, ip: req.ip, customerId: row.customer_id }, vmid, admin ? 'admin_server_delete_started' : 'server_delete_started', { operationId: id });
  void runDeletion(id, true);
  return { removed: false, operationId: id };
}
async function runDeletion(id, submit = false) {
  if (active.has(id)) return;
  active.add(id);
  let op = byId(id);
  const actor = { account: { id: op.user_id }, ip: 'deletion', customerId: op.customer_id };
  try {
    let guest = (await clusterGuests(true)).get(op.vmid);
    if (guest && (guest.template || Number(guest.vmid) === config.vpn.gatewayVmid || guest.node !== op.node || guest.type !== op.type)) fail('VM identity changed. Provider reconciliation is required.');
    if (guest && submit && op.state === 'reserved') {
      const path = guestPath(guest);
      if (guest.status !== 'stopped') {
        if (!op.admin) fail('Shut down the server before deleting it');
        db.prepare("UPDATE vm_deletions SET state='stopping' WHERE id=?").run(id);
        await waitTask(guest.node, await pve.post(`${path}/status/stop`));
      }
      await assertNoHa(op.vmid);
      if ((await pve.get(`${path}/config`)).lock) fail('Wait until Proxmox unlocks this VM');
      db.prepare("UPDATE vm_deletions SET state='submitting' WHERE id=?").run(id);
      const upid = await pve.del(path, { purge: 1, 'destroy-unreferenced-disks': 1 });
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) fail('Deletion response needs provider reconciliation');
      db.prepare("UPDATE vm_deletions SET state='deleting',upid=? WHERE id=?").run(upid, id);
      op = byId(id);
    }
    if (op.upid) await waitTask(op.node, op.upid);
    guest = (await clusterGuests(true)).get(op.vmid);
    if (guest) fail('Deletion outcome needs provider reconciliation. The panel will follow the existing task.');
    // Never release reservations on task acceptance, timeout or an unknown outcome.
    releaseCompute(op.vmid);
    db.prepare('DELETE FROM vms WHERE vmid=?').run(op.vmid);
    db.prepare('DELETE FROM tasks WHERE vmid=?').run(op.vmid);
    db.prepare("UPDATE vm_deletions SET state='complete',error=NULL,finished_at=datetime('now') WHERE id=?").run(id);
    await forgetServerBackups(op.vmid, op.node);
    audit(actor, op.vmid, op.admin ? 'admin_server_deleted' : 'server_deleted', { operationId: id });
  } catch (err) {
    op = byId(id);
    // Explicit API rejection or a pre-submit failure is safe to retry. Ambiguous submission stays held.
    const rejected = (op.state !== 'submitting' && !op.upid && !['review'].includes(op.state)) ||
      (op.state === 'submitting' && err instanceof PveError && err.statusCode >= 400 && err.statusCode < 500);
    const message = rejected ? `Deleting failed: ${err.message}`.slice(0, 500) : 'Deletion needs provider reconciliation; reservations are retained.';
    db.prepare(`UPDATE vm_deletions SET state=?,error=?,finished_at=${rejected ? "datetime('now')" : 'NULL'} WHERE id=?`).run(rejected ? 'failed' : 'review', message, id);
    db.prepare("UPDATE vms SET state='failed',error=? WHERE vmid=?").run(message, op.vmid);
    audit(actor, op.vmid, 'server_delete_failed', { operationId: id, error: message });
  } finally { active.delete(id); invalidateGuestCache(); }
}
export function startDeletionRecovery(log) {
  const run = async () => {
    for (const op of db.prepare('SELECT id FROM vm_deletions WHERE finished_at IS NULL').all()) await runDeletion(op.id);
  };
  void run().catch(() => log.warn('Deletion recovery needs attention'));
  const timer = setInterval(() => { void run().catch(() => log.warn('Deletion recovery needs attention')); }, 60_000);
  timer.unref();
}
