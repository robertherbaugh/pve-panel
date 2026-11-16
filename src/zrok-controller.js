import { randomUUID } from "node:crypto";
import { fetch } from "undici";
import { db } from "./db.js";
import { seal, open } from "./secrets.js";

export const sharingError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode, expose: true });
let queue = Promise.resolve();
export function zrokLock(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
db.exec(`CREATE TABLE IF NOT EXISTS zrok_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0, public_enabled INTEGER NOT NULL DEFAULT 0,
 endpoint TEXT NOT NULL DEFAULT '', public_origin TEXT NOT NULL DEFAULT '', namespace TEXT NOT NULL DEFAULT 'public',
 admin_token TEXT, verified_at TEXT, check_error TEXT
);`);
db.prepare(
  "INSERT OR IGNORE INTO zrok_settings(id,instance_id) VALUES(1,?)",
).run(randomUUID());
export function zrokSettings({ secrets = false } = {}) {
  const s = db.prepare("SELECT * FROM zrok_settings WHERE id=1").get();
  return {
    revision: s.revision,
    instanceId: s.instance_id,
    enabled: !!s.enabled,
    publicEnabled: !!s.public_enabled,
    publicOrigin: s.public_origin,
    endpoint: s.endpoint,
    namespace: s.namespace,
    configured: !!(s.endpoint && s.admin_token),
    credentialConfigured: !!s.admin_token,
    verifiedAt: s.verified_at,
    checkError: s.check_error,
    ...(secrets
      ? { adminToken: s.admin_token ? open("zrok-admin", s.admin_token) : "" }
      : {}),
  };
}
function endpoint(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw sharingError("Enter your self-hosted zrok HTTPS origin");
  }
  const test =
    process.env.NODE_ENV === "test" &&
    process.env.ZROK_TEST_MODE === "true" &&
    u.hostname === "127.0.0.1" &&
    u.protocol === "http:";
  if (
    (!test && u.protocol !== "https:") ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    value.length > 500 ||
    /(^|\.)zrok\.io$/.test(u.hostname)
  )
    throw sharingError(
      "Use your self-hosted zrok HTTPS origin without a path or credentials",
    );
  return u.origin;
}
export function saveZrokSettings(input) {
  const s = zrokSettings();
  if (!input || input.revision !== s.revision)
    throw sharingError("zrok settings changed. Reload before saving.", 409);
  if (
    Object.keys(input).some(
      (k) =>
        ![
          "revision",
          "enabled",
          "publicEnabled",
          "publicOrigin",
          "endpoint",
          "namespace",
          "adminToken",
        ].includes(k),
    ) ||
    typeof input.enabled !== "boolean" ||
    typeof input.publicEnabled !== "boolean" ||
    typeof input.publicOrigin !== "string" ||
    typeof input.endpoint !== "string" ||
    typeof input.namespace !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.namespace) ||
    (input.adminToken !== undefined &&
      (typeof input.adminToken !== "string" ||
        input.adminToken.length < 32 ||
        input.adminToken.length > 2048))
  )
    throw sharingError("Invalid zrok configuration");
  const origin = input.endpoint ? endpoint(input.endpoint) : "";
  const publicOrigin = input.publicOrigin ? endpoint(input.publicOrigin) : "";
  if (input.publicEnabled && !publicOrigin)
    throw sharingError(
      "Configure the public HTTPS share origin before allowing public sharing",
    );
  const managed = db.prepare("SELECT 1 FROM zrok_accounts LIMIT 1").get();
  if (
    managed &&
    (origin !== s.endpoint ||
      input.namespace !== s.namespace ||
      publicOrigin !== s.publicOrigin)
  )
    throw sharingError(
      "Remove managed zrok agents and client accounts before changing the server or namespace",
      409,
    );
  const changed =
    origin !== s.endpoint ||
    input.namespace !== s.namespace ||
    !!input.adminToken;
  if (
    input.enabled &&
    (!origin ||
      !(input.adminToken || s.credentialConfigured) ||
      changed ||
      !s.verifiedAt ||
      s.checkError ||
      Date.now() - Date.parse(s.verifiedAt) > 300000)
  )
    throw sharingError(
      "Save disabled settings and pass the self-hosted controller check before enabling zrok",
    );
  db.prepare(
    `UPDATE zrok_settings SET revision=revision+1,enabled=?,public_enabled=?,endpoint=?,public_origin=?,namespace=?,admin_token=COALESCE(?,admin_token),
    verified_at=CASE WHEN ? THEN NULL ELSE verified_at END,check_error=CASE WHEN ? THEN NULL ELSE check_error END WHERE id=1`,
  ).run(
    +input.enabled,
    +input.publicEnabled,
    origin,
    publicOrigin,
    input.namespace,
    input.adminToken ? seal("zrok-admin", input.adminToken) : null,
    +changed,
    +changed,
  );
  return zrokSettings();
}
export async function zrokRequest(
  method,
  path,
  body,
  { token, missing = false, unauthorized = false, timeoutMs = 20000 } = {},
) {
  const s = zrokSettings({ secrets: true });
  if (!s.configured)
    throw sharingError("Configure your self-hosted zrok server first", 409);
  try {
    const r = await fetch(`${s.endpoint}/api/v2${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/zrok.v1+json",
        accept: "application/zrok.v1+json",
        "x-token": token ?? s.adminToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if ((missing && r.status === 404) || (unauthorized && r.status === 401)) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw sharingError(`Self-hosted zrok returned HTTP ${r.status}`, 502);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (e.expose) throw e;
    throw sharingError(
      "Self-hosted zrok request failed. Check connectivity and TLS.",
      502,
    );
  }
}
export async function checkZrokController() {
  const s = zrokSettings();
  try {
    const v = await zrokRequest("GET", "/versions");
    if (!/^v?2\./.test(v?.controllerVersion))
      throw sharingError(
        "This integration requires a self-hosted zrok 2 controller",
        409,
      );
    const ns = await zrokRequest("GET", "/namespaces");
    // The v2 API omits a false boolean. Reject explicit non-boolean values.
    const closed = (n) => n && (n.open === false || !Object.hasOwn(n, "open"));
    if (
      !Array.isArray(ns) ||
      !ns.every(closed) ||
      !ns.some((n) => n.namespaceToken === s.namespace && closed(n))
    )
      throw sharingError(
        "Create a closed zrok namespace before enabling sharing",
        409,
      );
    db.prepare(
      "UPDATE zrok_settings SET verified_at=?,check_error=NULL WHERE id=1 AND revision=?",
    ).run(new Date().toISOString(), s.revision);
    return { settings: zrokSettings(), version: v.controllerVersion };
  } catch (e) {
    db.prepare(
      "UPDATE zrok_settings SET verified_at=NULL,check_error=? WHERE id=1 AND revision=?",
    ).run(e.message, s.revision);
    throw e;
  }
}
