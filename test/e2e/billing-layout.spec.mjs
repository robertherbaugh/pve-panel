import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';

let stack, user, admin;
test.beforeAll(async () => {
  stack = await startStack({
    env: {
      SETUP_CHECK_HOURS: '0',
      CUSTOMER_NETWORKS: 'false',
      VPN_ENABLED: 'false',
    },
  });
  admin = await stack.adminSession();
  user = await stack.customerWith('billing-layout@example.com');
  await admin.put('/api/admin/vms/101', { userId: user.userId });
});
test.afterAll(async () => {
  await stack?.stop();
});
async function signIn(page, session, url) {
  await page
    .context()
    .addCookies(
      [...session.cookies].map(([name, value]) => ({ name, value, url })),
    );
  await page.goto(url);
}
async function separated(first, second) {
  const a = await first.boundingBox(),
    b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(b.y - (a.y + a.height)).toBeGreaterThanOrEqual(16);
  expect(b.y - (a.y + a.height)).toBeLessThanOrEqual(32);
}
async function fitsScreen(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test('customer billing tabs preserve drafts, keyboard selection and the active section during asynchronous updates', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, user, stack.customerUrl);
  await page.getByRole('button', { name: 'Billing', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Billing', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  const email = page.getByLabel('Billing email', { exact: true });
  await email.fill('unsaved@example.com');
  await tabs.getByRole('tab', { name: 'Cost summary', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Cost summary', exact: true }),
  ).toBeVisible();
  await expect(email).toBeHidden();
  await tabs.getByRole('tab', { name: 'Draft invoices', exact: true }).click();
  await expect(
    page.getByText('No draft invoices.', { exact: true }),
  ).toBeVisible();
  await page.route('**/api/billing/invoices', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ json: { items: [], hasMore: false } });
  });
  await tabs.getByRole('tab', { name: 'Stripe invoices', exact: true }).click();
  const pending = page.waitForRequest('**/api/billing/invoices');
  await page
    .getByRole('button', { name: 'Load invoices', exact: true })
    .click();
  await pending;
  await tabs.getByRole('tab', { name: 'Subscription', exact: true }).click();
  await expect(page.locator('[data-invoices]')).toHaveText('Load invoices');
  await expect(
    page.getByRole('tab', { name: 'Subscription', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Billing email', { exact: true })).toHaveValue(
    'unsaved@example.com',
  );
  await page
    .getByRole('button', { name: 'Save billing email', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save billing email', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Billing email', { exact: true })).toHaveValue(
    'unsaved@example.com',
  );
  await page.getByRole('tab', { name: 'Subscription', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(
    page.getByRole('tab', { name: 'Stripe invoices', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Subscription', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Cost summary', exact: true }),
  ).toBeFocused();
  const panel = page.getByRole('tabpanel');
  await expect(panel).toHaveAttribute(
    'aria-labelledby',
    await page
      .getByRole('tab', { name: 'Cost summary', exact: true })
      .getAttribute('id'),
  );
  if (process.env.LAYOUT_SCREENSHOTS) {
    await expect(page.locator('.toast')).toHaveCount(0);
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/customer-billing-desktop.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await fitsScreen(page);
  await page.getByRole('tab', { name: 'Subscription', exact: true }).click();
  await fitsScreen(page);
  if (process.env.LAYOUT_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/customer-billing-mobile.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('tab', { name: 'Stripe invoices', exact: true }).click();
  const completed = page.waitForResponse('**/api/billing/invoices');
  await page
    .getByRole('button', { name: 'Load invoices', exact: true })
    .click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await completed;
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Billing', exact: true }),
  ).toHaveCount(0);
});

test('customer and administrator sections have visible gaps and cards keep their content in vertical order', async ({
  page,
}) => {
  await signIn(page, user, stack.customerUrl);
  await page.locator('#nav-account').click();
  await expect(page.locator('#security > .security-card')).toBeVisible();
  await expect(page.locator('#passkeys > .security-card')).toBeVisible();
  await separated(page.locator('#security'), page.locator('#passkeys'));
  await separated(page.locator('#passkeys'), page.locator('#ssh-keys'));
  if (process.env.LAYOUT_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/customer-account-spacing.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await fitsScreen(page);
  await separated(page.locator('#security'), page.locator('#passkeys'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, admin, stack.adminUrl);
  await page.locator('[data-admin-tab=vpn]').click();
  await page.getByRole('tab', { name: 'OpenZiti', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(
    panel.getByRole('heading', { name: 'OpenZiti', exact: true, level: 2 }),
  ).toBeVisible();
  await separated(
    panel.locator('article.security-card'),
    panel.locator('form').first(),
  );
  await page.locator('[data-admin-tab=settings]').click();
  await page.getByRole('tab', { name: 'Email', exact: true }).click();
  const card = page
    .locator('[data-settings-panel=email] > .security-card')
    .first();
  await expect(card).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await fitsScreen(page);
  if (process.env.LAYOUT_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.LAYOUT_SCREENSHOTS}/admin-settings-mobile-spacing.png`,
      fullPage: true,
    });
});
