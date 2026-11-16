import { audit } from "../db.js";
import {
  zrokLock,
  saveZrokSettings,
  checkZrokController,
} from "../zrok-controller.js";
import {
  zrokOverview,
  reconcileZrok,
  vmSharing,
  setupSharingAgent,
  createShare,
  changeShare,
  deleteShare,
  connectPrivateShare,
  removeSharingAgent,
} from "../zrok-access.js";
const vm = {
  type: "object",
  required: ["vmid"],
  properties: { vmid: { type: "integer", minimum: 100 } },
};
const id = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
const empty = { type: "object", additionalProperties: false };
const rate = { rateLimit: { max: 10, timeWindow: "1 minute" } };
export async function adminSharingRoutes(app) {
  app.addHook("preHandler", app.requireAdmin);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.put("/api/admin/private-access/zrok", async (req) => {
    const result = await zrokLock(() => saveZrokSettings(req.body));
    if (!result.enabled || !result.publicEnabled) await reconcileZrok();
    audit(req, null, "admin_zrok_settings", {
      enabled: result.enabled,
      publicEnabled: result.publicEnabled,
    });
    return result;
  });
  app.post(
    "/api/admin/private-access/zrok/check",
    { schema: { body: empty } },
    () => zrokLock(checkZrokController),
  );
  app.post(
    "/api/admin/private-access/zrok/reconcile",
    { schema: { body: empty } },
    async () => {
      await reconcileZrok();
      return zrokOverview();
    },
  );
  app.delete(
    "/api/admin/private-access/zrok/agents/:vmid",
    { schema: { params: vm } },
    (req) => removeSharingAgent(req, req.params.vmid, { admin: true }),
  );
}
export async function customerSharingRoutes(app) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.get("/api/vms/:vmid/sharing", { schema: { params: vm } }, (req) =>
    vmSharing(req, req.params.vmid),
  );
  app.post(
    "/api/vms/:vmid/sharing/agent",
    { config: rate, schema: { params: vm, body: empty } },
    (req) => setupSharingAgent(req, req.params.vmid),
  );
  app.delete(
    "/api/vms/:vmid/sharing/agent",
    { schema: { params: vm } },
    (req) => removeSharingAgent(req, req.params.vmid),
  );
  app.post(
    "/api/vms/:vmid/sharing",
    {
      config: rate,
      schema: {
        params: vm,
        body: {
          type: "object",
          required: ["mode", "port"],
          additionalProperties: false,
          properties: {
            mode: { enum: ["public", "private"] },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            confirmPublic: { type: "boolean" },
          },
        },
      },
    },
    (req) => createShare(req, req.params.vmid, req.body),
  );
  app.put(
    "/api/sharing/:id",
    {
      config: rate,
      schema: {
        params: id,
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    (req) => changeShare(req, req.params.id, req.body.enabled),
  );
  app.delete("/api/sharing/:id", { schema: { params: id } }, (req) =>
    deleteShare(req, req.params.id),
  );
  app.post(
    "/api/sharing/:id/access",
    { config: rate, schema: { params: id, body: empty } },
    (req) => connectPrivateShare(req, req.params.id),
  );
}
