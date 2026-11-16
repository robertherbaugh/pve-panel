import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { startStack } from "../support/stack.mjs";
import { startMockZiti, mockSsoSettings } from "../support/mock-openziti.mjs";
let stack, ziti, admin, user, sql;
before(async () => {
  ziti = await startMockZiti();
  stack = await startStack({
    env: {
      OPENZITI_TEST_MODE: "true",
      SETUP_CHECK_HOURS: "0",
      CUSTOMER_NETWORKS: "false",
      VPN_ENABLED: "false",
      TAILSCALE_ENABLED: "false",
    },
  });
  admin = await stack.adminSession();
  user = await stack.customerWith("machine-owner@example.com", {
    limits: { maxServers: 5 },
  });
  sql = new DatabaseSync(`${stack.dir}/panel.db`);
  await stack.offerTemplates();
  const settings = (await admin.get("/api/admin/private-access")).json.openziti
    .settings;
  const body = {
    revision: settings.revision,
    enabled: false,
    controller: ziti.url,
    username: "panel-admin",
    password: ziti.secret,
    routerRole: "rcadea-customers",
    caPem: "",
    ...mockSsoSettings(
      ziti,
      "https://auth.rcadea.cloud/application/o/pve-panel/",
    ),
    autoProvision: true,
  };
  assert.equal(
    (await admin.put("/api/admin/private-access/openziti", body)).status,
    200,
  );
  assert.equal(
    (await admin.post("/api/admin/private-access/openziti/check")).status,
    200,
  );
  delete body.password;
  body.revision++;
  body.enabled = true;
  assert.equal(
    (await admin.put("/api/admin/private-access/openziti", body)).status,
    200,
  );
});
after(async () => {
  sql?.close();
  await stack?.stop();
  await ziti?.close();
});
const spec = {
  hostname: "ziti-linux",
  templateId: 9000,
  cores: 2,
  memoryMb: 2048,
  diskGb: 20,
  username: "owner",
  password: "a-long-test-password",
};

test("automatic certificate enrollment requires an enabled guest agent before cloning", async () => {
  stack.mock.vms.get(9000).cfg.agent = "0";
  const r = await user.post("/api/vms", spec);
  assert.equal(r.status, 400, r.text);
  assert.match(r.json.error, /guest agent/);
  stack.mock.vms.get(9000).cfg.agent = "1";
});
test("new Linux provisioning enrolls a machine certificate through QGA stdin and leaves user SSO grants empty", async () => {
  const r = await user.post("/api/vms", spec);
  assert.equal(r.status, 202, r.text);
  const vmid = r.json.vmid;
  const vm = await stack.serverSettled(user, vmid);
  assert.equal(vm.state, "ready", vm.error);
  const remote = stack.mock.vms.get(vmid);
  assert.equal(remote.zitiInstallCount, 1);
  const secret = remote.zitiEnrollmentInput;
  assert.match(secret, /secret-enrollment-/);
  assert.equal(
    JSON.stringify(remote.cfg).includes(secret),
    false,
    "No token in cloud-init or guest configuration",
  );
  const overview = await user.get(`/api/vms/${vmid}/private-access`);
  assert.equal(overview.status, 200, overview.text);
  assert.equal(overview.json.services[0].host_state, "enrolled");
  assert.deepEqual(overview.json.services[0].grants, []);
  const identity = [...ziti.objects.get("identities").values()][0];
  assert.equal(identity.authPolicyId, "cert-machines");
  assert.equal(identity.type, "Device");
  assert.equal(
    JSON.stringify(sql.prepare("SELECT * FROM audit_log").all()).includes(
      secret,
    ),
    false,
  );
  assert.equal(stack.logs().includes(secret), false);
  assert.equal(
    JSON.stringify(sql.prepare("SELECT * FROM vms").all()).includes(secret),
    false,
  );
  await user.del(
    `/api/private-access/services/${overview.json.services[0].id}`,
  );
});
test("guest failures redact enrollment input and a retry can finish without issuing a user certificate", async () => {
  await admin.put("/api/admin/vms/102", { userId: user.userId });
  const vm = stack.mock.vms.get(102);
  vm.status = "running";
  vm.zitiFailInstall = true;
  const made = await user.post("/api/vms/102/private-access/services", {
    kind: "ssh",
  });
  assert.equal(made.status, 200, made.text);
  const path = `/api/private-access/services/${made.json.id}/host-installation`;
  const failed = await user.post(path);
  assert.equal(failed.status, 502, failed.text);
  assert(!failed.text.includes("secret-enrollment-"));
  assert(
    !JSON.stringify(
      sql.prepare("SELECT * FROM openziti_services").all(),
    ).includes("secret-enrollment-"),
  );
  vm.zitiFailInstall = false;
  const retry = await user.post(path);
  assert.equal(retry.status, 200, retry.text);
  const count = vm.zitiInstallCount;
  assert.equal((await user.post(path)).status, 200);
  assert.equal(
    vm.zitiInstallCount,
    count,
    "An installed identity is reused without another one-time enrollment",
  );
  await user.del(`/api/private-access/services/${made.json.id}`);
});

test("a lost guest enrollment result is checked without consuming its one-time token again", async () => {
  await admin.put("/api/admin/vms/101", { userId: user.userId });
  const vm = stack.mock.vms.get(101);
  vm.status = "running";
  const made = await user.post("/api/vms/101/private-access/services", {
    kind: "ssh",
  });
  assert.equal(made.status, 200, made.text);
  await stack.mock.control(
    "/__lose/101/1/" + encodeURIComponent("scratch=$(mktemp"),
  );
  const result = await user.post(
    `/api/private-access/services/${made.json.id}/host-installation`,
  );
  assert.equal(result.status, 200, result.text);
  assert.equal(vm.zitiInstallCount, 1);
  await user.del(`/api/private-access/services/${made.json.id}`);
});
