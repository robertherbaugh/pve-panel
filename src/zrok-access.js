import { randomUUID, randomBytes } from "node:crypto";
import { db, audit } from "./db.js";
import { seal, open } from "./secrets.js";
import { authorizationFor, authorizedRow, customerHasGuest } from "./access.js";
import { requireCustomer, customerById } from "./tenancy.js";
import {
  networkRequest,
  initializeNetworkAuthorization,
} from "./network-authorizations.js";
import { clusterGuests, pve, guestPath } from "./pve.js";
import { assertComputeIdle } from "./compute-state.js";
import { capacityBusy } from "./capacity.js";
import { withPrivateAccessSetup } from "./private-access-guard.js";
import { installZrokAgent } from "./zrok-host.js";
import {
  zrokSettings,
  zrokRequest,
  zrokLock,
  sharingError,
} from "./zrok-controller.js";

const account = (id) =>
  db.prepare("SELECT * FROM zrok_accounts WHERE id=?").get(id);
const share = (id) =>
  db.prepare("SELECT * FROM zrok_shares WHERE id=?").get(id);
const secret = (a, key) => open(`zrok-account-${a.id}-${key}`, a[key]);
const tokenFor = (a) => secret(a, "token");
const targetFor = (s) =>
  s.mode === "public" ? `http://127.0.0.1:${s.port}` : `127.0.0.1:${s.port}`;
const remote = (a, method, path, body, options) =>
  zrokRequest(method, path, body, { token: tokenFor(a), ...options });
const safeAccount = (a) =>
  a && { id: a.id, vmid: a.vmid, state: a.state, error: a.error };
const safeShare = (s) => ({
  id: s.id,
  vmid: s.vmid,
  customer_id: s.customer_id,
  mode: s.mode,
  port: s.port,
  enabled: !!s.enabled,
  state: s.state,
  error: s.error,
  name: s.name,
  endpoints: JSON.parse(s.endpoints),
  // Private share tokens are routing identifiers. Only explicitly granted accounts can dial them.
  privateToken: s.mode === "private" ? s.token : null,
});
function enabled() {
  if (!zrokSettings().enabled)
    throw sharingError("zrok sharing is disabled", 409);
}
async function authorize(req, vmid, action = "sharing.read") {
  if (req.user?.az && !authorizationFor(req))
    throw sharingError(
      "Refresh your SSO authorization before managing sharing",
      403,
    );
  const identity = authorizationFor(req);
  if (req.user?.az && identity)
    initializeNetworkAuthorization(
      db.prepare("SELECT * FROM users WHERE id=?").get(req.account.id),
      identity,
    );
  requireCustomer(req);
  const row = await authorizedRow(req, vmid, action);
  const guest = (await clusterGuests()).get(vmid);
  if (row.state !== "ready")
    throw sharingError("Wait until the VM operation finishes", 409);
  if (!guest || guest.template) throw sharingError("Server not found", 404);
  return guest;
}
async function scoped(req, id, action) {
  const s = share(id);
  if (!s || s.customer_id !== requireCustomer(req).id)
    throw sharingError("Share not found", 404);
  await authorize(req, s.vmid, action);
  return s;
}
// A random durable account name and password make uncertain creation outcomes
// recoverable through /login, without adopting an unrelated provider account.
async function ensureAccount(customerId, { vmid = null, userId = null }) {
  let a = db
    .prepare(
      "SELECT * FROM zrok_accounts WHERE customer_id=? AND vmid IS ? AND user_id IS ?",
    )
    .get(customerId, vmid, userId);
  if (!a) {
    const id = randomUUID(),
      email = `panel-${id}@accounts.invalid`;
    db.prepare(
      "INSERT INTO zrok_accounts(id,customer_id,vmid,user_id,email,password) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      customerId,
      vmid,
      userId,
      email,
      seal(
        `zrok-account-${id}-password`,
        randomBytes(36).toString("base64url"),
      ),
    );
    a = account(id);
  }
  if (a.state === "revoking")
    throw sharingError("Account revocation is pending", 409);
  if (!a.token) {
    const credentials = { email: a.email, password: secret(a, "password") };
    let token = await zrokRequest("POST", "/login", credentials, {
      token: "",
      unauthorized: true,
    });
    if (!token)
      token = (await zrokRequest("POST", "/account", credentials))
        ?.accountToken;
    if (typeof token !== "string" || !token)
      throw sharingError("zrok account creation needs reconciliation", 502);
    db.prepare("UPDATE zrok_accounts SET token=? WHERE id=?").run(
      seal(`zrok-account-${a.id}-token`, token),
      a.id,
    );
  }
  return account(a.id);
}
async function removeAccount(a) {
  db.prepare("UPDATE zrok_accounts SET state='revoking' WHERE id=?").run(a.id);
  try {
    await zrokRequest(
      "DELETE",
      "/account",
      { email: a.email },
      { missing: true },
    );
    db.prepare(
      "DELETE FROM zrok_grants WHERE account_id=? OR share_id IN (SELECT id FROM zrok_shares WHERE account_id=?)",
    ).run(a.id, a.id);
    db.prepare("DELETE FROM zrok_shares WHERE account_id=?").run(a.id);
    db.prepare("DELETE FROM zrok_accounts WHERE id=?").run(a.id);
  } catch (e) {
    db.prepare("UPDATE zrok_accounts SET error=? WHERE id=?").run(
      e.message,
      a.id,
    );
    throw e;
  }
}
async function bootstrap(a) {
  if (a.bootstrap) return JSON.parse(secret(a, "bootstrap"));
  // A lost enable response cannot recover its private key. An isolated VM account
  // has no shares at this stage, so remove only its stale environments and retry.
  if (!a.environment) {
    const envs = await remote(a, "GET", "/environments");
    if (!Array.isArray(envs?.environments))
      throw sharingError("Invalid zrok environment inventory", 502);
    for (const env of envs.environments)
      await remote(a, "POST", "/disable", { identity: env.zId });
    const env = await remote(a, "POST", "/enable", {
      description: `PVE Panel ${a.id}`,
      host: `vm-${a.vmid}`,
    });
    if (!env?.identity || typeof env.cfg !== "string")
      throw sharingError("Incomplete zrok machine enrollment", 502);
    // Persist before the next remote call. Reuse the same certificate on retry.
    const data = {
      identity: env.identity,
      cfg: env.cfg,
      apiEndpoint: zrokSettings().endpoint,
      accountToken: tokenFor(a),
    };
    db.prepare(
      "UPDATE zrok_accounts SET environment=?,bootstrap=? WHERE id=?",
    ).run(
      env.identity,
      seal(`zrok-account-${a.id}-bootstrap`, JSON.stringify(data)),
      a.id,
    );
    a = account(a.id);
  }
  return JSON.parse(secret(a, "bootstrap"));
}
async function enrolledBootstrap(a) {
  const data = await bootstrap(a);
  if (!data.enrollmentToken) {
    // Unenroll handles a lost enrollment response. No agent has received the
    // certificate yet, so replacing the remoting token cannot interrupt a share.
    try {
      await remote(a, "POST", "/agent/unenroll", { envZId: data.identity });
    } catch (e) {
      if (!/HTTP 400$/.test(e.message)) throw e;
    }
    const result = await remote(a, "POST", "/agent/enroll", {
      envZId: data.identity,
    });
    if (!result?.token)
      throw sharingError("Incomplete zrok agent enrollment", 502);
    data.enrollmentToken = result.token;
    db.prepare("UPDATE zrok_accounts SET bootstrap=? WHERE id=?").run(
      seal(`zrok-account-${a.id}-bootstrap`, JSON.stringify(data)),
      a.id,
    );
  }
  return data;
}
export function vmSharing(req, vmid) {
  return (async () => {
    await authorize(req, vmid);
    const c = requireCustomer(req),
      s = zrokSettings();
    return {
      enabled: s.enabled,
      configured: s.configured,
      publicEnabled: s.publicEnabled,
      endpoint: s.endpoint,
      agent: safeAccount(
        db
          .prepare("SELECT * FROM zrok_accounts WHERE customer_id=? AND vmid=?")
          .get(c.id, vmid),
      ),
      shares: db
        .prepare("SELECT * FROM zrok_shares WHERE customer_id=? AND vmid=?")
        .all(c.id, vmid)
        .map(safeShare),
    };
  })();
}
export function setupSharingAgent(req, vmid) {
  return withPrivateAccessSetup(vmid, async () => {
    const { guest, a, data } = await zrokLock(async () => {
      enabled();
      const guest = await authorize(req, vmid, "sharing.manage");
      const c = requireCustomer(req);
      assertComputeIdle(vmid);
      if (capacityBusy(c.id))
        throw sharingError(
          "Wait until the customer compute operation finishes",
          409,
        );
      if (guest.type !== "qemu" || guest.status !== "running")
        throw sharingError(
          "Start a Linux QEMU VM with its guest agent to install zrok",
          409,
        );
      const cfg = await pve.get(`${guestPath(guest)}/config`);
      if (/^win/i.test(cfg.ostype ?? ""))
        throw sharingError(
          "Automatic zrok installation currently supports Linux VMs",
          409,
        );
      const a = await ensureAccount(c.id, { vmid });
      const data = await enrolledBootstrap(a);
      return { guest, a, data };
    });
    const check = async () => {
      enabled();
      await authorize(req, vmid, "sharing.manage");
      const current = account(a.id);
      if (
        !current ||
        current.state === "revoking" ||
        current.environment !== data.identity
      )
        throw sharingError(
          "The sharing agent was revoked during installation",
          409,
        );
    };
    try {
      // Guest setup can take minutes. Release the provider lock so other
      // customers' access can still be revoked while installation waits.
      await installZrokAgent(guest, a.id, data, check);
      return await zrokLock(async () => {
        await check();
        await remote(account(a.id), "POST", "/agent/ping", {
          envZId: data.identity,
        });
        await check();
        db.prepare(
          "UPDATE zrok_accounts SET state='ready',error=NULL WHERE id=?",
        ).run(a.id);
        audit(req, vmid, "zrok_agent_installed");
        return safeAccount(account(a.id));
      });
    } catch (e) {
      db.prepare(
        "UPDATE zrok_accounts SET state='error',error=? WHERE id=? AND state!='revoking'",
      ).run(e.message, a.id);
      throw e;
    }
  });
}
async function agentShares(a) {
  const result = await remote(a, "POST", "/agent/status", {
    envZId: a.environment,
  });
  if (result?.shares != null && !Array.isArray(result.shares))
    throw sharingError("Invalid zrok agent response", 502);
  return result?.shares ?? [];
}
function matches(s, r) {
  return r.shareMode === s.mode && r.backendEndpoint === targetFor(s);
}
async function updateShare(s, r) {
  if (!r.token)
    throw sharingError(
      "The zrok agent is restoring the share. Retry shortly.",
      409,
    );
  const publicOrigin = zrokSettings().publicOrigin;
  const expected = publicOrigin ? new URL(publicOrigin) : null;
  if (expected) expected.hostname = `${s.name}.${expected.hostname}`;
  const endpoints = (r.frontendEndpoints ?? []).flatMap((raw) => {
    try {
      const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
      return expected &&
        u.hostname === expected.hostname &&
        !u.username &&
        !u.password
        ? [expected.origin]
        : [];
    } catch {
      return [];
    }
  });
  if (s.mode === "public" && !endpoints.length)
    throw sharingError(
      "Configure the zrok frontend HTTPS URL template before sharing",
      409,
    );
  const detail =
    s.mode === "private"
      ? await remote(
          account(s.account_id),
          "GET",
          `/detail/share/${encodeURIComponent(r.token)}`,
        )
      : null;
  const generation =
    s.mode === "private" ? detail?.zId && `${detail.zId}:${r.token}` : r.token;
  if (!generation) throw sharingError("Incomplete zrok share identity", 502);
  db.prepare(
    "UPDATE zrok_shares SET token=?,generation=?,endpoints=?,state='active',error=NULL WHERE id=?",
  ).run(r.token, generation, JSON.stringify(endpoints), s.id);
}
async function activate(s) {
  const a = account(s.account_id);
  const found = (await agentShares(a)).filter((r) => matches(s, r));
  if (found.length > 1)
    throw sharingError(
      "Duplicate agent shares need provider reconciliation",
      409,
    );
  if (found.length) {
    await updateShare(s, found[0]);
    return;
  }
  if (s.mode === "public") {
    if (!a.namespace_granted) {
      await zrokRequest("POST", "/namespace/grant", {
        namespaceToken: zrokSettings().namespace,
        email: a.email,
      });
      db.prepare("UPDATE zrok_accounts SET namespace_granted=1 WHERE id=?").run(
        a.id,
      );
    }
    // The isolated VM account owns this name. Repeated reservation is idempotent.
    const names = await remote(a, "GET", "/share/names");
    if (!Array.isArray(names))
      throw sharingError("Invalid zrok share name inventory", 502);
    if (
      !names.some(
        (n) =>
          n.namespaceToken === zrokSettings().namespace && n.name === s.name,
      )
    )
      await remote(a, "POST", "/share/name", {
        namespaceToken: zrokSettings().namespace,
        name: s.name,
      });
    await remote(a, "PATCH", "/share/name", {
      namespaceToken: zrokSettings().namespace,
      name: s.name,
      reserved: true,
    });
  }
  const r = await remote(
    a,
    "POST",
    "/agent/share",
    {
      envZId: a.environment,
      shareMode: s.mode,
      target: targetFor(s),
      backendMode: s.mode === "public" ? "proxy" : "tcpTunnel",
      open: s.mode === "public",
      accessGrants: [],
      ...(s.mode === "public"
        ? {
            nameSelections: [
              { namespaceToken: zrokSettings().namespace, name: s.name },
            ],
          }
        : {}),
    },
    { timeoutMs: 60000 },
  );
  await updateShare(s, {
    ...r,
    shareMode: s.mode,
    backendEndpoint: targetFor(s),
  });
}
export function createShare(req, vmid, input) {
  return zrokLock(() =>
    withPrivateAccessSetup(vmid, async () => {
      enabled();
      await authorize(req, vmid, "sharing.manage");
      assertComputeIdle(vmid);
      const c = requireCustomer(req),
        settings = zrokSettings();
      if (
        !["public", "private"].includes(input.mode) ||
        !Number.isInteger(input.port) ||
        input.port < 1 ||
        input.port > 65535
      )
        throw sharingError("Choose a share type and a local port");
      if (
        input.mode === "public" &&
        (!settings.publicEnabled || input.confirmPublic !== true)
      )
        throw sharingError(
          "Public HTTPS sharing requires provider enablement and explicit confirmation",
        );
      const a = db
        .prepare(
          "SELECT * FROM zrok_accounts WHERE customer_id=? AND vmid=? AND state='ready'",
        )
        .get(c.id, vmid);
      if (!a) throw sharingError("Install the VM sharing agent first", 409);
      let s = db
        .prepare("SELECT * FROM zrok_shares WHERE vmid=? AND mode=? AND port=?")
        .get(vmid, input.mode, input.port);
      if (s)
        throw sharingError(
          "A share already exists for this port and type. Use its enable or retry action.",
          409,
        );
      if (
        db
          .prepare("SELECT count(*) AS n FROM zrok_shares WHERE customer_id=?")
          .get(c.id).n >= 100
      )
        throw sharingError("Customer sharing limit reached", 409);
      const id = randomUUID();
      db.prepare(
        "INSERT INTO zrok_shares(id,account_id,customer_id,vmid,user_id,mode,port,name,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        a.id,
        c.id,
        vmid,
        req.account.id,
        input.mode,
        input.port,
        `p${id.replaceAll("-", "").slice(0, 31)}`,
        Math.floor(Date.now() / 1000),
      );
      s = share(id);
      try {
        await activate(s);
        await authorize(req, vmid, "sharing.manage");
      } catch (e) {
        db.prepare(
          "UPDATE zrok_shares SET state='error',error=? WHERE id=?",
        ).run(e.message, id);
        throw e;
      }
      audit(req, vmid, "zrok_share_created", {
        shareId: id,
        mode: s.mode,
        port: s.port,
      });
      return safeShare(share(id));
    }),
  );
}
async function stopShare(s) {
  db.prepare("UPDATE zrok_shares SET state='revoking' WHERE id=?").run(s.id);
  const a = account(s.account_id);
  try {
    const running = (await agentShares(a)).filter((r) => matches(s, r));
    for (const r of running) {
      if (!r.token)
        throw sharingError(
          "The agent is restoring a share. Revocation will retry.",
          409,
        );
      await remote(a, "POST", "/agent/unshare", {
        envZId: a.environment,
        token: r.token,
      });
    }
    if (s.token)
      await remote(
        a,
        "DELETE",
        "/unshare",
        { envZId: a.environment, shareToken: s.token },
        { missing: true },
      );
    db.prepare("DELETE FROM zrok_grants WHERE share_id=?").run(s.id);
    db.prepare(
      "UPDATE zrok_shares SET state='disabled',token=NULL,endpoints='[]',error=NULL WHERE id=?",
    ).run(s.id);
  } catch (e) {
    // Remove the controller binding even if the VM is offline. Keep the durable
    // job until the agent's restart registry has also confirmed removal.
    if (s.token)
      try {
        await remote(
          a,
          "DELETE",
          "/unshare",
          { envZId: a.environment, shareToken: s.token },
          { missing: true },
        );
      } catch {
        /* Retry. */
      }
    db.prepare("UPDATE zrok_shares SET error=? WHERE id=?").run(
      e.message,
      s.id,
    );
    throw e;
  }
}
export function changeShare(req, id, on) {
  return zrokLock(async () => {
    const s = await scoped(req, id, "sharing.manage");
    if (on) {
      enabled();
      if (s.mode === "public" && !zrokSettings().publicEnabled)
        throw sharingError("Public sharing is disabled", 409);
      if (s.state === "revoking")
        throw sharingError(
          "Wait for revocation to finish before enabling this share",
          409,
        );
      db.prepare(
        "UPDATE zrok_shares SET enabled=1,state='pending' WHERE id=?",
      ).run(id);
      try {
        await activate(share(id));
      } catch (e) {
        db.prepare(
          "UPDATE zrok_shares SET state='error',error=? WHERE id=?",
        ).run(e.message, id);
        throw e;
      }
    } else {
      db.prepare("UPDATE zrok_shares SET enabled=0 WHERE id=?").run(id);
      await stopShare(s);
    }
    audit(req, s.vmid, on ? "zrok_share_enabled" : "zrok_share_disabled", {
      shareId: id,
    });
    return safeShare(share(id));
  });
}
export function deleteShare(req, id) {
  return zrokLock(async () => {
    const s = await scoped(req, id, "sharing.manage");
    db.prepare("UPDATE zrok_shares SET enabled=0 WHERE id=?").run(id);
    await stopShare(s);
    db.prepare("DELETE FROM zrok_shares WHERE id=?").run(id);
    audit(req, s.vmid, "zrok_share_deleted", { shareId: id });
    return { ok: true };
  });
}
export function connectPrivateShare(req, id) {
  return zrokLock(async () => {
    enabled();
    const s = await scoped(req, id, "sharing.read");
    if (s.mode !== "private" || !s.enabled || s.state !== "active")
      throw sharingError("Enable a private share first", 409);
    const a = await ensureAccount(s.customer_id, { userId: req.account.id });
    if (
      !db
        .prepare(
          "SELECT 1 FROM zrok_grants WHERE share_id=? AND account_id=? AND applied_token=?",
        )
        .get(id, a.id, s.generation)
    )
      await remote(account(s.account_id), "PATCH", "/share", {
        shareToken: s.token,
        addAccessGrants: [a.email],
      });
    db.prepare(
      "INSERT INTO zrok_grants(share_id,account_id,applied_token) VALUES(?,?,?) ON CONFLICT(share_id,account_id) DO UPDATE SET applied_token=excluded.applied_token",
    ).run(id, a.id, s.generation);
    await scoped(req, id, "sharing.read");
    db.prepare("UPDATE zrok_accounts SET state='ready' WHERE id=?").run(a.id);
    audit(req, s.vmid, "zrok_private_access", { shareId: id });
    return {
      endpoint: zrokSettings().endpoint,
      enableToken: tokenFor(a),
      shareToken: s.token,
    };
  });
}
export function removeSharingAgent(req, vmid, { admin = false } = {}) {
  return zrokLock(async () => {
    if (!admin) await authorize(req, vmid, "sharing.manage");
    const a = db.prepare("SELECT * FROM zrok_accounts WHERE vmid=?").get(vmid);
    if (a && !admin && a.customer_id !== requireCustomer(req).id)
      throw sharingError("Agent not found", 404);
    if (a) await removeAccount(a);
    audit(req, vmid, "zrok_agent_revoked");
    return { ok: true };
  });
}
export function zrokOverview() {
  return {
    settings: zrokSettings(),
    agents: db
      .prepare("SELECT * FROM zrok_accounts WHERE vmid IS NOT NULL")
      .all()
      .map((a) => ({ ...safeAccount(a), customer_id: a.customer_id })),
    shares: db.prepare("SELECT * FROM zrok_shares").all().map(safeShare),
    clients: db
      .prepare(
        "SELECT id,customer_id,user_id,state,error FROM zrok_accounts WHERE user_id IS NOT NULL",
      )
      .all(),
  };
}
export function reconcileZrok() {
  return zrokLock(async () => {
    const settings = zrokSettings();
    for (const a of db.prepare("SELECT * FROM zrok_accounts").all()) {
      let keep =
        settings.enabled &&
        customerById(a.customer_id)?.enabled &&
        a.state !== "revoking";
      try {
        if (keep && a.vmid != null)
          keep = await customerHasGuest(
            customerById(a.customer_id),
            (await clusterGuests()).get(a.vmid),
            db.prepare("SELECT * FROM vms WHERE vmid=?").get(a.vmid),
          );
        if (keep && a.user_id != null)
          keep = !!db
            .prepare("SELECT 1 FROM zrok_grants WHERE account_id=?")
            .get(a.id);
        if (!keep) {
          await removeAccount(a);
          continue;
        }
      } catch {
        continue;
      }
      if (a.vmid == null) continue;
      if (!settings.publicEnabled && a.namespace_granted) {
        try {
          await zrokRequest("DELETE", "/namespace/grant", {
            namespaceToken: settings.namespace,
            email: a.email,
          });
          db.prepare(
            "UPDATE zrok_accounts SET namespace_granted=0 WHERE id=?",
          ).run(a.id);
        } catch (e) {
          db.prepare("UPDATE zrok_accounts SET error=? WHERE id=?").run(
            e.message,
            a.id,
          );
        }
      }
      for (const s of db
        .prepare("SELECT * FROM zrok_shares WHERE account_id=?")
        .all(a.id)) {
        try {
          let permitted = false;
          try {
            await authorize(
              networkRequest(s.user_id, s.customer_id),
              s.vmid,
              "sharing.manage",
            );
            permitted = true;
          } catch {
            /* Revoke. */
          }
          if (
            !permitted ||
            (s.mode === "public" && !settings.publicEnabled) ||
            !s.enabled ||
            s.state === "revoking"
          ) {
            db.prepare("UPDATE zrok_shares SET enabled=0 WHERE id=?").run(s.id);
            if (s.state !== "disabled") await stopShare(s);
            continue;
          }
          // A restarted agent can issue a new share token. Refresh it from the
          // exact VM/type/loopback-port before synchronizing private grants.
          let running = (await agentShares(a)).filter((r) => matches(s, r));
          if (!running.length) {
            // zrok persists reserved public names, but ordinary private shares
            // are ephemeral in the agent registry. Restore the desired share.
            if (s.token)
              await remote(
                a,
                "DELETE",
                "/unshare",
                { envZId: a.environment, shareToken: s.token },
                { missing: true },
              );
            await activate(s);
            running = (await agentShares(a)).filter((r) => matches(s, r));
          }
          if (running.length !== 1)
            throw sharingError(
              "The zrok agent is offline or restoring this share",
              502,
            );
          await updateShare(s, running[0]);
          for (const g of db
            .prepare(
              "SELECT a.*,g.applied_token FROM zrok_grants g JOIN zrok_accounts a ON a.id=g.account_id WHERE g.share_id=?",
            )
            .all(s.id)) {
            try {
              await authorize(
                networkRequest(g.user_id, g.customer_id),
                s.vmid,
                "sharing.read",
              );
            } catch {
              await remote(a, "PATCH", "/share", {
                shareToken: running[0].token,
                removeAccessGrants: [g.email],
              });
              db.prepare(
                "DELETE FROM zrok_grants WHERE share_id=? AND account_id=?",
              ).run(s.id, g.id);
              // Delete the client identity to terminate cached sessions. Other
              // shares can be reconnected with a new isolated client account.
              await removeAccount(g);
              continue;
            }
            if (g.applied_token !== share(s.id).generation) {
              await remote(a, "PATCH", "/share", {
                shareToken: running[0].token,
                addAccessGrants: [g.email],
              });
              db.prepare(
                "UPDATE zrok_grants SET applied_token=? WHERE share_id=? AND account_id=?",
              ).run(share(s.id).generation, s.id, g.id);
            }
          }
        } catch (e) {
          db.prepare("UPDATE zrok_shares SET error=? WHERE id=?").run(
            e.message,
            s.id,
          );
        }
      }
    }
  });
}
export function startZrokReconciliation(log) {
  const run = () =>
    reconcileZrok().catch(() =>
      log.warn("zrok reconciliation needs provider attention"),
    );
  const timer = setInterval(run, 30000);
  timer.unref();
  void run();
}
