import { test, expect } from '@playwright/test';
import { startStack } from '../support/stack.mjs';
let stack, admin, user, customerId;
test.beforeAll(async()=>{
 stack=await startStack({env:{SETUP_CHECK_HOURS:'0',CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false'}});admin=await stack.adminSession();user=await stack.customerWith('bulk-owner@example.com');customerId=(await user.get('/api/account')).json.customer.id;
 for(let id=601;id<=640;id++)stack.mock.vms.set(id,{vmid:id,node:'pve1',type:'qemu',name:`bulk-${id}`,status:'stopped',maxcpu:1,maxmem:2**30,maxdisk:8*2**30,cfg:{cores:1,memory:1024,scsi0:`VMStorage:vm-${id}-disk-0,size=8G`}});
});
test.afterAll(async()=>{await stack?.stop();});
async function signIn(page,session=admin,url=stack.adminUrl){await page.context().addCookies([...session.cookies].map(([name,value])=>({name,value,url})));await page.goto(url);}
test('unassigned server actions are visible; page selection survives filters and bulk assignment preserves display names',async({page})=>{
 await signIn(page);const table=page.getByRole('table',{name:'Servers',exact:true});await expect(table).toBeVisible();
 const search=page.getByRole('searchbox',{name:'Search Servers',exact:true});await search.fill('bulk-');
 const first=table.locator('tr[data-vmid="601"]');const start=first.getByRole('button',{name:'Start bulk-601',exact:true});await expect(start).toBeVisible();await expect(start).toBeEnabled();
 const actionBounds=await start.boundingBox();expect(actionBounds.x+actionBounds.width).toBeLessThanOrEqual(await page.evaluate(()=>innerWidth));
 await page.getByRole('checkbox',{name:'Select servers on this page',exact:true}).check();await expect(page.locator('[data-selection-count]')).toHaveText('25 selected');
 await page.getByRole('button',{name:'Servers next page',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Select servers on this page',exact:true})).not.toBeChecked();
 await page.getByRole('checkbox',{name:'Select server 626 bulk-626',exact:true}).check();await expect(page.locator('[data-selection-count]')).toHaveText('26 selected');
 await search.fill('bulk-640');await expect(page.locator('[data-selection-count]')).toHaveText('26 selected');await expect(table.locator('tbody tr[data-vmid]:visible')).toHaveCount(1);
 await page.getByLabel('Customer for selected servers',{exact:true}).selectOption(String(customerId));
 if(process.env.ADMIN_CONTROLS_SCREENSHOTS)await page.screenshot({path:`${process.env.ADMIN_CONTROLS_SCREENSHOTS}/pve-server-bulk.png`,fullPage:true});
 await page.getByRole('button',{name:'Assign selected',exact:true}).click();const modal=page.locator('#confirm');await expect(modal).toContainText('26 selected servers');await modal.getByRole('button',{name:'Assign servers',exact:true}).click();
 await expect(page.locator('[data-selection-count]')).toHaveText('0 selected');
 const vms=(await admin.get('/api/admin/vms')).json;expect(vms.filter(v=>v.vmid>=601&&v.vmid<=640&&v.customerId===customerId)).toHaveLength(26);expect(vms.find(v=>v.vmid===640).customerId).toBeNull();
});
test('admin billing has horizontal sections and price drafts and customer billing render without credentials',async({page})=>{
 await admin.post('/api/admin/vms/assign',{vmids:[601],customerId});
 const vmCount=(await user.get('/api/vms')).json.length;
 await signIn(page);await page.locator('[data-admin-tab=billing]').click();await expect(page.getByRole('tablist',{name:'Billing',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'Prices',exact:true}).click();const input=page.getByLabel('Monthly price for Basecamp service',{exact:true});await input.fill('15.25');
 await page.getByRole('button',{name:'Save draft prices',exact:true}).click();await expect(page.getByRole('tab',{name:'Prices',exact:true})).toBeVisible();await expect(page.getByLabel('Monthly price for Basecamp service',{exact:true})).toHaveValue('15.25');
 await page.getByRole('tab',{name:'Stripe',exact:true}).click();await expect(page.getByLabel('Stripe secret key',{exact:true})).toHaveValue('');
 if(process.env.ADMIN_CONTROLS_SCREENSHOTS)await page.screenshot({path:`${process.env.ADMIN_CONTROLS_SCREENSHOTS}/pve-billing-settings.png`,fullPage:true});
 await page.getByRole('tab',{name:'Customers',exact:true}).click();await page.locator(`[data-billing-customer="${customerId}"]`).getByRole('button',{name:'Manage billing',exact:true}).click();await expect(page.getByRole('dialog',{name:'Customer billing',exact:true})).toContainText('Billing for bulk-owner@example.com');
 const context=await page.context().browser().newContext();const customerPage=await context.newPage();await signIn(customerPage,user,stack.customerUrl);await customerPage.getByRole('button',{name:'Billing',exact:true}).click();await expect(customerPage.getByRole('heading',{name:'Billing',exact:true})).toBeVisible();await expect(customerPage.getByText(`${vmCount} existing VM(s) need catalog adoption`,{exact:false})).toBeVisible();
 await customerPage.getByLabel('Billing email',{exact:true}).fill('billing-contact@example.com');await customerPage.getByRole('button',{name:'Save billing email',exact:true}).click();await expect(customerPage.getByLabel('Billing email',{exact:true})).toHaveValue('billing-contact@example.com');await context.close();
});

test('both portals expose Delete for authorized imported VMs and require typed confirmation',async({page})=>{
 await admin.post('/api/admin/vms/assign',{vmids:[601],customerId});
 await signIn(page);await page.getByRole('searchbox',{name:'Search Servers',exact:true}).fill('bulk-640');
 await page.locator('tr[data-vmid="640"]').getByRole('button',{name:'Delete server bulk-640',exact:true}).click();
 await expect(page.locator('#prompt')).toContainText('Type 640');await page.locator('#prompt').getByRole('button',{name:'Cancel',exact:true}).click();
 const context=await page.context().browser().newContext();const cp=await context.newPage();await signIn(cp,user,stack.customerUrl);
 await cp.locator('.unit[data-vmid="601"]').click();const button=cp.getByRole('button',{name:'Delete server',exact:true});await expect(button).toBeVisible();await expect(button).toBeEnabled();await button.click();await expect(cp.locator('#prompt')).toContainText('Type 601');await cp.locator('#prompt').getByRole('button',{name:'Cancel',exact:true}).click();await context.close();
});
