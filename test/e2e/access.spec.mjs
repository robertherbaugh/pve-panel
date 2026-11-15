import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';
import { startMockOidc } from '../support/mock-oidc.mjs';

let stack, oidc;
test.beforeAll(async () => {
  oidc = await startMockOidc();
  stack = await startStack({ env: { OIDC_ENABLED: 'true', OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: 'panel-test', OIDC_CLIENT_SECRET: 'secret',
    OIDC_ALLOW_INSECURE_HTTP: 'true', OIDC_AUTO_CREATE: 'true', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false', SETUP_CHECK_HOURS: '0' } });
  await stack.offerTemplates();
  stack.mock.vms.get(101).pool = 'tacid-dev';
  stack.mock.vms.get(101).cfg.tags = 'tacid-dev;ubuntu';
  stack.mock.vms.get(102).pool = 'tacid-prod';
  stack.mock.vms.get(102).cfg.tags = 'tacid-prod;ubuntu';
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
  stack.mock.perms['/pool/tacid-prod'] = ['Pool.Audit'];
});

const editorRule = (id, patch = {}) => ({ id, name: id, groups: ['developers'], entitlements: [], match: 'any', pools: ['tacid-dev'], tags: [], vmids: [], actions: ['view'], ...patch });
const editorPolicy = (rules) => ({ version: 1, enabled: true, allowedDomains: [], rules });
async function permissionsPage(page, context, rules) {
  const admin = await stack.adminSession();
  expect((await admin.put('/api/admin/access-policy', editorPolicy(rules))).status).toBe(200);
  await context.addCookies(cookies(admin));
  await page.goto(stack.adminUrl);
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.getByRole('heading', { name: 'Permission sets', exact: true })).toBeVisible();
  return admin;
}

test('searchable resource selectors retain multiple VMs; row toggles persist without changing other sets', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const admin = await permissionsPage(page, context, [
    editorRule('shared-operations', { name: 'Shared operations', pools: ['tacid-dev', 'tacid-prod'], entitlements: ['dev:operate'], actions: ['view', 'power', 'console', 'snapshot.create', 'snapshot.delete', 'snapshot.rollback'] }),
    editorRule('production-readers', { name: 'Production readers', groups: ['implementation'], pools: ['tacid-prod'] }),
  ]);
  await expect(page.locator('[data-inventory-status]')).toContainText('pools,');
  await page.getByRole('button', { name: 'Edit Shared operations', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit permission set', exact: true });
  await dialog.getByRole('button', { name: 'Resource pools', exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Search resource pools', exact: true }).fill('tacid-dev');
  await expect(dialog.locator('[data-picker=pools] .access-picker-option:visible')).toHaveCount(1);
  await expect(dialog.getByText('Resources for tacid-dev · 1 eligible VM', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Required VM tags', exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Search required vm tags', exact: true }).fill('ubuntu');
  await dialog.locator('[data-picker=tags] input[value=ubuntu]').check();
  await dialog.getByRole('button', { name: 'Specific VMs', exact: true }).click();
  const search = dialog.getByRole('searchbox', { name: 'Search specific vms', exact: true });
  await search.fill('101');
  await expect(dialog.locator('[data-picker=vmids] .access-picker-option:visible')).toHaveCount(1);
  await dialog.locator('[data-picker=vmids] input[value="101"]').check();
  await search.fill('other-customer');
  await expect(dialog.locator('[data-picker=vmids] .access-picker-option:visible')).toHaveCount(1);
  await dialog.locator('[data-picker=vmids] input[value="102"]').check();
  await expect(dialog.locator('[data-picker=vmids] input[value="101"]')).toBeChecked();
  await search.fill('');
  if (process.env.ACCESS_EDITOR_SCREENSHOT) await dialog.screenshot({ path: process.env.ACCESS_EDITOR_SCREENSHOT });
  await search.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(search).toBeHidden();
  await dialog.getByRole('button', { name: 'Save permission set', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const stored = (await admin.get('/api/admin/access-policy')).json.policy.rules[0];
  expect(stored.tags).toEqual(['ubuntu']);
  expect(stored.vmids).toEqual([101, 102]);
  expect(stored.pools).toEqual(['tacid-dev', 'tacid-prod']);
  if (process.env.ACCESS_SCREENSHOT) await page.screenshot({ path: process.env.ACCESS_SCREENSHOT, fullPage: true });
  await page.getByRole('switch', { name: 'Enable Shared operations', exact: true }).uncheck();
  await expect.poll(async () => (await admin.get('/api/admin/access-policy')).json.policy.rules[0].enabled).toBe(false);
  expect((await admin.get('/api/admin/access-policy')).json.policy.rules[1].enabled).toBe(true);
  await page.reload();
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.getByRole('switch', { name: 'Enable Shared operations', exact: true })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Enable Production readers', exact: true })).toBeChecked();
});

test('failed inventory refresh preserves saved resource constraints and cancelled modal edits do not save', async ({ page, context }) => {
  await page.route('**/api/admin/access-policy/resources', (route) => route.fulfill({ status: 503, json: { error: 'Proxmox temporarily unavailable' } }));
  const original = editorRule('preserved', { name: 'Preserved resources', pools: ['tacid-dev', 'retired-pool'], tags: ['ubuntu', 'retired-tag'], vmids: [101, 99999] });
  const admin = await permissionsPage(page, context, [original]);
  await expect(page.locator('[data-inventory-status]')).toContainText('Existing selections are preserved');
  await page.getByRole('button', { name: 'Edit Preserved resources', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Edit permission set', exact: true });
  await dialog.locator('[data-field=name]').fill('Unsaved edit');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await admin.get('/api/admin/access-policy')).json.policy.rules[0].name).toBe(original.name);
  await page.getByRole('button', { name: 'Edit Preserved resources', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit permission set', exact: true });
  await dialog.locator('[data-field=name]').fill('Renamed with constraints intact');
  await dialog.getByRole('button', { name: 'Resource pools', exact: true }).click();
  await expect(dialog.locator('[data-picker=pools] input[value=retired-pool]')).toBeChecked();
  await expect(dialog.locator('[data-picker=pools]')).toContainText('Unavailable in the current Proxmox inventory');
  await dialog.getByRole('button', { name: 'Save permission set', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const stored = (await admin.get('/api/admin/access-policy')).json.policy.rules[0];
  expect(stored.pools).toEqual(original.pools);
  expect(stored.tags).toEqual(original.tags);
  expect(stored.vmids).toEqual(original.vmids);
  await page.getByRole('button', { name: 'Edit Renamed with constraints intact', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permission set', exact: true }).click();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('[data-access-rule]')).toHaveCount(0);
  expect((await admin.get('/api/admin/access-policy')).json.policy.rules).toEqual([]);
});

test('stale table toggles cannot overwrite a newer policy', async ({ page, context }) => {
  const first = editorRule('concurrent', { name: 'Concurrent set' });
  const admin = await permissionsPage(page, context, [first]);
  await admin.put('/api/admin/access-policy', editorPolicy([first, editorRule('newer-set')]));
  // The rejected edit immediately restores the saved switch state.
  await page.getByRole('switch', { name: 'Enable Concurrent set', exact: true }).click();
  await expect(page.locator('[data-policy-error]')).toContainText('Permissions changed in another session');
  await expect(page.getByRole('switch', { name: 'Enable Concurrent set', exact: true })).toBeChecked();
  const saved = (await admin.get('/api/admin/access-policy')).json.policy;
  expect(saved.rules.map((r) => r.id)).toEqual(['concurrent', 'newer-set']);
  expect(saved.rules[0].enabled).toBe(true);
});
test.afterAll(async () => { await stack?.stop(); await oidc?.close(); });
const cookies = (session) => [...session.cookies].map(([name, value]) => ({ name, value, url: session.base }));

test('administrator edits mappings; customer chooses a destination and sees permitted operations', async ({ page, context }) => {
  const admin = await stack.adminSession();
  await admin.put('/api/admin/access-policy', { version: 1, enabled: false, allowedDomains: [], rules: [] });
  const imported=(await admin.get('/api/admin/customers')).json.customers.find(c=>c.slug==='imported-sso');
  const customerBody={name:imported.name,slug:imported.slug,enabled:true,pools:['tacid-dev','tacid-prod'],allowedDomains:[],sso:{groups:['developers'],entitlements:[],match:'any',required:true},limits:imported.limits,revision:imported.revision};
  expect((await admin.put(`/api/admin/customers/${imported.id}`,customerBody)).status).toBe(200);
  await context.addCookies(cookies(admin));
  await page.goto(stack.adminUrl);
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.getByRole('heading', { name: 'Access permissions' })).toBeVisible();
  await page.locator('[name=enabled]').check();
  await expect(page.locator('[name=domains]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save access settings', exact: true }).click();
  await expect(page.locator('[data-access-status]')).toHaveText('SSO access enabled');
  for (const [id, pool, cores] of [['development', 'tacid-dev', 2], ['production', 'tacid-prod', 4]]) {
    await page.locator('[data-add-rule]').click();
    const rule = page.getByRole('dialog', { name: 'Add permission set', exact: true });
    await rule.locator('[data-field=customerId]').selectOption(String(imported.id));
    await rule.locator('[data-action=clone]').check();
    await rule.getByRole('button', { name: 'Resource pools', exact: true }).click();
    await rule.locator(`[data-picker=pools] input[value="${pool}"]`).check();
    await rule.getByRole('button', { name: 'Resource pools', exact: true }).click();
    for (const [name, value] of Object.entries({ id, name: id, groups: 'developers', entitlements: 'dev:operate',
      templates: '9000', storages: 'VMStorage', servers: 2, cores, memoryMb: 4096, diskGb: 40 })) {
      await rule.locator(`[data-field=${name}]`).fill(String(value));
    }
    await rule.locator('[data-field=clonePool]').selectOption(pool);
    await rule.getByRole('button', { name: 'Save permission set', exact: true }).click();
    await expect(rule).toHaveCount(0);
  }
  await expect(page.locator('[data-policy-error]')).toBeEmpty();
  await expect.poll(async () => (await admin.get('/api/admin/access-policy')).json.policy.rules.length).toBe(2);
  await page.reload();
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.locator('[data-access-rule]')).toHaveCount(2);
  const customer = stack.customer();
  await oidc.login(customer, { email: 'browser@tacticalid.io', groups: ['developers'] });
  await context.addCookies(cookies(customer));
  await page.goto(stack.customerUrl);
  await page.locator('[data-vmid="101"]').first().click();
  await expect(page.locator('[data-power=start]')).toBeDisabled();
  await expect(page.locator('[data-tab=console]')).toHaveCount(0);
  await page.locator('[data-tab=snapshots]').click();
  await expect(page.locator('#snap-form')).toBeHidden();
  await page.locator('#new-server').click();
  await expect(page.locator('#clone-destination')).toHaveValue('development');
  await expect(page.locator('[name=cores]')).toHaveAttribute('max', '2');
  await page.locator('#clone-destination').selectOption('production');
  await expect(page.locator('[name=cores]')).toHaveAttribute('max', '4');
  await page.locator('[name=hostname]').fill('browser-clone');
  await page.locator('[name=sshKeys]').fill('ssh-ed25519 AAAA-test');
  const request = page.waitForRequest((r) => r.url() === `${stack.customerUrl}/api/vms` && r.method() === 'POST');
  await page.locator('#create-submit').click();
  expect((await request).postDataJSON().accessRuleId).toBe('production');
});
