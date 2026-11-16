import { test, expect } from "@playwright/test";
import { startStack } from "../support/stack.mjs";
import { startMockZrok } from "../support/mock-zrok.mjs";
let stack, zrok, admin, customer;
test.beforeAll(async () => {
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
  customer = await stack.customerWith("zrok-browser@example.com");
  await admin.put("/api/admin/vms/101", { userId: customer.userId });
  stack.mock.vms.get(101).status = "running";
});
test.afterAll(async () => {
  await stack?.stop();
  await zrok?.close();
});
async function signIn(page, session, url) {
  await page
    .context()
    .addCookies(
      [...session.cookies].map(([name, value]) => ({ name, value, url })),
    );
  await page.goto(url);
}
test("administrator configures the self-hosted provider with independent public enablement", async ({
  page,
}) => {
  await signIn(page, admin, stack.adminUrl);
  await page.locator("[data-admin-tab=vpn]").click();
  await page.getByRole("tab", { name: "zrok", exact: true }).click();
  await expect(
    page.getByLabel("Enable zrok sharing", { exact: true }),
  ).not.toBeChecked();
  await page
    .getByLabel("Self-hosted zrok HTTPS address", { exact: true })
    .fill(zrok.url);
  await page
    .getByLabel("Public HTTPS share origin", { exact: true })
    .fill("https://share.rcadea.cloud:9443");
  await page
    .getByLabel("zrok administrator token", { exact: true })
    .fill(zrok.adminToken);
  await page
    .getByRole("button", { name: "Save zrok configuration", exact: true })
    .click();
  await expect(
    page.getByLabel("zrok administrator token", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Test self-hosted controller", exact: true })
    .click();
  await expect(page.locator("[data-sharing-admin]")).toContainText(
    "Last successful check",
  );
  await page.getByLabel("Enable zrok sharing", { exact: true }).check();
  await page.getByLabel("Allow public HTTPS sharing", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save zrok configuration", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await admin.get("/api/admin/private-access")).json.zrok.settings
          .enabled,
    )
    .toBe(true);
  if (process.env.ZROK_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.ZROK_SCREENSHOTS}/zrok-admin.png`,
      fullPage: true,
    });
});
test("customer installs the agent, publishes a confirmed HTTPS link, connects privately and disables sharing", async ({
  page,
}) => {
  await signIn(page, customer, stack.customerUrl);
  await page.locator('.unit[data-vmid="101"]').click();
  await page.locator("[data-tab=remote]").click();
  await page.locator("[data-remote-provider=zrok]").click();
  await expect(
    page.getByRole("heading", { name: "Application sharing", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Install sharing agent", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Create share", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Share type", { exact: true }).selectOption("public");
  await page.getByLabel("Local application port", { exact: true }).fill("8080");
  await page.getByRole("button", { name: "Create share", exact: true }).click();
  await expect(page.locator("#confirm")).toBeVisible();
  await expect(page.locator("#confirm")).toContainText("public internet");
  await page.locator("#confirm-ok").click();
  const link = page.locator(".private-access-table a");
  await expect(link).toHaveAttribute(
    "href",
    /^https:\/\/p[a-f0-9]+\.share\.rcadea\.cloud:9443$/,
  );
  await page.getByLabel("Share type", { exact: true }).selectOption("private");
  await page.getByLabel("Local application port", { exact: true }).fill("5432");
  await page.getByRole("button", { name: "Create share", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect privately", exact: true })
    .click();
  await expect(page.locator("[data-share-credentials]")).toContainText(
    `export ZROK2_API_ENDPOINT=${zrok.url}`,
  );
  await expect(page.locator("[data-share-credentials]")).toContainText(
    "zrok2 access private",
  );
  const enableToken = await page
    .locator("[data-share-credentials] pre")
    .textContent();
  expect(
    await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    ),
  ).not.toContain(enableToken);
  await page
    .getByRole("button", { name: "Hide credentials", exact: true })
    .click();
  await expect(page.locator("[data-share-credentials]")).toBeEmpty();
  if (process.env.ZROK_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.ZROK_SCREENSHOTS}/zrok-customer.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (process.env.ZROK_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.ZROK_SCREENSHOTS}/zrok-customer-mobile.png`,
      fullPage: true,
    });
  await page
    .getByRole("button", { name: "Disable", exact: true })
    .first()
    .click();
  await page.locator("#confirm-ok").click();
  await expect(
    page.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
});
