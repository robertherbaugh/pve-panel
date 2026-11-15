import { audit } from '../db.js';
import { MAX_BRANDING_BYTES, brandingSettings, saveBrandingName, saveBrandingAsset, removeBrandingAsset } from '../branding.js';

export default async function brandingRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.get('/api/admin/settings/branding', async () => brandingSettings());
  app.put('/api/admin/settings/branding', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 40 } } } },
  }, async (req) => {
    const state = saveBrandingName(req.body.name, req.headers['if-match']);
    audit(req, null, 'admin_branding', { name: state.name });
    return state;
  });
  app.put('/api/admin/settings/branding/:slot', {
    bodyLimit: Math.ceil(MAX_BRANDING_BYTES / 3) * 4 + 1024,
    schema: { body: { type: 'object', required: ['type', 'data'], additionalProperties: false, properties: {
      type: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] },
      data: { type: 'string', minLength: 4, maxLength: Math.ceil(MAX_BRANDING_BYTES / 3) * 4 },
    } } },
  }, async (req) => {
    const state = saveBrandingAsset(req.params.slot, req.body, req.headers['if-match']);
    audit(req, null, 'admin_branding', { slot: req.params.slot, type: req.body.type, bytes: state.assets[req.params.slot].bytes });
    return state;
  });
  app.delete('/api/admin/settings/branding/:slot', async (req) => {
    const state = removeBrandingAsset(req.params.slot, req.headers['if-match']);
    audit(req, null, 'admin_branding', { slot: req.params.slot, removed: true });
    return state;
  });
}
