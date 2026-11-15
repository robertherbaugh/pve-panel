import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { startStack } from '../support/stack.mjs';

let stack, admin, sql;
test.beforeAll(async () => {
  stack = await startStack({ env: { SETUP_CHECK_HOURS: '0', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false' } });
  admin = await stack.adminSession();
  await stack.customerWith('table-owner@example.com', { limits: {} });
  const template = stack.mock.vms.get(9000);
  for (let i = 1; i <= 38; i++) stack.mock.vms.set(9200 + i, { ...structuredClone(template), vmid: 9200 + i, name: `image-${i}`, pool: 'templates' });
  sql = new DatabaseSync(path.join(stack.dir, 'panel.db'));
  const insert = sql.prepare('INSERT INTO audit_log(vmid,action,detail,created_at) VALUES(?,?,?,?)');
  for (let i = 1; i <= 237; i++) insert.run(i, 'power_start', JSON.stringify({ hostname: `historical-${i}` }), '2026-01-01 00:00:00');
  const operation = sql.prepare("INSERT INTO compute_operations(id,customer_id,user_id,vmid,kind,state,plan) VALUES(?,1,1,?,'create','review',?)");
  const backup = sql.prepare("INSERT INTO compute_backup_reservations(job_id,customer_id,vmid,node,storage,storage_key,reserved_bytes,state) VALUES(?,1,?,'pve1','pbs','pbs',?,'held')");
  for (let i = 1; i <= 38; i++) {
    operation.run(`operation-${String(i).padStart(3, '0')}`, i, JSON.stringify({ node: 'pve1', storage: 'fast' }));
    backup.run(i, i, i * 2 ** 30);
  }
});
test.afterAll(async () => { sql?.close(); await stack?.stop(); });
const signIn = async (page) => {
  await page.context().addCookies([...admin.cookies].map(([name, value]) => ({ name, value, url: stack.adminUrl })));
  await page.goto(stack.adminUrl);
  await expect(page.locator('[data-admin-table="Servers"]')).toBeVisible();
};

test('local tables retain editable drafts across paging, filtering, sorting and section changes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('searchbox', { name: 'Search Servers', exact: true }).fill('table-owner@example.com');
  await expect(page.getByRole('table', { name: 'Servers', exact: true })).toContainText('No matching results.');
  // An unassigned row must not match every customer in its assignment dropdown.
  await page.getByRole('searchbox', { name: 'Search Servers', exact: true }).fill('');
  await page.locator('[data-admin-tab=templates]').click();
  const table = page.getByRole('table', { name: 'VM templates', exact: true });
  await expect(table.locator('tbody tr[data-template]:visible')).toHaveCount(25);
  const row = table.locator('[data-template="9201"]');
  await row.locator('[data-f=label]').fill('Retained draft');
  await row.locator('[data-f=offered]').check();
  await page.getByRole('button', { name: 'VM templates next page', exact: true }).click();
  await expect(row).toBeHidden();
  await page.getByRole('button', { name: 'VM templates first page', exact: true }).click();
  await expect(row.locator('[data-f=label]')).toHaveValue('Retained draft');
  await page.getByRole('tab', { name: 'Container images', exact: true }).click();
  await page.getByRole('tab', { name: 'VM templates', exact: true }).click();
  await expect(row.locator('[data-f=offered]')).toBeChecked();
  await page.getByRole('button', { name: 'Sort VM templates by ID', exact: true }).click();
  await expect(table.locator('tbody tr:visible').first()).toHaveAttribute('data-template', '9000');
  await page.getByRole('button', { name: 'Sort VM templates by ID', exact: true }).click();
  await expect(table.locator('tbody tr:visible').first()).toHaveAttribute('data-template', '9238');
  await page.getByRole('searchbox', { name: 'Search VM templates', exact: true }).fill('Retained draft');
  await expect(table.locator('tbody tr[data-template]:visible')).toHaveCount(1);
  await expect(row).toBeVisible();
  const saved = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/api/admin/templates/9201'));
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).postDataJSON().label).toBe('Retained draft');
  await page.getByRole('group', { name: 'VM templates table controls', exact: true }).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'VM templates rows per page', exact: true }).selectOption('10');
  await expect(table.locator('tbody tr[data-template]:visible')).toHaveCount(10);
  await page.getByRole('group', { name: 'VM templates table controls', exact: true }).getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Filter VM templates by Offered', exact: true }).fill('Enabled');
  await expect(table.locator('tbody tr[data-template]:visible')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search VM templates', exact: true }).fill('no such image');
  await expect(table).toContainText('No matching results.');
  await expect(page.getByRole('button', { name: 'VM templates next page', exact: true })).toBeDisabled();
});

test('every admin page has section tabs; keyboard navigation and drafts work outside Settings', async ({ page }) => {
  await signIn(page);
  for (const id of ['servers', 'compute', 'templates', 'vpn', 'customers', 'users', 'permissions', 'activity', 'settings', 'setup', 'account', 'about']) {
    await page.locator(`[data-admin-tab=${id}]`).click();
    await expect(page.getByRole('tablist').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('tablist').first().locator('[aria-selected=true]')).toHaveCount(1);
  }
  await page.locator('[data-admin-tab=compute]').click();
  await page.getByRole('tab', { name: 'VM sizes', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Operations', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Capacity', exact: true }).click();
  await page.getByLabel('Host memory reserve (MiB)', { exact: true }).fill('12345');
  await page.getByRole('tab', { name: 'VM sizes', exact: true }).click();
  await page.getByRole('tab', { name: 'Capacity', exact: true }).click();
  await expect(page.getByLabel('Host memory reserve (MiB)', { exact: true })).toHaveValue('12345');
});

test('Activity searches all history, ignores stale responses, recovers from errors and works on mobile', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=activity]').click();
  const table = page.getByRole('table', { name: 'Activity', exact: true });
  await expect(table.locator('tbody tr:visible')).toHaveCount(25);
  await page.getByRole('button', { name: 'Activity last page', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Activity page', exact: true })).not.toHaveValue('1');
  const search = page.getByRole('searchbox', { name: 'Search Activity', exact: true });
  await search.fill('historical-237');
  await expect(table.locator('tbody tr:visible')).toHaveCount(1);
  await expect(table).toContainText('historical-237');
  await expect(page.getByRole('spinbutton', { name: 'Activity page', exact: true })).toHaveValue('1');
  await page.route('**/api/admin/audit?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.fulfill({ json: { total: 1, page: 1, pages: 1, items: [{ action: 'stale-response', createdAt: '2026-01-01 00:00:00' }] } });
    } else await route.continue();
  });
  await search.fill('slow');
  await page.waitForRequest(r => new URL(r.url()).searchParams.get('q') === 'slow');
  await search.fill('historical-236');
  await expect(table).toContainText('historical-236');
  await page.waitForTimeout(650);
  await expect(table).not.toContainText('stale-response');
  await page.unroute('**/api/admin/audit?**');
  await page.route('**/api/admin/audit?**', r => r.fulfill({ status: 503, json: { error: 'History temporarily unavailable' } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(table).toContainText('History temporarily unavailable');
  await page.unroute('**/api/admin/audit?**');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(table).toContainText('historical-236');
  await search.fill('no matching event');
  await expect(table).toContainText('No matching results.');
  await search.fill('Started server');
  await expect(page.getByRole('status').filter({ hasText: 'of 237 results' })).toBeVisible();
  await page.getByRole('group', { name: 'Activity table controls', exact: true }).getByRole('button', { name: 'Filters', exact: true }).click();
  const serverFilter = page.getByRole('searchbox', { name: 'Filter Activity by Server', exact: true });
  await serverFilter.fill('237');
  await expect(table.locator('tbody tr:visible')).toHaveCount(1);
  await expect(table.locator('tbody tr:visible').locator('td').nth(3)).toHaveText('237');
  await serverFilter.fill('');
  await expect(page.getByRole('status').filter({ hasText: 'of 237 results' })).toBeVisible();
  await page.getByRole('group', { name: 'Activity table controls', exact: true }).getByRole('button', { name: 'Filters', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.ADMIN_TABLE_SCREENSHOTS) {
    await page.screenshot({ path: `${process.env.ADMIN_TABLE_SCREENSHOTS}/pve-admin-tables-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${process.env.ADMIN_TABLE_SCREENSHOTS}/pve-admin-activity-tables.png`, fullPage: true });
    await page.locator('[data-admin-tab=compute]').click();
    await page.getByRole('tab', { name: 'VM sizes', exact: true }).click();
    await page.screenshot({ path: `${process.env.ADMIN_TABLE_SCREENSHOTS}/pve-admin-compute-tabs.png`, fullPage: true });
  }
});

test('customer member dialogs get independent pagination and actions retain their user IDs after sorting', async ({ page }) => {
  await signIn(page);
  const members = Array.from({ length: 38 }, (_, i) => ({ userId: 100 + i, email: `member-${String(i).padStart(2, '0')}@example.com`, role: 'viewer', source: 'manual' }));
  await page.route('**/api/admin/customers/*/members', route => route.fulfill({ json: { members } }));
  await page.locator('[data-admin-tab=customers]').click();
  const customer = page.locator('tr[data-customer]', { hasText: 'table-owner@example.com' });
  const id = await customer.getAttribute('data-customer');
  await customer.getByRole('button', { name: 'Members', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const key = 'Customer members';
  await expect(dialog.locator('tbody tr:visible')).toHaveCount(25);
  await dialog.getByRole('button', { name: `${key} next page`, exact: true }).click();
  await expect(dialog.locator('tbody tr:visible')).toHaveCount(13);
  await dialog.getByRole('button', { name: `Sort ${key} by User`, exact: true }).click();
  await dialog.getByRole('button', { name: `Sort ${key} by User`, exact: true }).click();
  const row = dialog.locator('tbody tr:visible').first();
  await expect(row).toContainText('member-37@example.com');
  let removed;
  await page.route('**/api/admin/customers/*/members/*', route => { removed = route.request().url(); return route.fulfill({ json: { ok: true } }); });
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.locator('#confirm-ok').click();
  await expect.poll(() => removed).toBe(`${stack.adminUrl}/api/admin/customers/${id}/members/137`);
});


test('compute history tables page independently and reconcile the selected operation and backup', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-admin-tab=compute]').click();
  await page.getByRole('tab', { name: 'Operations', exact: true }).click();
  const operations = page.getByRole('table', { name: 'Compute operations', exact: true });
  const backups = page.getByRole('table', { name: 'Backup reservations', exact: true });
  await expect(operations.locator('tbody tr:visible')).toHaveCount(25);
  await expect(backups.locator('tbody tr:visible')).toHaveCount(25);
  await page.getByRole('button', { name: 'Compute operations next page', exact: true }).click();
  await expect(operations.locator('tbody tr:visible')).toHaveCount(13);
  await expect(page.getByRole('spinbutton', { name: 'Backup reservations page', exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Sort Compute operations by VM', exact: true }).click();
  await expect(operations.locator('tbody tr:visible').first().locator('td').first()).toHaveText('1');
  let reconciled;
  await page.route('**/api/admin/compute-operations/*/reconcile', route => {
    reconciled = { url: route.request().url(), body: route.request().postDataJSON() };
    return route.fulfill({ json: { ok: true } });
  });
  await operations.locator('tbody tr:visible').first().getByRole('button', { name: 'Release if absent', exact: true }).click();
  await expect.poll(() => reconciled).toEqual({ url: `${stack.adminUrl}/api/admin/compute-operations/operation-001/reconcile`, body: { action: 'release' } });
  let backupJob;
  await page.route('**/api/admin/compute-backup-reservations/*/reconcile', route => {
    backupJob = route.request().url(); return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('searchbox', { name: 'Search Backup reservations', exact: true }).fill('38');
  await expect(backups.locator('tbody tr:visible')).toHaveCount(1);
  await backups.getByRole('button', { name: 'Find completed archive', exact: true }).click();
  await expect.poll(() => backupJob).toBe(`${stack.adminUrl}/api/admin/compute-backup-reservations/38/reconcile`);
});
