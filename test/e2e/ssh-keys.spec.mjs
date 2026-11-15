import { test, expect } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { startStack } from '../support/stack.mjs';
test('user saves a public key and chooses cloud-init login before creating a VM',async({browser})=>{
 const stack=await startStack({env:{CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false',SETUP_CHECK_HOURS:'0'}}),page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await stack.offerTemplates();await stack.customerWith('ssh-browser@example.com',{limits:{}});
  const pair=generateKeyPairSync('ed25519'),wire=b=>{const n=Buffer.alloc(4);n.writeUInt32BE(b.length);return Buffer.concat([n,b]);};
  const key=`ssh-ed25519 ${Buffer.concat([wire(Buffer.from('ssh-ed25519')),wire(pair.publicKey.export({type:'spki',format:'der'}).subarray(-32))]).toString('base64')}`;
  await page.goto(stack.customerUrl);
  await page.locator('#login-form [name=email]').fill('ssh-browser@example.com');await page.locator('#login-form [name=password]').fill('another-long-password');await page.locator('#login-form button[type=submit]').click();
  await page.locator('#nav-account').click();
  const library=page.locator('#ssh-keys');
  await library.getByLabel('Key name',{exact:true}).fill('Work laptop');
  await library.getByLabel('SSH public key',{exact:true}).fill(key);
  await library.getByRole('button',{name:'Save SSH key',exact:true}).click();
  await expect(library.getByText('Work laptop',{exact:true})).toBeVisible();
  await expect(library.locator('td').filter({hasText:/SHA256:/})).toHaveCount(1);
  await page.locator('#new-server').click();
  const f=page.locator('#create-form'),method=f.getByRole('combobox',{name:'Sign-in method',exact:true});
  await expect(method).toHaveValue('ssh');await expect(f.locator('[name=password]')).toBeDisabled();
  await expect(f.getByRole('checkbox',{name:/Work laptop/})).toBeChecked();
  await method.selectOption('password');await expect(f.locator('[name=password]')).toBeEnabled();await expect(f.locator('[data-key-fields]')).toBeHidden();
  await method.selectOption('both');await expect(f.locator('[data-key-fields]')).toBeVisible();await expect(f.locator('[name=password]')).toBeEnabled();
  await method.selectOption('ssh');await f.locator('[name=hostname]').fill('ssh-browser');await f.locator('[name=username]').fill('engineer');
  if(process.env.COMPUTE_SSH_SCREENSHOT)await page.screenshot({path:process.env.COMPUTE_SSH_SCREENSHOT,fullPage:true});
  await f.getByRole('button',{name:'Create server',exact:true}).click();
  const entry=page.locator('.unit',{hasText:'ssh-browser'});await expect(entry).toBeVisible();await expect(entry).not.toContainText(/Setting up/i,{timeout:60000});await expect(entry).not.toContainText(/failed/i);
  const vm=[...stack.mock.vms.values()].find(v=>v.name==='ssh-browser');expect(vm.cfg.ciuser).toBe('engineer');expect(decodeURIComponent(vm.cfg.sshkeys).trim()).toBe(key);expect(vm.cfg.cipassword).toBeUndefined();expect(errors).toEqual([]);
 }finally{await page.close();await stack.stop();}
});
