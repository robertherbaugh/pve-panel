// Provider credentials stay encrypted. Enrollment JWTs never enter the panel database.
import { randomUUID, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Agent, fetch } from "undici";
import { db } from "./db.js";
import { seal, open } from "./secrets.js";
export const zitiError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode, expose: true });
db.exec(`CREATE TABLE IF NOT EXISTS openziti_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0, controller TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
 password TEXT, ca_pem TEXT NOT NULL DEFAULT '', router_role TEXT NOT NULL DEFAULT 'rcadea-customers', verified_at TEXT, check_error TEXT
);`);
db.prepare(
  "INSERT OR IGNORE INTO openziti_settings(id,instance_id) VALUES(1,?)",
).run(randomUUID());
for (const [name, type] of Object.entries({
  client_url: "TEXT NOT NULL DEFAULT ''",
  panel_issuer: "TEXT NOT NULL DEFAULT ''",
  jwt_signer_id: "TEXT NOT NULL DEFAULT ''",
  user_auth_policy_id: "TEXT NOT NULL DEFAULT ''",
  host_auth_policy_id: "TEXT NOT NULL DEFAULT ''",
  auto_provision: "INTEGER NOT NULL DEFAULT 0",
})) {
  if (
    !db
      .prepare("PRAGMA table_info(openziti_settings)")
      .all()
      .some((c) => c.name === name)
  )
    db.exec(`ALTER TABLE openziti_settings ADD COLUMN ${name} ${type}`);
}
export function zitiSettings({ secrets = false } = {}) {
  const r = db.prepare("SELECT * FROM openziti_settings WHERE id=1").get();
  return {
    revision: r.revision,
    instanceId: r.instance_id,
    enabled: !!r.enabled,
    controller: r.controller,
    username: r.username,
    credentialConfigured: !!r.password,
    caPem: r.ca_pem,
    routerRole: r.router_role,
    clientUrl: r.client_url,
    panelIssuer: r.panel_issuer,
    jwtSignerId: r.jwt_signer_id,
    userAuthPolicyId: r.user_auth_policy_id,
    hostAuthPolicyId: r.host_auth_policy_id,
    autoProvision: !!r.auto_provision,
    ssoConfigured: !!(
      r.client_url &&
      r.panel_issuer &&
      r.jwt_signer_id &&
      r.user_auth_policy_id &&
      r.host_auth_policy_id
    ),
    configured: !!(r.controller && r.username && r.password && r.router_role),
    verifiedAt: r.verified_at,
    checkError: r.check_error,
    ...(secrets
      ? { password: r.password ? open("openziti-controller", r.password) : "" }
      : {}),
  };
}
export function controllerUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw zitiError("Enter the OpenZiti controller HTTPS address");
  }
  const simulator =
    process.env.NODE_ENV === "test" &&
    process.env.OPENZITI_TEST_MODE === "true" &&
    u.protocol === "http:" &&
    u.hostname === "127.0.0.1";
  if (
    (!simulator && u.protocol !== "https:") ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["/", "/edge/management/v1", "/edge/management/v1/"].includes(
      u.pathname,
    ) ||
    value.length > 500
  )
    throw zitiError(
      "Use a controller HTTPS origin without credentials or query parameters",
    );
  return u.origin;
}
export function saveZitiSettings(input) {
  const current = zitiSettings();
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "revision",
          "enabled",
          "controller",
          "username",
          "password",
          "caPem",
          "routerRole",
          "clientUrl",
          "panelIssuer",
          "jwtSignerId",
          "userAuthPolicyId",
          "hostAuthPolicyId",
          "autoProvision",
        ].includes(k),
    ) ||
    input.revision !== current.revision
  )
    throw zitiError("OpenZiti settings changed. Reload before saving.", 409);
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.controller !== "string" ||
    typeof input.username !== "string" ||
    input.username.length > 200 ||
    typeof input.caPem !== "string" ||
    input.caPem.length > 24000 ||
    typeof input.routerRole !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.routerRole) ||
    (input.password !== undefined &&
      (typeof input.password !== "string" || input.password.length > 2048))
  )
    throw zitiError("Invalid OpenZiti configuration");
  const controller = input.controller ? controllerUrl(input.controller) : "";
  const sso = Object.fromEntries(
    [
      "clientUrl",
      "panelIssuer",
      "jwtSignerId",
      "userAuthPolicyId",
      "hostAuthPolicyId",
      "autoProvision",
    ].map((k) => [k, input[k] ?? current[k]]),
  );
  if (
    typeof sso.autoProvision !== "boolean" ||
    [
      "clientUrl",
      "panelIssuer",
      "jwtSignerId",
      "userAuthPolicyId",
      "hostAuthPolicyId",
    ].some((k) => typeof sso[k] !== "string" || sso[k].length > 500) ||
    ["jwtSignerId", "userAuthPolicyId", "hostAuthPolicyId"].some(
      (k) => sso[k] && !/^[A-Za-z0-9_.-]{1,128}$/.test(sso[k]),
    )
  )
    throw zitiError("Invalid OpenZiti SSO configuration");
  if (sso.clientUrl) sso.clientUrl = controllerUrl(sso.clientUrl);
  if (sso.panelIssuer) {
    try {
      const issuer = new URL(sso.panelIssuer);
      if (
        (issuer.protocol !== "https:" &&
          !(
            process.env.NODE_ENV === "test" && issuer.hostname === "127.0.0.1"
          )) ||
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash
      )
        throw Error();
    } catch {
      throw zitiError("Enter the panel OIDC issuer HTTPS address");
    }
  }
  const caPem = input.caPem.trim();
  if (caPem) {
    const certs = caPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    try {
      if (!certs?.length) throw Error();
      for (const c of certs) new X509Certificate(c);
    } catch {
      throw zitiError("Enter a PEM certificate bundle for the controller CA");
    }
  }
  const objects =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='openziti_objects'",
      )
      .get() && db.prepare("SELECT 1 FROM openziti_objects LIMIT 1").get();
  if (
    objects &&
    (controller !== current.controller ||
      input.routerRole !== current.routerRole ||
      [
        "clientUrl",
        "panelIssuer",
        "jwtSignerId",
        "userAuthPolicyId",
        "hostAuthPolicyId",
      ].some((k) => sso[k] !== current[k]))
  )
    throw zitiError(
      "Remove managed OpenZiti services before changing controller or router role",
      409,
    );
  const password = input.password
    ? seal("openziti-controller", input.password)
    : null;
  const changed =
    controller !== current.controller ||
    input.username !== current.username ||
    !!password ||
    caPem !== current.caPem ||
    input.routerRole !== current.routerRole ||
    Object.keys(sso).some((k) => sso[k] !== current[k]);
  if (
    input.enabled &&
    (!controller ||
      !input.username.trim() ||
      !(password || current.credentialConfigured) ||
      !sso.clientUrl ||
      !sso.panelIssuer ||
      !sso.jwtSignerId ||
      !sso.userAuthPolicyId ||
      !sso.hostAuthPolicyId ||
      changed ||
      !current.verifiedAt ||
      Date.now() - Date.parse(current.verifiedAt) > 300000 ||
      current.checkError)
  )
    throw zitiError(
      "Save the disabled configuration and pass the controller check within five minutes before enabling OpenZiti",
    );
  db.prepare(
    `UPDATE openziti_settings SET revision=revision+1,enabled=?,controller=?,username=?,password=COALESCE(?,password),ca_pem=?,router_role=?,
 verified_at=CASE WHEN ? THEN NULL ELSE verified_at END,check_error=CASE WHEN ? THEN NULL ELSE check_error END,
 client_url=?,panel_issuer=?,jwt_signer_id=?,user_auth_policy_id=?,host_auth_policy_id=?,auto_provision=? WHERE id=1`,
  ).run(
    input.enabled ? 1 : 0,
    controller,
    input.username.trim(),
    password,
    caPem,
    input.routerRole,
    changed ? 1 : 0,
    changed ? 1 : 0,
    sso.clientUrl,
    sso.panelIssuer,
    sso.jwtSignerId,
    sso.userAuthPolicyId,
    sso.hostAuthPolicyId,
    sso.autoProvision ? 1 : 0,
  );
  return zitiSettings();
}
export class ZitiController {
  constructor(settings = zitiSettings({ secrets: true })) {
    if (!settings.configured)
      throw zitiError("Configure the OpenZiti controller first", 409);
    this.settings = settings;
    this.dispatcher = new Agent({
      connect: {
        rejectUnauthorized: true,
        ...(settings.caPem
          ? { ca: [...rootCertificates, settings.caPem] }
          : {}),
      },
    });
  }
  async close() {
    // Management sessions are short lived and never persisted by the panel.
    if (this.token)
      try {
        await this.request("DELETE", "/current-api-session", undefined, {
          missing: true,
        });
      } catch {
        /* Preserve the original operation result if the controller is unavailable. */
      }
    await this.dispatcher.close();
  }
  async request(
    method,
    path,
    body,
    { missing = false, envelope = false } = {},
  ) {
    try {
      const response = await fetch(
        `${this.settings.controller}/edge/management/v1${path}`,
        {
          dispatcher: this.dispatcher,
          method,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            "content-type": "application/json",
            ...(this.token ? { "zt-session": this.token } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (missing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw zitiError(
          `OpenZiti controller returned HTTP ${response.status}`,
          502,
        );
      }
      if (response.status === 204) return null;
      const result = await response.json();
      if (!Object.hasOwn(result, "data")) throw Error();
      return envelope ? result : result.data;
    } catch (err) {
      if (err.expose) throw err;
      throw zitiError(
        "OpenZiti controller request failed. Check connectivity and TLS trust.",
        502,
      );
    }
  }
  async login() {
    const r = await this.request("POST", "/authenticate?method=password", {
      username: this.settings.username,
      password: this.settings.password,
    });
    if (!r.token)
      throw zitiError(
        "Controller authentication did not return a session",
        502,
      );
    this.token = r.token;
    const identity = await this.request("GET", "/current-identity");
    if (identity.isAdmin !== true)
      throw zitiError(
        "The controller account needs management administrator access",
        502,
      );
  }
  async list(type, filter = "true") {
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const result = await this.request(
        "GET",
        `/${type}?${new URLSearchParams({ filter, limit: "100", offset: String(offset) })}`,
        undefined,
        { envelope: true },
      );
      if (
        !Array.isArray(result.data) ||
        !Number.isInteger(result.meta?.pagination?.totalCount)
      )
        throw zitiError("Invalid OpenZiti inventory response", 502);
      rows.push(...result.data);
      if (offset + result.data.length >= result.meta.pagination.totalCount)
        return rows;
      if (!result.data.length)
        throw zitiError("Incomplete OpenZiti inventory response", 502);
    }
    throw zitiError("OpenZiti inventory exceeds the supported page limit", 502);
  }
}
export async function withController(fn) {
  const client = new ZitiController();
  try {
    await client.login();
    return await fn(client);
  } finally {
    await client.close();
  }
}
export async function checkZitiController() {
  const revision = zitiSettings().revision;
  try {
    const result = await withController(async (c) => {
      const types = await c.list(
        "config-types",
        'name="host.v1" or name="intercept.v1"',
      );
      if (
        !["host.v1", "intercept.v1"].every((name) =>
          types.some((t) => t.name === name),
        )
      )
        throw zitiError(
          "Controller needs host.v1 and intercept.v1 config types",
          502,
        );
      await assertScopedController(c);
      await assertZitiAuthPolicies(c);
      const routers = (await c.list("edge-routers")).filter((r) =>
        r.roleAttributes?.includes(c.settings.routerRole),
      );
      if (!routers.some((r) => r.isOnline === true))
        throw zitiError(
          "No online edge router has the configured customer router role",
          502,
        );
      return {
        onlineRouters: routers.filter((r) => r.isOnline === true).length,
      };
    });
    db.prepare(
      "UPDATE openziti_settings SET verified_at=?,check_error=NULL WHERE id=1 AND revision=?",
    ).run(new Date().toISOString(), revision);
    return { ...result, settings: zitiSettings() };
  } catch (err) {
    db.prepare(
      "UPDATE openziti_settings SET verified_at=NULL,check_error=? WHERE id=1 AND revision=?",
    ).run(err.message, revision);
    throw err;
  }
}

export async function assertZitiAuthPolicies(c) {
  const s = c.settings;
  if (!s.ssoConfigured)
    throw zitiError(
      "Configure SSO and separate user/machine authentication policies first",
      409,
    );
  const signer = await c.request(
    "GET",
    `/external-jwt-signers/${encodeURIComponent(s.jwtSignerId)}`,
  );
  const user = await c.request(
    "GET",
    `/auth-policies/${encodeURIComponent(s.userAuthPolicyId)}`,
  );
  const host = await c.request(
    "GET",
    `/auth-policies/${encodeURIComponent(s.hostAuthPolicyId)}`,
  );
  if (
    !signer.enabled ||
    signer.claimsProperty !== "sub" ||
    signer.useExternalId !== true ||
    !signer.issuer?.startsWith("https://") ||
    !signer.audience ||
    !signer.jwksEndpoint?.startsWith("https://") ||
    signer.enrollToCertEnabled ||
    signer.enrollToTokenEnabled ||
    !signer.clientId ||
    !signer.externalAuthUrl?.startsWith("https://") ||
    user.primary?.cert?.allowed !== false ||
    user.primary?.updb?.allowed !== false ||
    user.primary?.extJwt?.allowed !== true ||
    user.primary.extJwt.allowedSigners?.length !== 1 ||
    user.primary.extJwt.allowedSigners[0] !== s.jwtSignerId ||
    user.secondary?.requireExtJwtSigner !== s.jwtSignerId ||
    user.secondary?.requireTotp === true ||
    host.primary?.cert?.allowed !== true ||
    host.primary.cert.allowExpiredCerts !== false ||
    host.primary?.updb?.allowed !== false ||
    host.primary?.extJwt?.allowed !== false ||
    host.secondary?.requireTotp === true ||
    host.secondary?.requireExtJwtSigner != null
  )
    throw zitiError(
      "Use an SSO-only user policy, a certificate-only machine policy and a signer with automatic enrollment disabled",
      409,
    );
  return { signer, user, host };
}

export async function assertScopedController(client) {
  const policies = await client.list("service-policies");
  if (policies.some((p) => p.identityRoles?.includes("#all")))
    throw zitiError(
      "Remove controller service policies that grant all identities before enabling customer access",
      409,
    );
}
