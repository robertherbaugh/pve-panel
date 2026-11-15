import { adminTable } from '../admin-table.js';
import { adoptionCandidates, adoptCompute } from '../compute-adoption.js';
import { remoteAccessSettings, saveRemoteAccessSettings } from '../remote-access-settings.js';
import { haPolicy, saveHaPolicy } from '../compute-ha-policy.js';
import { backupReservations, reconcileBackupReservation } from '../compute-backups.js';
import { computeOperations } from '../compute-state.js';
import { reconcileComputeOperation } from '../provision.js';
import { audit } from '../db.js';
import { computeCatalog, saveComputeCatalog, computeProfile, saveComputeProfile } from '../compute-catalog.js';
import { computeInventory, previewCompute } from '../compute-inventory.js';

export default async function computeCatalogRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.get('/api/admin/compute-adoption', async () => ({ vms: await adoptionCandidates() }));
  app.post('/api/admin/compute-adoption/:vmid', { schema: {
    params: { type: 'object', required: ['vmid'], properties: { vmid: { type: 'integer', minimum: 100 } } },
    body: { type: 'object', additionalProperties: false, required: ['customerId','sizeId','storageClassId','confirmName','catalogRevision','profileRevision'], properties: {
      customerId: { type: 'integer', minimum: 1 }, sizeId: { type: 'string', maxLength: 60 }, storageClassId: { enum: ['basic','standard','fast'] },
      confirmName: { type: 'string', maxLength: 100 }, catalogRevision: { type: 'integer', minimum: 1 }, profileRevision: { type: 'integer', minimum: 0 },
    } },
  } }, async req => adoptCompute(req, Number(req.params.vmid), req.body));
  app.get('/api/admin/remote-access',async()=>remoteAccessSettings());
  app.put('/api/admin/remote-access',async req=>{const value=saveRemoteAccessSettings(req.body);audit(req,null,'admin_remote_access',{provider:value.provider,loginServer:value.loginServer});return value;});
  app.get('/api/admin/compute-ha-policy',async()=>haPolicy());
  app.put('/api/admin/compute-ha-policy',async req=>{const saved=saveHaPolicy(req.body);audit(req,null,'admin_ha_policy',{revision:saved.revision});return saved;});
  app.get('/api/admin/compute-backup-reservations', async req => req.query.paginated === undefined
    ? { reservations: backupReservations() }
    : adminTable(req.query, {
      from: 'compute_backup_reservations',
      select: 'job_id, customer_id, vmid, node, storage, storage_key, reserved_bytes, archive_bytes, volid, state, created_at, ended_at',
      columns: { job: 'job_id', vm: 'vmid', state: 'state', reserved: 'reserved_bytes / 1073741824.0' },
      defaultSort: 'job', tieBreak: 'job_id DESC',
    }));
  app.post('/api/admin/compute-backup-reservations/:id/reconcile', async req => {
    const result = await reconcileBackupReservation(Number(req.params.id));
    audit(req, null, 'admin_backup_reservation_reconcile', { jobId: Number(req.params.id) });
    return result;
  });
  app.get('/api/admin/compute-operations', async req => req.query.paginated === undefined
    ? { operations: computeOperations() }
    : adminTable(req.query, {
      from: 'compute_operations',
      // Never return the plan, credentials, request hashes or idempotency keys.
      select: `id, vmid, customer_id AS customerId, kind, state, error,
        json_extract(plan, '$.node') AS node, json_extract(plan, '$.storage') AS storage,
        json_extract(plan, '$.offering.sizeId') AS sizeId, created_at AS createdAt, updated_at AS updatedAt`,
      columns: { vm: 'vmid', kind: 'kind', state: "state || ' ' || COALESCE(error, '')", placement: "COALESCE(json_extract(plan, '$.node'), '') || ' / ' || COALESCE(json_extract(plan, '$.storage'), '')", time: 'created_at' },
      defaultSort: 'time', tieBreak: 'id DESC',
    }));
  app.post('/api/admin/compute-operations/:id/reconcile', { schema: { body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['resume', 'release'] } } } } }, async (req) => reconcileComputeOperation(req, req.params.id, req.body.action));
  app.get('/api/admin/compute-catalog', async () => computeCatalog());
  app.put('/api/admin/compute-catalog', async (req) => {
    const saved = saveComputeCatalog(req.body);
    audit(req, null, 'admin_compute_catalog', { revision: saved.revision });
    return saved;
  });
  app.get('/api/admin/compute-catalog/inventory', async () => computeInventory());
  app.post('/api/admin/compute-catalog/preview', async (req) => {
    // Validate the request before making any external calls.
    const catalog = computeCatalog();
    previewCompute(req.body, { nodes: [], errors: [], observedAt: null }, catalog);
    return previewCompute(req.body, await computeInventory(), catalog);
  });
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
  app.get('/api/admin/customers/:id/compute-profile', { schema: { params } }, async (req) => computeProfile(Number(req.params.id)));
  app.put('/api/admin/customers/:id/compute-profile', { schema: { params } }, async (req) => {
    const id = Number(req.params.id), saved = saveComputeProfile(id, req.body);
    audit({ account: req.account, ip: req.ip, customerId: id }, null, 'admin_customer_compute_profile', { customerId: id, revision: saved.revision });
    return saved;
  });
}
