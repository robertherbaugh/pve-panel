import { db } from './db.js';
import { pve, serial } from './pve.js';
import { computeCatalog, computeProfile } from './compute-catalog.js';
import { computeManaged, heldReservations } from './compute-state.js';

const GB = 2 ** 30;
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
db.exec(`CREATE TABLE IF NOT EXISTS compute_backup_reservations (
  job_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, vmid INTEGER NOT NULL,
  node TEXT NOT NULL, storage TEXT NOT NULL, storage_key TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL, archive_bytes INTEGER, volid TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('held','retained','released')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT
)`);
export const backupReservation = id => db.prepare('SELECT * FROM compute_backup_reservations WHERE job_id=?').get(id);
export const catalogBackupCustomer = (customerId, vmid) => computeProfile(customerId).catalogEnabled || computeManaged(vmid);
export function backupServiceSelected(customerId, vmid) {
  return !catalogBackupCustomer(customerId, vmid) || computeProfile(customerId).backupServiceEnabled;
}
export function requireBackupService(customerId, vmid) {
  if (!backupServiceSelected(customerId, vmid)) fail('Select the backup service add-on before creating backups or schedules.', 403);
}
export function backupUsage(customerId) {
  const used = db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) bytes, COALESCE(SUM(state='held'),0) pending FROM compute_backup_reservations WHERE customer_id=? AND state!='released'").get(customerId);
  return { reservedBytes: used.bytes, pending: used.pending, limitGb: computeProfile(customerId).backupLimitGb, storageClassId: 'basic', measure: 'logical-disk-reservation' };
}
export const backupDiskHoldsGb = key => db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) bytes FROM compute_backup_reservations WHERE storage_key=? AND state='held'").get(key).bytes / GB;
export async function reserveCatalogBackup(job, guest, storage, diskGb) {
  const prior = backupReservation(job.id);
  if (prior) return prior;
  if (!catalogBackupCustomer(job.customer_id, job.vmid)) return null;
  return serial(async () => {
    requireBackupService(job.customer_id, job.vmid);
    const catalog = computeCatalog(), profile = computeProfile(job.customer_id);
    const basic = catalog.classes.find(c => c.id === 'basic');
    if (!basic.enabled || !basic.bindings.some(b => b.purpose === 'backup' && b.node === guest.node && b.storage === storage)) fail('The provider must map this backup destination to Basic storage.');
    const stores = await pve.get(`/nodes/${encodeURIComponent(guest.node)}/storage`, { content: 'backup', enabled: 1 });
    const target = stores?.find(s => s.storage === storage);
    if (!target || !(target.active === 1 || target.active === true) || target.enabled === 0 || !String(target.content ?? '').split(',').includes('backup') || !Number.isFinite(target.avail)) fail('Basic backup storage availability cannot be verified.');
    const path = `/storage/${storage}`, permissions = await pve.get('/access/permissions', { path });
    if (['Datastore.Audit', 'Datastore.AllocateSpace'].some(p => !permissions?.[path]?.[p])) fail('The provider token needs backup storage audit and allocation rights.');
    const storageKey = target.shared === 1 || target.shared === true ? `shared/${storage}` : `${guest.node}/${storage}`;
    if (!Number.isFinite(diskGb) || diskGb <= 0) fail('The backup disk reservation cannot be determined.');
    const computeHolds = heldReservations().filter(h => h.storage_key === storageKey && h.state === 'held').reduce((n,h) => n+h.disk_gb,0);
    if (diskGb + computeHolds + backupDiskHoldsGb(storageKey) + catalog.reserves.diskGb > target.avail / GB) fail('Basic backup storage has insufficient free reservation capacity.');
    if (computeCatalog().revision !== catalog.revision || computeProfile(job.customer_id).revision !== profile.revision) fail('Backup offerings changed. Try again.');
    // No awaits between quota admission and the durable hold.
    const used = backupUsage(job.customer_id).reservedBytes;
    if (profile.backupLimitGb > 0 && used + diskGb * GB > profile.backupLimitGb * GB) fail('This exceeds the customer’s Basic backup storage limit.');
    db.prepare("INSERT INTO compute_backup_reservations(job_id,customer_id,vmid,node,storage,storage_key,reserved_bytes,state) VALUES(?,?,?,?,?,?,?,'held')")
      .run(job.id, job.customer_id, job.vmid, guest.node, storage, storageKey, Math.ceil(diskGb * GB));
    return backupReservation(job.id);
  });
}
export function retainBackup(jobId, volid, archiveBytes) {
  db.prepare("UPDATE compute_backup_reservations SET state='retained',volid=?,archive_bytes=? WHERE job_id=? AND state!='released'").run(volid, Number.isFinite(archiveBytes) ? archiveBytes : null, jobId);
}
export const trackedBackup = volid => db.prepare("SELECT * FROM compute_backup_reservations WHERE volid=? AND state='retained'").get(volid);
export const releaseBackupVolume = volid => db.prepare("UPDATE compute_backup_reservations SET state='released',ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE volid=? AND state!='released'").run(volid);
export const backupReservations = () => db.prepare('SELECT * FROM compute_backup_reservations ORDER BY job_id DESC LIMIT 200').all();
export async function reconcileBackupReservation(id) {
  const hold = backupReservation(id), job = db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(id);
  if (!hold || hold.state !== 'held' || !job || ['queued','running'].includes(job.state)) fail('This backup is not awaiting reconciliation.');
  const items = await pve.get(`/nodes/${encodeURIComponent(hold.node)}/storage/${encodeURIComponent(hold.storage)}/content`, { content: 'backup', vmid: hold.vmid });
  const archive = items.find(b => Number(b.vmid) === hold.vmid && String(b.notes ?? '').includes(`pve-panel-backup:${id}:`));
  if (!archive) fail('No matching archive is visible. The reservation stays held until the backup outcome is known.');
  retainBackup(id, archive.volid, Number(archive.size));
  db.prepare('INSERT OR IGNORE INTO backups(volid,vmid,user_id,storage,kind,customer_id) VALUES(?,?,?,?,?,?)').run(archive.volid, hold.vmid, job.user_id, hold.storage, job.kind, hold.customer_id);
  db.prepare("UPDATE backup_jobs SET state='done',error=NULL,step=NULL,volid=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(archive.volid, id);
  return { reconciled: true };
}
