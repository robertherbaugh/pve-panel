import { audit } from '../db.js';
import { privateAccessOverview } from '../private-access.js';
import {
  saveZitiSettings,
  checkZitiController,
} from '../openziti-controller.js';
import {
  zitiLock,
  reconcileZitiAccess,
  vmZitiAccess,
  createZitiService,
  hostEnrollment,
  createZitiGrant,
  renewZitiGrant,
  revokeZitiGrant,
  deleteZitiService,
} from '../openziti-access.js';
const vmParams = {
  type: 'object',
  required: ['vmid'],
  properties: { vmid: { type: 'integer', minimum: 100 } },
};
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};
const noBody = { type: 'object', additionalProperties: false };
export async function adminPrivateAccessRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/api/admin/private-access', () => privateAccessOverview());
  app.put('/api/admin/private-access/openziti', async (req) => {
    const saved = await zitiLock(() => saveZitiSettings(req.body));
    if (!saved.enabled) await reconcileZitiAccess();
    audit(req, null, 'admin_openziti_settings', {
      enabled: saved.enabled,
      revision: saved.revision,
    });
    return saved;
  });
  app.post(
    '/api/admin/private-access/openziti/check',
    { schema: { body: noBody } },
    () => zitiLock(() => checkZitiController()),
  );
  app.post(
    '/api/admin/private-access/openziti/reconcile',
    { schema: { body: noBody } },
    async () => {
      await reconcileZitiAccess();
      return privateAccessOverview();
    },
  );
  app.delete(
    '/api/admin/private-access/openziti/services/:id',
    { schema: { params: idParams } },
    async (req) => {
      const result = await deleteZitiService(req, req.params.id, {
        admin: true,
      });
      audit(req, null, 'admin_openziti_service_revoked', {
        serviceId: req.params.id,
      });
      return result;
    },
  );
}
export async function customerPrivateAccessRoutes(app) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get(
    '/api/vms/:vmid/private-access',
    { schema: { params: vmParams } },
    (req) => vmZitiAccess(req, Number(req.params.vmid)),
  );
  app.post(
    '/api/vms/:vmid/private-access/services',
    {
      schema: {
        params: vmParams,
        body: {
          type: 'object',
          required: ['kind'],
          additionalProperties: false,
          properties: { kind: { enum: ['ssh', 'rdp'] } },
        },
      },
    },
    (req) => createZitiService(req, Number(req.params.vmid), req.body.kind),
  );
  const rate = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  app.post(
    '/api/private-access/services/:id/host-enrollment',
    { config: rate, schema: { params: idParams, body: noBody } },
    (req) => hostEnrollment(req, req.params.id),
  );
  app.post(
    '/api/private-access/services/:id/access',
    { config: rate, schema: { params: idParams, body: noBody } },
    (req) => createZitiGrant(req, req.params.id),
  );
  app.delete(
    '/api/private-access/services/:id',
    { schema: { params: idParams } },
    (req) => deleteZitiService(req, req.params.id),
  );
  app.post(
    '/api/private-access/grants/:id/renew',
    { config: rate, schema: { params: idParams, body: noBody } },
    (req) => renewZitiGrant(req, req.params.id),
  );
  app.delete(
    '/api/private-access/grants/:id',
    { schema: { params: idParams } },
    (req) => revokeZitiGrant(req, req.params.id),
  );
}
