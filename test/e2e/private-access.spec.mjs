import { test, expect } from "@playwright/test";
import { startMockOidc } from "../support/mock-oidc.mjs";
import { startStack } from "../support/stack.mjs";
import { startMockZiti, mockSsoSettings } from "../support/mock-openziti.mjs";

let stack, mock, admin, customer, oidc;
test.beforeAll(async () => {
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
  customer = await stack.customerWith("private-access@example.com");
  await oidc.login(customer, { email: "private-access@example.com" });
  await admin.put("/api/admin/vms/101", { userId: customer.userId });
});
test.afterAll(async () => {
  await stack?.stop();
  await mock?.close();
  await oidc?.close();
});
async function signIn(page, session, url) {
  await page
    .context()
    .addCookies(
      [...session.cookies].map(([name, value]) => ({ name, value, url })),
    );
  await page.goto(url);
}
async function adminPage(page) {
  await signIn(page, admin, stack.adminUrl);
  await page.locator("[data-admin-tab=vpn]").click();
  await expect(
    page.getByRole("tablist", { name: "Private access", exact: true }),
  ).toBeVisible();
}

test("all provider states are visible while disabled and configuration drafts survive section changes", async ({
  page,
}) => {
  await adminPage(page);
  for (const name of [
    "OpenZiti",
    "Headscale",
    "Tailscale",
    "WireGuard",
    "zrok",
  ]) {
    await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole("tabpanel")).toContainText(["Disabled"]);
  await page.getByRole("tab", { name: "OpenZiti", exact: true }).click();
  await page
    .getByLabel("Controller HTTPS address", { exact: true })
    .fill(mock.url);
  await page
    .getByLabel("Management username", { exact: true })
    .fill("panel-admin");
  await page
    .getByLabel("Management password", { exact: true })
    .fill(mock.secret);
  for (const [name, value] of Object.entries(
    mockSsoSettings(mock, oidc.issuer),
  )) {
    const input = page.locator(`[name=${name}]`);
    if (typeof value === "string") await input.fill(value);
  }
  await page.getByRole("tab", { name: "Headscale", exact: true }).click();
  await page
    .locator("[data-headscale-settings] select[name=provider]")
    .selectOption("headscale");
  await page
    .getByLabel("Headscale HTTPS URL", { exact: true })
    .fill("https://vpn.rcadea.cloud");
  await page.getByRole("tab", { name: "OpenZiti", exact: true }).click();
  await expect(
    page.getByLabel("Controller HTTPS address", { exact: true }),
  ).toHaveValue(mock.url);
  await expect(
    page.getByLabel("Management password", { exact: true }),
  ).toHaveValue(mock.secret);
  await page
    .getByRole("button", { name: "Save OpenZiti configuration", exact: true })
    .click();
  await expect(
    page.getByLabel("Management password", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Test controller", exact: true })
    .click();
  await expect(page.locator("[data-ziti-status]")).toContainText(
    "Last successful check",
  );
  await page.getByLabel("Enable OpenZiti enrollment", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save OpenZiti configuration", exact: true })
    .click();
  await expect(
    page.getByLabel("Enable OpenZiti enrollment", { exact: true }),
  ).toBeChecked();
  await expect
    .poll(
      async () =>
        (await admin.get("/api/admin/private-access")).json.openziti.settings
          .enabled,
    )
    .toBe(true);
  if (process.env.PRIVATE_ACCESS_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.PRIVATE_ACCESS_SCREENSHOTS}/pve-private-access-openziti.png`,
      fullPage: true,
    });
});

test("customers use machine enrollment and SSO user access without a personal certificate download", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, customer, stack.customerUrl);
  await page.locator('.unit[data-vmid="101"]').click();
  await page.locator("[data-tab=remote]").click();
  await page.locator("[data-remote-provider=openziti]").click();
  await expect(
    page.getByRole("heading", { name: "OpenZiti service access", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add or retry service", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download VM enrollment", exact: true }),
  ).toBeEnabled();
  const hostDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download VM enrollment", exact: true })
    .click();
  expect((await hostDownload).suggestedFilename()).toMatch(/\.jwt$/);
  await expect(page.locator("[data-enrollment-result]")).toContainText(
    "ziti-edge-tunnel enroll",
  );
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page
    .getByRole("button", { name: "Enable my SSO access", exact: true })
    .click();
  expect(downloads).toHaveLength(0);
  await expect(
    page.getByRole("heading", { name: "Connect with SSO" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Renew access", exact: true }),
  ).toBeEnabled();
  const form = page.locator("[data-add-service]");
  await expect(page.locator("[data-remote-body]")).not.toContainText(
    "Authentik",
  );
  const instructions = page.locator("[data-remote-body] > .security-card");
  const formBox = await form.boundingBox();
  const cardBox = await instructions.boundingBox();
  expect(cardBox.y - formBox.y - formBox.height).toBeGreaterThanOrEqual(16);
  expect(cardBox.y - formBox.y - formBox.height).toBeLessThanOrEqual(32);
  const selectBox = await form.locator("select").boundingBox();
  const buttonBox = await form.getByRole("button").boundingBox();
  expect(
    Math.abs(selectBox.y + selectBox.height - buttonBox.y - buttonBox.height),
  ).toBeLessThanOrEqual(1);
  const headingBox = await instructions.getByRole("heading").boundingBox();
  const descriptionBox = await instructions.locator("p").first().boundingBox();
  expect(
    descriptionBox.y - headingBox.y - headingBox.height,
  ).toBeGreaterThanOrEqual(16);
  expect(
    descriptionBox.y - headingBox.y - headingBox.height,
  ).toBeLessThanOrEqual(24);
  if (process.env.LAYOUT_SCREENSHOTS) {
    await expect(page.locator(".toast")).toHaveCount(0);
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/customer-openziti-spacing.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const command = instructions.locator("pre");
  expect(
    await command.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  if (process.env.LAYOUT_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/customer-openziti-mobile-spacing.png`,
      fullPage: true,
    });
  expect(await page.content()).not.toContain("secret-enrollment-");
  expect(
    await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    ),
  ).not.toContain("secret-enrollment-");
  await page.getByRole("button", { name: "Renew access", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Renew access", exact: true }),
  ).toBeEnabled();
  if (process.env.PRIVATE_ACCESS_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.PRIVATE_ACCESS_SCREENSHOTS}/pve-private-access-customer.png`,
      fullPage: true,
    });
});

test("disabling a provider reports pending revocation until remote removal succeeds", async ({
  page,
}) => {
  await adminPage(page);
  await page.getByRole("tab", { name: "OpenZiti", exact: true }).click();
  mock.failDelete = true;
  await page
    .getByLabel("Enable OpenZiti enrollment", { exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Save OpenZiti configuration", exact: true })
    .click();
  await page.locator("#confirm-ok").click();
  await expect(
    page.getByLabel("Enable OpenZiti enrollment", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("tabpanel").filter({ visible: true }),
  ).toContainText("Revocation pending");
  const table = page.getByRole("table", {
    name: "OpenZiti services",
    exact: true,
  });
  await expect(table).toContainText("revoking");
  mock.failDelete = false;
  await page
    .getByRole("button", { name: "Retry revocations", exact: true })
    .click();
  await expect(table).not.toContainText("revoking");
  await expect.poll(() => mock.objects.get("services").size).toBe(0);
});
