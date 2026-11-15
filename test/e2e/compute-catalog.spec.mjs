import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';

test('provider configures sizes, Basic backup destinations, customer add-ons and a read-only capacity preview', async ({ browser }) => {
  const stack = await startStack({ env: { SETUP_CHECK_HOURS: '0', CUSTOMER_NETWORKS: 'false', VPN_ENABLED: 'false' } });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (err) => errors.push(err.message));
  try {
    await stack.customerWith('pilot@example.com');
    stack.mock.cluster.nodes = [{ node: 'pve1', status: 'online', maxcpu: 16, maxmem: 64 * 2 ** 30, mem: 8 * 2 ** 30 }];
    stack.mock.cluster.storageInventories = { pve1: [
      { storage: 'archive-hdd', type: 'dir', content: 'images,rootdir', active: 1, enabled: 1, avail: 900 * 2 ** 30, total: 1000 * 2 ** 30 },
      { storage: 'pbs', type: 'pbs', content: 'backup', active: 1, enabled: 1, avail: 1500 * 2 ** 30, total: 2000 * 2 ** 30 },
    ] };
    await page.goto(stack.adminUrl);
    await page.locator('#login-form [name=email]').fill('admin@example.com');
    await page.locator('#login-form [name=password]').fill('correct-horse-battery');
    await page.locator('#login-form button[type=submit]').click();
    await page.getByRole('button', { name: 'Compute', exact: true }).click();
    await expect(page.getByText('Customer opt-in', { exact: true })).toBeVisible();
    await page.locator('tr').filter({ has: page.getByText('Small', { exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
    let d = page.getByRole('dialog');
    await expect(d).toHaveAccessibleName('Edit VM size');
    await d.getByLabel('Size enabled', { exact: true }).check();
    await d.getByLabel('vCPUs', { exact: true }).fill('2');
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.locator('tr').filter({ has: page.getByText('Small', { exact: true }) })).toContainText('Enabled');

    await page.getByRole('tab', { name: 'Storage classes', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Basic', exact: true }).click();
    d = page.getByRole('dialog');
    await d.getByLabel('Storage class enabled', { exact: true }).check();
    const vm = d.locator('[data-vm]');
    await vm.getByRole('button').click();
    await vm.getByRole('checkbox', { name: /archive-hdd on pve1/ }).check();
    const backup = d.locator('[data-backup]');
    await backup.getByRole('button').click();
    await backup.getByRole('checkbox', { name: /pbs on pve1/ }).check();
    await expect(backup.getByRole('checkbox', { name: /archive-hdd/ })).toHaveCount(0);
    if (process.env.COMPUTE_MAPPING_SCREENSHOT) await d.screenshot({ path: process.env.COMPUTE_MAPPING_SCREENSHOT });
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText('1 VM destinations · 1 backup destinations')).toBeVisible();

    await page.getByRole('button', { name: 'Edit Standard', exact: true }).click();
    d = page.getByRole('dialog');
    await expect(d.locator('[data-backup]')).toHaveCount(0);
    await d.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('tab', { name: 'Customer offerings', exact: true }).click();
    await page.locator('tr').filter({ hasText: 'pilot@example.com' }).getByRole('button', { name: 'Edit offerings', exact: true }).click();
    d = page.getByRole('dialog');
    await d.getByRole('combobox', { name: 'Service tier', exact: true }).selectOption('ridge');
    await expect(d.locator('[data-backup-fee]')).toContainText('service fee is included');
    await expect(d.locator('[data-backup-fee]')).toContainText('storage usage is charged separately');
    await d.getByLabel('Backup service selected', { exact: true }).check();
    await d.getByLabel('Fast disk limit (GiB)', { exact: true }).fill('500');
    await d.getByLabel('Allow the optional HA add-on', { exact: true }).uncheck();
    await d.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(d).toHaveCount(0);
    await page.locator('tr').filter({ hasText: 'pilot@example.com' }).getByRole('button', { name: 'Edit offerings', exact: true }).click();
    d = page.getByRole('dialog');
    await expect(d.getByRole('combobox', { name: 'Service tier', exact: true })).toHaveValue('ridge');
    await expect(d.getByLabel('Fast disk limit (GiB)', { exact: true })).toHaveValue('500');
    await expect(d.getByLabel('Allow the optional HA add-on', { exact: true })).not.toBeChecked();
    await expect(d.getByLabel('Backup service selected', { exact: true })).toBeChecked();
    await d.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('tab', { name: 'Capacity', exact: true }).click();
    await page.getByRole('button', { name: 'Check capacity', exact: true }).click();
    await expect(page.locator('[data-preview-result]')).toContainText('Passes observed capacity checks');
    await expect(page.locator('[data-preview-result]')).toContainText('No capacity reserved');
    if (process.env.COMPUTE_CATALOG_SCREENSHOT) await page.screenshot({ path: process.env.COMPUTE_CATALOG_SCREENSHOT, fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: 'Compute', exact: true }).click();
    await page.getByRole('tab', { name: 'Storage classes', exact: true }).click();
    await expect(page.getByText('1 VM destinations · 1 backup destinations')).toBeVisible();
    assertNoErrors();
  } finally { await page.close(); await stack.stop(); }
  function assertNoErrors() { expect(errors).toEqual([]); }
});

test('customer provisions a catalog size and storage class without raw resource fields', async ({ browser }) => {
  const stack = await startStack({ env: { SETUP_CHECK_HOURS:'0', CUSTOMER_NETWORKS:'false', VPN_ENABLED:'false' } });
  const page = await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await stack.offerTemplates();
    await stack.customerWith('catalog-ui@example.com',{limits:{}});
    const a=await stack.adminSession(), customers=(await a.get('/api/admin/customers')).json.customers;
    const id=customers.find(c=>c.name==='catalog-ui@example.com').id;
    stack.mock.perms['/vms']=['VM.Audit'];stack.mock.perms['/pool/customers'].push('Pool.Audit');
    stack.mock.cluster.nodes=[{node:'pve1',status:'online',maxcpu:32,maxmem:128*2**30,mem:8*2**30}];
    stack.mock.cluster.storageInventories={pve1:[{storage:'VMStorage',content:'images,rootdir',active:1,enabled:1,shared:1,total:1000*2**30,avail:900*2**30}]};
    const c=(await a.get('/api/admin/compute-catalog')).json;
    c.sizes[0].enabled=true;c.classes[2].enabled=true;c.classes[2].bindings=[{node:'pve1',storage:'VMStorage',purpose:'vm'}];
    const saved=(await a.put('/api/admin/compute-catalog',{revision:c.revision,sizes:c.sizes,classes:c.classes.map(({id,enabled,bindings})=>({id,enabled,bindings})),reserves:c.reserves})).json;
    const p=(await a.get(`/api/admin/customers/${id}/compute-profile`)).json;
    const {revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb}=p;
    expect((await a.put(`/api/admin/customers/${id}/compute-profile`,{revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb,catalogRevision:saved.revision,catalogEnabled:true,network:{bridge:'vmbr0',vlan:47,verified:true}})).status).toBe(200);
    await page.goto(stack.customerUrl);
    await page.locator('#login-form [name=email]').fill('catalog-ui@example.com');
    await page.locator('#login-form [name=password]').fill('another-long-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#new-server').click();
    await expect(page.locator('#create-form [name=cores]')).toHaveCount(0);
    await page.getByRole('combobox',{name:'VM size',exact:true}).selectOption('small');
    await page.getByRole('combobox',{name:'Storage class',exact:true}).selectOption('fast');
    await page.locator('#create-form [name=hostname]').fill('catalog-ui');
    await page.locator('#create-form [name=password]').fill('catalog-password-123');
    await page.locator('#create-submit').click();
    const entry=page.locator('.unit',{hasText:'catalog-ui'});
    await expect(entry).toBeVisible();
    await expect(entry).not.toContainText(/Setting up/i,{timeout:60000});
    await expect(entry).not.toContainText(/failed/i);
    expect(errors).toEqual([]);
  } finally { await page.close();await stack.stop(); }
});
