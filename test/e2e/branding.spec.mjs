import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';

test('an administrator saves database branding and uploads, replaces and removes images without restarting', async ({ browser }) => {
  const stack = await startStack({ env: { SETUP_CHECK_HOURS: '0', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false' } });
  const admin = await browser.newPage();
  const customer = await browser.newPage();
  const image = (color) => ({ name: 'logo.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="${color}"/></svg>`) });
  try {
    await admin.goto(stack.adminUrl);
    await customer.goto(stack.customerUrl);
    const originalAdminIcon = await admin.locator('link[rel=icon]').first().getAttribute('href');
    const originalCustomerIcon = await customer.locator('link[rel=icon]').first().getAttribute('href');
    await admin.locator('#login-form [name=email]').fill('admin@example.com');
    await admin.locator('#login-form [name=password]').fill('correct-horse-battery');
    await admin.locator('#login-form button[type=submit]').click();
    await admin.getByRole('button', { name: 'Settings', exact: true }).click();
    const editor = admin.locator('[data-branding-editor]');
    await editor.getByLabel('Panel name', { exact: true }).fill('RCADEA Cloud');
    await editor.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(admin).toHaveTitle('Administration – RCADEA Cloud');
    await editor.getByLabel('Upload logo', { exact: true }).setInputFiles(image('#3558e6'));
    const logo = editor.locator('[data-branding-slot=logo] img');
    await expect(logo).toBeVisible();
    const original = await logo.getAttribute('src');
    await editor.getByLabel('Upload windows icon', { exact: true }).setInputFiles(image('#1d7350'));
    await expect(editor.locator('[data-branding-slot=os-windows] img')).toBeVisible();
    await editor.getByLabel('Upload logo', { exact: true }).setInputFiles(image('#7339e0'));
    await expect(logo).not.toHaveAttribute('src', original);
    const replacement = await logo.getAttribute('src');
    if (process.env.BRANDING_SCREENSHOT) await editor.screenshot({ path: process.env.BRANDING_SCREENSHOT });
    await admin.reload();
    await admin.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(editor.getByLabel('Panel name', { exact: true })).toHaveValue('RCADEA Cloud');
    await expect(logo).toHaveAttribute('src', replacement);
    await customer.goto(stack.customerUrl);
    await expect(customer).toHaveTitle(/RCADEA Cloud/);
    await expect(customer.locator('#login-view [data-brand-mark] img').first()).toHaveAttribute('src', replacement);
    const icon = customer.locator('link[rel=icon]').first();
    await expect(icon).toHaveAttribute('href', replacement);
    await editor.getByRole('button', { name: 'Remove logo', exact: true }).click();
    await admin.locator('#confirm-ok').click();
    await expect(logo).toHaveCount(0);
    await expect(admin.locator('link[rel=icon]').first()).toHaveAttribute('href', originalAdminIcon);
    await customer.reload();
    await expect(customer.locator('#login-view [data-brand-mark] svg').first()).toBeVisible();
    await expect(customer.locator('link[rel=icon]').first()).toHaveAttribute('href', originalCustomerIcon);
  } finally {
    await admin.close(); await customer.close(); await stack.stop();
  }
});
