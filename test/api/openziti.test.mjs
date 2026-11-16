import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { startMockOidc } from "../support/mock-oidc.mjs";
let oidc;
import { startStack, waitFor } from "../support/stack.mjs";
import { startMockZiti, mockSsoSettings } from "../support/mock-openziti.mjs";
let stack,
  mock,
  admin,
  alice,
  bob,
  aliceId,
  customerId,
  serviceId,
  grantId,
  sql;
const settings = async () =>
  (await admin.get("/api/admin/private-access")).json.openziti.settings;
const save = async (changes) => {
  const s = await settings();
  return admin.put("/api/admin/private-access/openziti", {
    revision: s.revision,
    enabled: s.enabled,
    controller: s.controller,
    username: s.username,
    routerRole: s.routerRole,
    caPem: s.caPem,
    ...mockSsoSettings(mock, oidc.issuer),
    ...changes,
  });
};
before(async () => {
  mock = await startMockZiti();
  oidc = await startMockOidc();
  stack = await startStack({
    env: {
      OPENZITI_TEST_MODE: "true",
      OIDC_ENABLED: "true",
      OIDC_ISSUER: oidc.issuer,
      OIDC_CLIENT_ID: "panel-test",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_ALLOW_INSECURE_HTTP: "true",
      SETUP_CHECK_HOURS: "0",
      CUSTOMER_NETWORKS: "false",
      VPN_ENABLED: "false",
      TAILSCALE_ENABLED: "false",
    },
  });
  admin = await stack.adminSession();
  alice = await stack.customerWith("ziti-alice@example.com");
  bob = await stack.customerWith("ziti-bob@example.com");
  const a = (await alice.get("/api/account")).json;
  customerId = a.customer.id;
  aliceId = alice.userId;
  assert.equal(
    (await oidc.login(alice, { email: "ziti-alice@example.com" })).status,
    200,
  );
  await admin.put("/api/admin/vms/101", { userId: alice.userId });
  sql = new DatabaseSync(path.join(stack.dir, "panel.db"));
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await mock?.close();
  await oidc?.close();
});

test("every provider is visible when all enrollment features are disabled; admin APIs require admin", async () => {
  const r = await admin.get("/api/admin/private-access");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    r.json.providers.map((p) => p.id),
    ["openziti", "headscale", "tailscale", "wireguard", "zrok"],
  );
  assert(r.json.providers.every((p) => !p.enabled));
  assert.equal(r.json.providers.find((p) => p.id === "zrok").supported, true);
  assert.equal((await alice.get("/api/admin/private-access")).status, 404);
  assert.equal(
    (await stack.admin().get("/api/admin/private-access")).status,
    401,
  );
  assert.equal(
    (await alice.post("/api/vms/101/private-access/services", { kind: "ssh" }))
      .status,
    409,
  );
});
test("credentials are encrypted, settings use revisions, validation rejects unsafe URLs, and enabling requires a successful check", async () => {
  assert.equal((await save({ controller: "http://example.com" })).status, 400);
  assert.equal(
    (await save({ controller: "https://user:secret@example.com" })).status,
    400,
  );
  assert.equal(
    (
      await save({
        controller: mock.url,
        username: "panel-admin",
        password: mock.secret,
      })
    ).status,
    200,
  );
  assert.equal((await save({ enabled: true })).status, 400);
  const check = await admin.post("/api/admin/private-access/openziti/check");
  assert.equal(check.status, 200, check.text);
  assert.equal(check.json.onlineRouters, 1);
  assert.equal((await save({ enabled: true })).status, 200);
  const s = await settings();
  assert.equal(s.credentialConfigured, true);
  assert.equal(JSON.stringify(s).includes(mock.secret), false);
  assert.equal(
    JSON.stringify(
      sql.prepare("SELECT * FROM openziti_settings").all(),
    ).includes(mock.secret),
    false,
  );
  assert.equal(
    (
      await admin.put("/api/admin/private-access/openziti", {
        revision: s.revision - 1,
      })
    ).status,
    409,
  );
});
test("services use only the exact VM and customer service, loopback host, router role and identity selectors", async () => {
  const r = await alice.post("/api/vms/101/private-access/services", {
    kind: "ssh",
  });
  assert.equal(r.status, 200, r.text);
  serviceId = r.json.id;
  assert.equal(r.json.customer_id, customerId);
  assert.equal((await bob.get("/api/vms/101/private-access")).status, 404);
  const host = [...mock.objects.get("configs").values()].find(
    (c) => c.configTypeId === "host-type",
  );
  assert.deepEqual(host.data, {
    protocol: "tcp",
    address: "127.0.0.1",
    port: 22,
  });
  assert.equal(mock.objects.get("services").size, 1);
  const policies = [...mock.objects.get("service-policies").values()];
  assert.equal(policies.length, 1);
  assert.equal(policies[0].type, "Bind");
  for (const type of ["edge-router-policies", "service-edge-router-policies"])
    for (const p of mock.objects.get(type).values())
      assert.deepEqual(p.edgeRouterRoles, ["#rcadea-customers"]);
  assert.equal(
    (await alice.post("/api/vms/101/private-access/services", { kind: "ssh" }))
      .json.id,
    serviceId,
    "retry uses the same objects",
  );
  assert.equal(mock.objects.get("services").size, 1);
  assert.equal(
    (await admin.put("/api/admin/vms/101", { userId: bob.userId })).status,
    409,
  );
});
test("machine enrollment stays secret; user access requires SSO and stays persistent", async () => {
  assert.equal(
    (
      await bob.post(
        `/api/private-access/services/${serviceId}/host-enrollment`,
      )
    ).status,
    404,
  );
  const host = await alice.post(
    `/api/private-access/services/${serviceId}/host-enrollment`,
  );
  assert.equal(host.status, 200, host.text);
  assert.match(host.json.jwt, /secret-enrollment/);
  assert.match(host.headers.get("cache-control"), /no-store/);
  const result = await alice.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(result.status, 200, result.text);
  grantId = result.json.id;
  assert.equal(result.json.accessExpiresAt, null);
  assert.equal(result.json.persistent, true);
  assert.equal(
    (await bob.post(`/api/private-access/grants/${grantId}/renew`)).status,
    404,
  );
  const renew = await alice.post(`/api/private-access/grants/${grantId}/renew`);
  assert.equal(renew.status, 200, renew.text);
  const serialized =
    JSON.stringify(sql.prepare("SELECT * FROM openziti_objects").all()) +
    JSON.stringify(sql.prepare("SELECT * FROM audit_log").all());
  assert.equal(result.json.jwt, undefined);
  assert.equal(result.json.mode, "sso");
  assert(!serialized.includes(host.json.jwt));
  assert(!stack.logs().includes(host.json.jwt));
  const userIdentity = [...mock.objects.get("identities").values()].find(
    (i) => i.type === "User",
  );
  assert.equal(userIdentity.authPolicyId, "sso-users");
  assert.equal(userIdentity.externalId, "ziti-alice@example.com");
  assert.equal(userIdentity.enrollment, undefined);
  sql
    .prepare("UPDATE openziti_grants SET persistent=0,expires_at=1 WHERE id=?")
    .run(grantId);
  assert.equal(
    (await alice.post(`/api/private-access/grants/${grantId}/renew`)).status,
    409,
  );
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/reconcile")).status,
    200,
  );
  assert.equal(
    sql.prepare("SELECT 1 FROM openziti_grants WHERE id=?").get(grantId),
    undefined,
  );
  assert.equal(
    mock.objects.get("identities").size,
    1,
    "hosting identity remains, expired SSO identity is gone",
  );
});
test("membership removal revokes access; controller outages preserve revocations and retry safely", async () => {
  const issued = await alice.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(issued.status, 200, issued.text);
  grantId = issued.json.id;
  mock.failDelete = true;
  sql
    .prepare(
      "INSERT OR IGNORE INTO customer_membership_blocks(customer_id,user_id) VALUES(?,?)",
    )
    .run(customerId, aliceId);
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/reconcile")).status,
    200,
  );
  const row = sql
    .prepare("SELECT * FROM openziti_grants WHERE id=?")
    .get(grantId);
  assert.equal(row.state, "revoking");
  assert.match(row.error, /HTTP 503/);
  assert(!row.error.includes(mock.secret));
  mock.failDelete = false;
  await admin.post("/api/admin/private-access/openziti/reconcile");
  assert.equal(
    sql.prepare("SELECT * FROM openziti_grants WHERE id=?").get(grantId),
    undefined,
  );
  sql
    .prepare(
      "DELETE FROM customer_membership_blocks WHERE customer_id=? AND user_id=?",
    )
    .run(customerId, aliceId);
});
test("local sessions cannot enroll a user certificate or enable SSO grants", async () => {
  const local = stack.customer();
  assert.equal(
    (
      await local.post("/api/auth/login", {
        email: "ziti-alice@example.com",
        password: "another-long-password",
      })
    ).status,
    200,
  );
  const result = await local.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  assert.equal(result.status, 403, result.text);
  assert.match(result.json.error, /SSO/);
});
test("one immutable SSO identity can hold two independent service grants", async () => {
  const rdp = await alice.post("/api/vms/101/private-access/services", {
    kind: "rdp",
  });
  assert.equal(rdp.status, 200, rdp.text);
  const first = await alice.post(
    `/api/private-access/services/${serviceId}/access`,
  );
  const second = await alice.post(
    `/api/private-access/services/${rdp.json.id}/access`,
  );
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(
    [...mock.objects.get("identities").values()].filter(
      (i) => i.type === "User",
    ).length,
    1,
  );
  assert.equal(first.json.jwt, undefined);
  assert.equal(second.json.jwt, undefined);
  assert.equal(
    (await alice.del(`/api/private-access/grants/${first.json.id}`)).status,
    200,
  );
  assert.equal(
    [...mock.objects.get("identities").values()].filter(
      (i) => i.type === "User",
    ).length,
    1,
  );
  assert.equal(
    (await alice.post(`/api/private-access/grants/${second.json.id}/renew`))
      .status,
    200,
  );
  await alice.del(`/api/private-access/services/${rdp.json.id}`);
  assert.equal(
    [...mock.objects.get("identities").values()].filter(
      (i) => i.type === "User",
    ).length,
    0,
  );
});
test("controller checks reject certificate fallback and directory auto-enrollment", async () => {
  const policy = mock.objects.get("auth-policies").get("sso-users");
  policy.primary.cert.allowed = true;
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    409,
  );
  policy.primary.cert.allowed = false;
  const signer = mock.objects
    .get("external-jwt-signers")
    .get("authentik-signer");
  signer.enrollToTokenEnabled = true;
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    409,
  );
  signer.enrollToTokenEnabled = false;
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    200,
  );
});
test("ownership mismatches stop cleanup and disabling retains durable failures until controller removal succeeds", async () => {
  mock.invalidOwner = true;
  const refused = await admin.del(
    `/api/admin/private-access/openziti/services/${serviceId}`,
  );
  assert.equal(refused.status, 409, refused.text);
  assert.equal(mock.objects.get("services").size, 1);
  mock.invalidOwner = false;
  mock.failDelete = true;
  const disabled = await save({ enabled: false });
  assert.equal(disabled.status, 200, disabled.text);
  assert.equal((await settings()).enabled, false);
  assert.equal(
    sql.prepare("SELECT state FROM openziti_services WHERE id=?").get(serviceId)
      .state,
    "revoking",
  );
  assert.equal(
    (await save({ controller: "https://different.example.com" })).status,
    409,
  );
  mock.failDelete = false;
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/reconcile")).status,
    200,
  );
  assert.equal(
    sql.prepare("SELECT count(*) n FROM openziti_objects").get().n,
    0,
  );
  assert.equal(mock.objects.get("services").size, 0);
});
test("controller redirects are rejected and request details never expose the management password", async () => {
  mock.redirect = true;
  const r = await admin.post("/api/admin/private-access/openziti/check");
  assert.equal(r.status, 502, r.text);
  assert(!r.text.includes(mock.secret));
  mock.redirect = false;
});

test("controller checks inspect every policy page and require a recent successful check", async () => {
  const policies = mock.objects.get("service-policies");
  for (let i = 0; i < 101; i++)
    policies.set(`existing-${i}`, {
      id: `existing-${i}`,
      name: `existing-${i}`,
      identityRoles: ["@unrelated-identity"],
    });
  policies.set("broad", {
    id: "broad",
    name: "broad",
    identityRoles: ["#all"],
  });
  const refused = await admin.post("/api/admin/private-access/openziti/check");
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json.error, /all identities/);
  policies.clear();
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    200,
  );
  sql
    .prepare("UPDATE openziti_settings SET verified_at='2020-01-01T00:00:00Z'")
    .run();
  assert.equal((await save({ enabled: true })).status, 400);
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    200,
  );
  assert.equal((await save({ enabled: true })).status, 200);
});

test("a lost controller creation response survives panel restart and retry finds the exact owned object", async () => {
  mock.dropCreateType = "configs";
  const lost = await alice.post("/api/vms/101/private-access/services", {
    kind: "ssh",
  });
  assert.equal(lost.status, 502, lost.text);
  assert.equal(mock.objects.get("configs").size, 1);
  assert.equal(
    sql
      .prepare(
        "SELECT count(*) n FROM openziti_objects WHERE remote_id IS NULL",
      )
      .get().n,
    1,
  );
  await stack.restartPanel();
  const retry = await alice.post("/api/vms/101/private-access/services", {
    kind: "ssh",
  });
  assert.equal(retry.status, 200, retry.text);
  serviceId = retry.json.id;
  assert.equal(
    mock.objects.get("configs").size,
    2,
    "one host config and one intercept config",
  );
  assert.equal(mock.objects.get("identities").size, 1);
  assert.equal(
    sql
      .prepare(
        "SELECT count(*) n FROM openziti_objects WHERE remote_id IS NULL",
      )
      .get().n,
    0,
  );
  assert(
    mock.calls.some(
      (c) => c.path === "/current-api-session" && c.method === "DELETE",
    ),
  );
  await alice.del(`/api/private-access/services/${serviceId}`);
});

test("in-flight service creation blocks customer transfers and VM deletion", async () => {
  let release;
  mock.pauseCreate = new Promise((resolve) => {
    release = resolve;
  });
  const before = mock.calls.filter(
    (c) => c.method === "POST" && c.path === "/configs",
  ).length;
  const pending = alice.post("/api/vms/101/private-access/services", {
    kind: "rdp",
  });
  try {
    await waitFor(
      () =>
        mock.calls.filter((c) => c.method === "POST" && c.path === "/configs")
          .length > before,
    );
    assert.equal(
      (await admin.put("/api/admin/vms/101", { userId: bob.userId })).status,
      409,
    );
    assert.equal(
      (await alice.req("DELETE", "/api/vms/101", { confirmVmid: 101 })).status,
      409,
    );
  } finally {
    release();
    mock.pauseCreate = null;
  }
  const created = await pending;
  assert.equal(created.status, 200, created.text);
  await alice.del(`/api/private-access/services/${created.json.id}`);
});
