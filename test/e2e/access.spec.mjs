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
  stack.mock.perms['/pool/tacid-dev'] = ['Pool.Audit'];
});
test.afterAll(async () => { await stack?.stop(); await oidc?.close(); });
const cookies = (session) => [...session.cookies].map(([name, value]) => ({ name, value, url: session.base }));

test('administrator edits mappings; customer chooses a destination and sees permitted operations', async ({ page, context }) => {
  const admin = await stack.adminSession();
  await context.addCookies(cookies(admin));
  await page.goto(stack.adminUrl);
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.getByRole('heading', { name: 'Access permissions' })).toBeVisible();
  await page.locator('[name=enabled]').check();
  await page.locator('[name=domains]').fill('tacticalid.io');
  for (const [id, pool, cores] of [['development', 'tacid-dev', 2], ['production', 'tacid-prod', 4]]) {
    await page.locator('[data-add-rule]').click();
    const rule = page.locator('[data-access-rule]').last();
    await rule.locator('[data-action=clone]').check();
    for (const [name, value] of Object.entries({ id, name: id, groups: 'developers', entitlements: 'dev:operate', pools: pool, clonePool: pool,
      templates: '9000', storages: 'VMStorage', servers: 2, cores, memoryMb: 4096, diskGb: 40 })) {
      await rule.locator(`[data-field=${name}]`).fill(String(value));
    }
  }
  await page.getByRole('button', { name: 'Save permissions', exact: true }).click();
  await expect(page.locator('[data-policy-error]')).toBeEmpty();
  await expect.poll(async () => (await admin.get('/api/admin/access-policy')).json.policy.rules.length).toBe(2);
  await page.reload();
  await page.locator('[data-admin-tab=permissions]').click();
  await expect(page.locator('[data-access-rule]')).toHaveCount(2);
  if (process.env.ACCESS_SCREENSHOT) await page.screenshot({ path: process.env.ACCESS_SCREENSHOT, fullPage: true });

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
