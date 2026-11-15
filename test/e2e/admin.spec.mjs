import { test, expect } from '@playwright/test';

const signIn = async (page) => {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#vm-rows tr').first()).toBeVisible();
};

test('lists servers with the customer assignment', async ({ page }) => {
  await signIn(page);
  const row = page.locator('tr[data-vmid="101"]');
  await expect(row.locator('select')).toHaveValue(/\d+/);
  await expect(row.locator('[data-server-action="start"]')).toBeVisible();
});

test('customers tab shows the customer', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=users]').click();
  await expect(page.locator('tr[data-user]', { hasText: 'lena@example.com' })).toBeVisible();
});

test('about tab shows the running version', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=about]').click();
  await expect(page.locator('.about-version')).toContainText(/^v\d+\.\d+\.\d+/);
});

test('sidebar navigation and Settings tabs retain drafts and support the keyboard', async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole('navigation', { name: 'Administration' });
  await expect(nav.locator('[aria-current=page]')).toHaveText('Servers');
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');

  const tabs = page.getByRole('tablist', { name: 'Settings' });
  const branding = tabs.getByRole('tab', { name: 'Branding', exact: true });
  await branding.focus();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Windows updates', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
  await page.keyboard.press('Home');
  await expect(branding).toBeFocused();

  await tabs.getByRole('tab', { name: 'Email', exact: true }).click();
  await page.getByLabel('SMTP server', { exact: true }).fill('draft.smtp.example.com');
  await tabs.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.locator('[data-scheme-pick=ember]').click();
  await expect(page.locator('html')).toHaveAttribute('data-scheme', 'ember');
  await tabs.getByRole('tab', { name: 'Email', exact: true }).click();
  await expect(page.getByLabel('SMTP server', { exact: true })).toHaveValue('draft.smtp.example.com');
  await tabs.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel preview', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Email', exact: true }).click();
  await expect(page.getByLabel('SMTP server', { exact: true })).toHaveValue('draft.smtp.example.com');

  await tabs.getByRole('tab', { name: 'Appearance', exact: true }).click();
  if (process.env.NAV_SCREENSHOT_DIR) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.NAV_SCREENSHOT_DIR}/pve-admin-sidebar-desktop.png`, fullPage: true, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${process.env.NAV_SCREENSHOT_DIR}/pve-admin-sidebar-dark.png`, fullPage: true, animations: 'disabled' });
  }
});

test('mobile administration menu closes after navigation and restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const menu = page.getByRole('button', { name: 'Administration menu', exact: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#admin-nav')).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
  await expect(page.getByLabel('Panel name', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  if (process.env.NAV_SCREENSHOT_DIR) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.NAV_SCREENSHOT_DIR}/pve-admin-sidebar-mobile.png`, fullPage: true, animations: 'disabled' });
  }
});
