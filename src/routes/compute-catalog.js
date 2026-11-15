import { audit } from '../db.js';
import { computeCatalog, saveComputeCatalog, computeProfile, saveComputeProfile } from '../compute-catalog.js';
import { computeInventory, previewCompute } from '../compute-inventory.js';

export default async function computeCatalogRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
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
