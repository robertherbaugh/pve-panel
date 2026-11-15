import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';
let stack, admin, alice, bob;
const cookies = (s) => [...s.cookies].map(([name, value]) => ({ name, value, url: s.base }));
test.beforeAll(async () => {
  stack = await startStack({
    env: {
      CUSTOMER_NETWORKS: 'false',
      VPN_ENABLED: 'false',
      SETUP_CHECK_HOURS: '0',
      SIGNIN_RATE_LIMIT: '100',
    },
  });
  admin = await stack.adminSession();
  for (const [id, pool] of [
    [101, 'tacid-dev'],
    [102, 'tacid-prod'],
  ]) {
    stack.mock.vms.get(id).pool = pool;
    stack.mock.perms[`/pool/${pool}`] = ['Pool.Audit'];
  }
  alice = (
    await admin.post('/api/admin/users', {
      email: 'alice@rcadea.cloud',
      password: 'customer-browser-password',
      createPersonalCustomer: false,
    })
  ).json;
  bob = (
    await admin.post('/api/admin/users', {
      email: 'bob@rcadea.cloud',
      password: 'customer-browser-password',
      createPersonalCustomer: false,
    })
  ).json;
});
test.afterAll(async () => await stack?.stop());

test('customer editor, memberships and VM assignment support shared customers and explicit switching', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await context.addCookies(cookies(admin));
  await page.goto(stack.adminUrl);
  await page.getByRole('tab', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'Add customer', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Add customer', exact: true });
  await d.getByLabel('Customer name', { exact: true }).fill('TacticalID Development');
  await d.getByLabel('Customer ID', { exact: true }).fill('tacticalid-dev');
  await expect(d.getByLabel('Email domains (optional)', { exact: true })).toHaveAttribute(
    'placeholder',
    'rcadea.cloud',
  );
  await expect(d.getByLabel('Email domains (optional)', { exact: true })).toBeEmpty();
  await d.getByLabel('OIDC groups', { exact: true }).fill('pve_dev');
  await d.getByLabel('Application entitlements', { exact: true }).fill('customer:development');
  await d.getByLabel('Require a current SSO authorization for every member', { exact: true }).uncheck();
  await d.getByRole('button', { name: 'Customer resource pools', exact: true }).click();
  await d.locator('[data-pools] input[value=tacid-dev]').check();
  await d.getByRole('button', { name: 'Customer resource pools', exact: true }).click();
  await d.getByLabel('Servers', { exact: true }).fill('10');
  if (process.env.CUSTOMER_EDITOR_SCREENSHOT)
    await d.screenshot({ path: process.env.CUSTOMER_EDITOR_SCREENSHOT });
  await d.getByRole('button', { name: 'Save customer', exact: true }).click();
  await expect(d).toHaveCount(0);
  const dev = (await admin.get('/api/admin/customers')).json.customers.find(
    (c) => c.slug === 'tacticalid-dev',
  );
  expect(dev.pools).toEqual(['tacid-dev']);
  expect(dev.allowedDomains).toEqual([]);
  const row = page.locator(`[data-customer="${dev.id}"]`);
  await row.getByRole('button', { name: 'Members', exact: true }).click();
  const m = page.getByRole('dialog', { name: `Members of ${dev.name}`, exact: true });
  for (const [user, role] of [
    [alice, 'admin'],
    [bob, 'operator'],
  ]) {
    await m.getByLabel('Existing user', { exact: true }).selectOption(String(user.id));
    await m.getByLabel('Customer role', { exact: true }).selectOption(role);
    await m.getByRole('button', { name: 'Add or update member', exact: true }).click();
    await expect(m.getByRole('row', { name: new RegExp(user.email) })).toBeVisible();
  }
  await m.getByRole('button', { name: 'Close', exact: true }).click();
  if (process.env.CUSTOMERS_SCREENSHOT)
    await page.screenshot({ path: process.env.CUSTOMERS_SCREENSHOT, fullPage: true });
  await page.getByRole('tab', { name: 'Servers', exact: true }).click();
  await page.locator('tr[data-vmid="101"] [data-owner]').selectOption(String(dev.id));
  await expect
    .poll(async () => (await admin.get('/api/admin/vms')).json.find((v) => v.vmid === 101).customerId)
    .toBe(dev.id);
  const p = (
    await admin.post('/api/admin/customers', {
      name: 'TacticalID Production',
      slug: 'tacticalid-prod',
      enabled: true,
      pools: ['tacid-prod'],
      sso: { required: false },
      limits: {},
    })
  ).json;
  await admin.put(`/api/admin/customers/${p.id}/members`, { userId: alice.id, role: 'viewer' });
  await admin.put('/api/admin/vms/102', { customerId: p.id });
  const customer = stack.customer();
  await customer.post('/api/auth/login', { email: alice.email, password: 'customer-browser-password' });
  await customer.post('/api/customers/select', { customerId: dev.id });
  await context.addCookies(cookies(customer));
  await page.goto(stack.customerUrl);
  await expect(page.locator('#customer-context')).toHaveValue(String(dev.id));
  await expect(page.locator('.unit[data-vmid="101"]')).toBeVisible();
  await expect(page.locator('.unit[data-vmid="102"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Customer members', exact: true })).toBeVisible();
  await page.locator('#customer-context').selectOption(String(p.id));
  await expect(page.locator('#customer-context')).toHaveValue(String(p.id));
  await expect(page.locator('.unit[data-vmid="102"]')).toBeVisible();
  await expect(page.locator('.unit[data-vmid="101"]')).toHaveCount(0);
  expect(await page.evaluate(async () => (await fetch('/api/vms/101')).status)).toBe(404);
  await expect(page.getByRole('button', { name: 'Customer members', exact: true })).toHaveCount(0);
  await page.goto(stack.adminUrl);
  await page.getByRole('tab', { name: 'Users', exact: true }).click();
  const user = page.locator(`[data-user="${bob.id}"]`);
  await user.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.locator('#confirm-ok').click();
  await expect(user).toContainText('Disabled');
  expect(
    (
      await stack
        .customer()
        .post('/api/auth/login', { email: bob.email, password: 'customer-browser-password' })
    ).status,
  ).toBe(401);
  expect((await customer.get('/api/vms/101')).status).toBe(200);
});
