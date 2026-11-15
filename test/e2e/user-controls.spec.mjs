import { test, expect } from '@playwright/test';

async function users(page) {
  await page.goto(process.env.E2E_ADMIN_URL);
  await page.locator('#login-form [name=email]').fill('admin@example.com');
  await page.locator('#login-form [name=password]').fill('correct-horse-battery');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('[data-admin-tab=users]').click();
  await expect(page.getByRole('table', { name: 'Users', exact: true })).toBeVisible();
}

test('user icons target the correct identity and Add user validates, retries and creates without a personal customer', async ({ page }) => {
  await users(page);
  const row = page.locator('tr[data-user]', { hasText: 'lena@example.com' });
  const signIn = row.getByRole('button', { name: 'Sign-in settings for lena@example.com', exact: true });
  await expect(signIn).toHaveAttribute('title', 'Sign-in settings');
  await signIn.locator('svg').click();
  await expect(page.locator('#twofa-admin')).toContainText('Sign-in for lena@example.com');
  await page.locator('#twofa-admin').getByRole('button', { name: 'Cancel', exact: true }).click();
  const buttons = await row.locator('.user-actions button').evaluateAll(nodes => nodes.map(n => {
    const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, label: n.getAttribute('aria-label') };
  }));
  expect(buttons.every(b => b.label)).toBe(true);
  expect(buttons.slice(1).every((b, i) => b.left - buttons[i].right >= 6)).toBe(true);
  const add = page.getByRole('button', { name: 'Add user', exact: true });
  await expect(add).toHaveClass(/primary/);
  await add.click();
  const modal = page.getByRole('dialog', { name: 'Add user', exact: true });
  await expect(modal.getByLabel('Email', { exact: true })).toBeFocused();
  await modal.getByLabel('Email', { exact: true }).fill('new-modal-user@example.com');
  await modal.getByRole('button', { name: 'Generate', exact: true }).click();
  await modal.getByLabel('Require two-factor authentication').check();
  const password = await modal.getByLabel('Password', { exact: true }).inputValue();
  await page.route('**/api/admin/users', async route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: 'Please try again' } }) : route.continue());
  await modal.getByRole('button', { name: 'Add user', exact: true }).click();
  await expect(modal.getByRole('alert')).toHaveText('Please try again');
  await expect(modal.getByLabel('Password', { exact: true })).toHaveValue(password);
  await page.unroute('**/api/admin/users');
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/admin/users'));
  await modal.getByRole('button', { name: 'Add user', exact: true }).click();
  expect((await sent).postDataJSON()).toMatchObject({ createPersonalCustomer: false, requireTotp: true, password });
  await expect(modal).toHaveCount(0);
  await expect(page.locator('tr[data-user]', { hasText: 'new-modal-user@example.com' })).toContainText('No memberships');
  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toBeFocused();
  if (process.env.USER_CONTROLS_SCREENSHOTS) { await page.locator('[data-dismiss-note]').click(); await page.locator('#toasts').evaluateAll(nodes => nodes.forEach(n => n.replaceChildren())); await page.screenshot({ path: `${process.env.USER_CONTROLS_SCREENSHOTS}/pve-users-icons.png`, fullPage: true }); }
});

test('invitation mode omits passwords and the creation modal fits mobile screens', async ({ page }) => {
  await page.route('**/api/admin/settings/email', route => route.fulfill({ json: { configured: true } }));
  await users(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add user', exact: true });
  await modal.getByLabel('Email', { exact: true }).fill('invite-modal@example.com');
  await modal.getByLabel('Send an invitation email').check();
  await expect(modal.getByLabel('Password', { exact: true })).toBeHidden();
  let sent;
  await page.route('**/api/admin/users', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { invited: true } });
  });
  const bounds = await modal.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(bounds.height).toBeLessThanOrEqual(844);
  if (process.env.USER_CONTROLS_SCREENSHOTS) await page.screenshot({ path: `${process.env.USER_CONTROLS_SCREENSHOTS}/pve-add-user-mobile.png`, fullPage: true });
  await modal.getByRole('button', { name: 'Add user', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(sent).toMatchObject({ invite: true, createPersonalCustomer: false });
  expect(sent).not.toHaveProperty('password');
});

test('slow admin requests animate while pending and respect reduced motion', async ({ page }) => {
  await users(page);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/admin/settings/email', async route => { await pending; await route.continue(); });
  await page.locator('[data-admin-tab=settings]').click();
  const loading = page.locator('#admin-body [role=status]');
  await expect(loading).toContainText('Loading…');
  const spinner = loading.locator('.spinner');
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS('animation-name', 'spin');
  if (process.env.USER_CONTROLS_SCREENSHOTS) await page.screenshot({ path: `${process.env.USER_CONTROLS_SCREENSHOTS}/pve-settings-loading.png`, fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(spinner).toHaveCSS('animation-name', 'none');
  release();
  await expect(page.getByRole('tablist', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('#admin-body > [role=status]')).toHaveCount(0);
});
