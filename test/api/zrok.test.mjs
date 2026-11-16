import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startStack, waitFor } from "../support/stack.mjs";
import { startMockZrok } from "../support/mock-zrok.mjs";
let stack, zrok, admin, alice, bob, sql, publicId, privateId;
const settings = async () =>
  (await admin.get("/api/admin/private-access")).json.zrok.settings;
async function save(patch = {}) {
  const s = await settings();
  return admin.put("/api/admin/private-access/zrok", {
    revision: s.revision,
    enabled: s.enabled,
    publicEnabled: s.publicEnabled,
    publicOrigin: s.publicOrigin,
    endpoint: s.endpoint,
    namespace: s.namespace,
    ...patch,
  });
}
before(async () => {
  zrok = await startMockZrok();
  stack = await startStack({
    env: {
      ZROK_TEST_MODE: "true",
      SETUP_CHECK_HOURS: "0",
      CUSTOMER_NETWORKS: "false",
      VPN_ENABLED: "false",
      TAILSCALE_ENABLED: "false",
    },
  });
  admin = await stack.adminSession();
  alice = await stack.customerWith("sharing-alice@example.com");
  bob = await stack.customerWith("sharing-bob@example.com");
  await admin.put("/api/admin/vms/101", { userId: alice.userId });
  stack.mock.vms.get(101).status = "running";
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await zrok?.close();
});
test("self-hosted settings require admin, reject hosted endpoints, preserve secrets, and require a recent closed-namespace check", async () => {
  assert.equal(
    (await alice.put("/api/admin/private-access/zrok", {})).status,
    404,
  );
  assert.equal((await save({ endpoint: "https://api.zrok.io" })).status, 400);
  assert.equal(
    (
      await save({
        endpoint: zrok.url,
        adminToken: zrok.adminToken,
        publicOrigin: "https://share.rcadea.cloud:9443",
      })
    ).status,
    200,
  );
  assert.equal((await save({ enabled: true })).status, 400);
  zrok.openNamespace = true;
  assert.equal(
    (await admin.post("/api/admin/private-access/zrok/check")).status,
    409,
  );
  zrok.openNamespace = false;
  assert.equal(
    (await admin.post("/api/admin/private-access/zrok/check")).status,
    200,
  );
  assert.equal((await save({ enabled: true })).status, 200);
  assert(!JSON.stringify(await settings()).includes(zrok.adminToken));
  assert(
    !JSON.stringify(sql.prepare("SELECT * FROM zrok_settings").all()).includes(
      zrok.adminToken,
    ),
  );
  assert.equal(
    (await admin.put("/api/admin/private-access/zrok", { revision: 0 })).status,
    409,
  );
});
test("agent installation isolates VM accounts, protects stdin secrets, and blocks transfer and deletion", async () => {
  assert.equal((await bob.post("/api/vms/101/sharing/agent")).status, 404);
  const r = await alice.post("/api/vms/101/sharing/agent");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.state, "ready");
  const a = sql.prepare("SELECT * FROM zrok_accounts WHERE vmid=101").get();
  assert(!a.token.includes("account-"));
  assert(!a.bootstrap.includes("private-machine-key"));
  assert(!r.text.includes("account-"));
  assert(!stack.logs().includes("private-machine-key"));
  assert(!stack.mock.vms.get(101).zrokCommand.includes("private-machine-key"));
  assert(stack.mock.vms.get(101).zrokInput.includes("private-machine-key"));
  assert.equal(
    (await admin.put("/api/admin/vms/101", { userId: bob.userId })).status,
    409,
  );
  const vm = await alice.get("/api/vms/101");
  const deletion = await alice.req("DELETE", "/api/vms/101", {
    confirmVmid: 101,
  });
  assert.equal(deletion.status, 409, deletion.text);
});
test("public exposure needs separate provider enablement and confirmation; targets stay on VM loopback", async () => {
  assert.equal(
    (
      await alice.post("/api/vms/101/sharing", {
        mode: "public",
        port: 8080,
        confirmPublic: true,
      })
    ).status,
    400,
  );
  assert.equal((await save({ publicEnabled: true })).status, 200);
  assert.equal(
    (await alice.post("/api/vms/101/sharing", { mode: "public", port: 8080 }))
      .status,
    400,
  );
  assert.equal(
    (
      await alice.post("/api/vms/101/sharing", {
        mode: "public",
        port: 9999,
        confirmPublic: true,
        target: "http://169.254.169.254",
      })
    ).status,
    200,
  );
  const r = await alice.post("/api/vms/101/sharing", {
    mode: "public",
    port: 8080,
    confirmPublic: true,
  });
  assert.equal(r.status, 200, r.text);
  publicId = r.json.id;
  assert.match(
    r.json.endpoints[0],
    /^https:\/\/p[a-f0-9]+\.share\.rcadea\.cloud:9443$/,
  );
  const request = zrok.requests.find(
    (r) =>
      r.path === "/agent/share" && r.body.target === "http://127.0.0.1:8080",
  );
  assert.equal(request.body.target, "http://127.0.0.1:8080");
  assert.notEqual(request.key, zrok.adminToken);
  assert.equal((await bob.get("/api/vms/101/sharing")).status, 404);
  assert.equal(
    (await bob.put(`/api/sharing/${publicId}`, { enabled: false })).status,
    404,
  );
});
test("private shares are closed and grant only the current authorized customer user account", async () => {
  const r = await alice.post("/api/vms/101/sharing", {
    mode: "private",
    port: 5432,
  });
  assert.equal(r.status, 200, r.text);
  privateId = r.json.id;
  const request = zrok.requests.filter((r) => r.path === "/agent/share").at(-1);
  assert.equal(request.body.open, false);
  assert.equal(request.body.target, "127.0.0.1:5432");
  assert.equal(
    (await bob.post(`/api/sharing/${privateId}/access`)).status,
    404,
  );
  const access = await alice.post(`/api/sharing/${privateId}/access`);
  assert.equal(access.status, 200, access.text);
  assert.match(access.headers.get("cache-control"), /no-store/);
  assert.equal(access.json.endpoint, zrok.url);
  const client = sql
    .prepare("SELECT * FROM zrok_accounts WHERE user_id=?")
    .get(alice.userId);
  const machine = sql
    .prepare("SELECT * FROM zrok_accounts WHERE vmid=101")
    .get();
  assert.notEqual(client.id, machine.id);
  assert.equal(zrok.accounts.get(client.email).namespaceGranted, false);
  const serialized =
    JSON.stringify(sql.prepare("SELECT * FROM audit_log").all()) + stack.logs();
  assert(!serialized.includes(access.json.enableToken));
});
test("a lost share response is recovered by exact VM, share type and loopback target without duplicates", async () => {
  zrok.loseShare = true;
  const failed = await alice.post("/api/vms/101/sharing", {
    mode: "public",
    port: 8081,
    confirmPublic: true,
  });
  assert.equal(failed.status, 502, failed.text);
  const s = sql.prepare("SELECT * FROM zrok_shares WHERE port=8081").get();
  assert(s);
  const count = zrok.requests.filter((r) => r.path === "/agent/share").length;
  const retry = await alice.put(`/api/sharing/${s.id}`, { enabled: true });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(
    zrok.requests.filter((r) => r.path === "/agent/share").length,
    count,
  );
});
test("agent restart refreshes a changed share token, preserves its public URL and restores exact private grants", async () => {
  const machine = [...zrok.accounts.values()].find((a) => a.envs.size);
  const env = [...machine.envs.values()][0];
  const old = [...env.shares.values()].find((s) => s.shareMode === "private");
  env.shares.delete(old.token);
  old.token = "new-private-token-after-restart";
  old.grants.clear();
  env.shares.set(old.token, old);
  const r = await admin.post("/api/admin/private-access/zrok/reconcile");
  assert.equal(r.status, 200, r.text);
  assert.equal(
    sql.prepare("SELECT token FROM zrok_shares WHERE id=?").get(privateId)
      .token,
    old.token,
  );
  assert.equal(old.grants.size, 1);
  old.zId = "a-new-service-with-the-same-routing-token";
  old.grants.clear();
  await admin.post("/api/admin/private-access/zrok/reconcile");
  assert.equal(
    old.grants.size,
    1,
    "a private share can restart with the same token but a new service identity",
  );
  // The real agent does not retain ordinary private shares in its restart registry.
  env.shares.delete(old.token);
  await admin.post("/api/admin/private-access/zrok/reconcile");
  const restored = [...env.shares.values()].find(
    (s) => s.shareMode === "private",
  );
  assert(
    restored,
    "the panel restores the desired private share after restart",
  );
  assert.equal(restored.grants.size, 1);
  assert.notEqual(restored.token, old.token);
  assert.match(
    JSON.parse(
      sql.prepare("SELECT endpoints FROM zrok_shares WHERE id=?").get(publicId)
        .endpoints,
    )[0],
    /:9443$/,
  );
});
test("an offline agent retains durable revocation until both controller and restart registry are cleared", async () => {
  zrok.offline = true;
  const r = await alice.put(`/api/sharing/${publicId}`, { enabled: false });
  assert.equal(r.status, 502, r.text);
  assert.equal(
    sql.prepare("SELECT state FROM zrok_shares WHERE id=?").get(publicId).state,
    "revoking",
  );
  zrok.offline = false;
  await admin.post("/api/admin/private-access/zrok/reconcile");
  assert.equal(
    sql.prepare("SELECT state FROM zrok_shares WHERE id=?").get(publicId).state,
    "disabled",
  );
  assert.equal(
    (await alice.put(`/api/sharing/${publicId}`, { enabled: true })).status,
    200,
  );
});
test("removing a client's customer membership revokes its identity while preserving the VM owner's shares", async () => {
  const customerId = (await alice.get("/api/account")).json.customer.id;
  assert.equal(
    (
      await admin.put(`/api/admin/customers/${customerId}/members`, {
        userId: bob.userId,
        role: "admin",
      })
    ).status,
    200,
  );
  assert.equal(
    (await bob.post("/api/customers/select", { customerId })).status,
    200,
  );
  const result = await bob.post(`/api/sharing/${privateId}/access`);
  assert.equal(result.status, 200, result.text);
  const client = sql
    .prepare("SELECT * FROM zrok_accounts WHERE user_id=?")
    .get(bob.userId);
  assert(client);
  await admin.del(`/api/admin/customers/${customerId}/members/${bob.userId}`);
  await admin.post("/api/admin/private-access/zrok/reconcile");
  assert.equal(
    sql.prepare("SELECT * FROM zrok_accounts WHERE id=?").get(client.id),
    undefined,
  );
  assert.equal(zrok.accounts.has(client.email), false);
  assert.equal(
    sql.prepare("SELECT state FROM zrok_shares WHERE id=?").get(privateId)
      .state,
    "active",
  );
});
test("provider disable retries failed account deletion, never drops its lifecycle blocker, and eventually removes all accounts", async () => {
  zrok.failDelete = true;
  assert.equal((await save({ enabled: false })).status, 200);
  assert(
    sql.prepare("SELECT 1 FROM zrok_accounts WHERE state='revoking'").get(),
  );
  assert.equal(
    (await admin.put("/api/admin/vms/101", { userId: bob.userId })).status,
    409,
  );
  zrok.failDelete = false;
  assert.equal(
    (await admin.post("/api/admin/private-access/zrok/reconcile")).status,
    200,
  );
  assert.equal(
    sql.prepare("SELECT count(*) AS n FROM zrok_accounts").get().n,
    0,
  );
  assert.equal(sql.prepare("SELECT count(*) AS n FROM zrok_shares").get().n, 0);
  assert.equal(zrok.accounts.size, 0);
});

test("a slow guest installation does not block provider disable or recreate a revoked account", async () => {
  assert.equal((await save({ enabled: true })).status, 200);
  const vm = stack.mock.vms.get(101);
  delete vm.zrokInput;
  let release;
  vm.zrokInstallGate = new Promise((resolve) => {
    release = resolve;
  });
  const installing = alice.post("/api/vms/101/sharing/agent");
  try {
    await waitFor(() => vm.zrokInput, { what: "guest enrollment stdin" });
    const disabled = await Promise.race([
      save({ enabled: false }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("provider disable blocked by guest setup")),
          3000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM zrok_accounts").get().n,
      0,
    );
  } finally {
    release();
    delete vm.zrokInstallGate;
    const result = await installing;
    assert.equal(result.status, 502, result.text);
  }
  assert.equal(
    sql.prepare("SELECT count(*) AS n FROM zrok_accounts").get().n,
    0,
  );
});
