import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';
import { startMockZiti } from '../support/mock-openziti.mjs';

let stack, mock, admin, customer;
test.beforeAll(async () => {
  mock = await startMockZiti();
  stack = await startStack({
    env: {
      OPENZITI_TEST_MODE: 'true',
      SETUP_CHECK_HOURS: '0',
      CUSTOMER_NETWORKS: 'false',
      VPN_ENABLED: 'false',
      TAILSCALE_ENABLED: 'false',
    },
  });
  admin = await stack.adminSession();
  customer = await stack.customerWith('private-access@example.com');
  await admin.put('/api/admin/vms/101', { userId: customer.userId });
});
test.afterAll(async () => {
  await stack?.stop();
  await mock?.close();
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
  await page.locator('[data-admin-tab=vpn]').click();
  await expect(
    page.getByRole('tablist', { name: 'Private access', exact: true }),
  ).toBeVisible();
}

test('all provider states are visible while disabled and configuration drafts survive section changes', async ({
  page,
}) => {
  await adminPage(page);
  for (const name of [
    'OpenZiti',
    'Headscale',
    'Tailscale',
    'WireGuard',
    'zrok',
  ]) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole('tabpanel')).toContainText(['Disabled']);
  await page.getByRole('tab', { name: 'OpenZiti', exact: true }).click();
  await page
    .getByLabel('Controller HTTPS address', { exact: true })
    .fill(mock.url);
  await page
    .getByLabel('Management username', { exact: true })
    .fill('panel-admin');
  await page
    .getByLabel('Management password', { exact: true })
    .fill(mock.secret);
  await page.getByRole('tab', { name: 'Headscale', exact: true }).click();
  await page
    .locator('[data-headscale-settings] select[name=provider]')
    .selectOption('headscale');
  await page
    .getByLabel('Headscale HTTPS URL', { exact: true })
    .fill('https://vpn.rcadea.cloud');
  await page.getByRole('tab', { name: 'OpenZiti', exact: true }).click();
  await expect(
    page.getByLabel('Controller HTTPS address', { exact: true }),
  ).toHaveValue(mock.url);
  await expect(
    page.getByLabel('Management password', { exact: true }),
  ).toHaveValue(mock.secret);
  await page
    .getByRole('button', { name: 'Save OpenZiti configuration', exact: true })
    .click();
  await expect(
    page.getByLabel('Management password', { exact: true }),
  ).toHaveValue('');
  await page
    .getByRole('button', { name: 'Test controller', exact: true })
    .click();
  await expect(page.locator('[data-ziti-status]')).toContainText(
    'Last successful check',
  );
  await page.getByLabel('Enable OpenZiti enrollment', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Save OpenZiti configuration', exact: true })
    .click();
  await expect(
    page.getByLabel('Enable OpenZiti enrollment', { exact: true }),
  ).toBeChecked();
  await expect
    .poll(
      async () =>
        (await admin.get('/api/admin/private-access')).json.openziti.settings
          .enabled,
    )
    .toBe(true);
  if (process.env.PRIVATE_ACCESS_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.PRIVATE_ACCESS_SCREENSHOTS}/pve-private-access-openziti.png`,
      fullPage: true,
    });
});

test('customers create a service and download separate host and personal enrollments without putting credentials in markup', async ({
  page,
}) => {
  await signIn(page, customer, stack.customerUrl);
  await page.locator('.unit[data-vmid="101"]').click();
  await page.locator('[data-tab=remote]').click();
  await page.locator('[data-remote-provider=openziti]').click();
  await expect(
    page.getByRole('heading', { name: 'OpenZiti service access', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Add or retry service', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Download VM enrollment', exact: true }),
  ).toBeEnabled();
  const hostDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download VM enrollment', exact: true })
    .click();
  expect((await hostDownload).suggestedFilename()).toMatch(/\.jwt$/);
  await expect(page.locator('[data-enrollment-result]')).toContainText(
    'ziti-edge-tunnel enroll',
  );
  const deviceDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Enroll my device', exact: true })
    .click();
  expect((await deviceDownload).suggestedFilename()).toMatch(/\.jwt$/);
  await expect(
    page.getByRole('button', { name: 'Renew access', exact: true }),
  ).toBeEnabled();
  expect(await page.content()).not.toContain('secret-enrollment-');
  expect(
    await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    ),
  ).not.toContain('secret-enrollment-');
  await page.getByRole('button', { name: 'Renew access', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Renew access', exact: true }),
  ).toBeEnabled();
  if (process.env.PRIVATE_ACCESS_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.PRIVATE_ACCESS_SCREENSHOTS}/pve-private-access-customer.png`,
      fullPage: true,
    });
});

test('disabling a provider reports pending revocation until remote removal succeeds', async ({
  page,
}) => {
  await adminPage(page);
  await page.getByRole('tab', { name: 'OpenZiti', exact: true }).click();
  mock.failDelete = true;
  await page
    .getByLabel('Enable OpenZiti enrollment', { exact: true })
    .uncheck();
  await page
    .getByRole('button', { name: 'Save OpenZiti configuration', exact: true })
    .click();
  await page.locator('#confirm-ok').click();
  await expect(
    page.getByLabel('Enable OpenZiti enrollment', { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('tabpanel').filter({ visible: true }),
  ).toContainText('Revocation pending');
  const table = page.getByRole('table', {
    name: 'OpenZiti services',
    exact: true,
  });
  await expect(table).toContainText('revoking');
  mock.failDelete = false;
  await page
    .getByRole('button', { name: 'Retry revocations', exact: true })
    .click();
  await expect(table).not.toContainText('revoking');
  await expect.poll(() => mock.objects.get('services').size).toBe(0);
});
