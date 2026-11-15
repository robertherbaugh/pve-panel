import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { startStack, waitFor } from '../support/stack.mjs';
import { startMockStripe } from '../support/mock-stripe.mjs';
let stack, remote, admin, user, other, customerId, sql, sub;
const secret='whsec_testSigningSecretOnly123';
const config = async extra => {
 const d=(await admin.get('/api/admin/billing')).json;
 return {revision:d.settings.revision,enabled:d.settings.enabled,mode:d.settings.mode,currency:d.settings.currency,rates:d.definitions.map(p=>({key:p.key,amountMinor:100})),...extra};
};
const detail=async()=> (await user.get('/api/billing')).json;
const refresh=()=>user.post('/api/billing/refresh');
async function event(type='invoice.paid', extra={}, eventId='evt_testbilling') {
 const a=sql.prepare('SELECT * FROM billing_customers WHERE customer_id=?').get(customerId);
 const body=JSON.stringify({id:eventId,object:'event',type,livemode:false,data:{object:{customer:a.stripe_customer_id,status:'paid'}},...extra});
 const signature=Stripe.webhooks.generateTestHeaderString({payload:body,secret});
 const r=await fetch(stack.customerUrl+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body});
 return {status:r.status,json:await r.json()};
}
before(async()=>{
 remote=await startMockStripe();stack=await startStack({publicUrls:true,env:{STRIPE_TEST_API_URL:remote.url,CUSTOMER_NETWORKS:'false',VPN_ENABLED:'false',SETUP_CHECK_HOURS:'0'}});
 admin=await stack.adminSession();user=await stack.customerWith('billing@example.com',{limits:{maxServers:5,maxCores:16,maxMemoryMb:32768,maxDiskGb:400}});other=await stack.customerWith('billing-other@example.com');
 customerId=(await user.get('/api/account')).json.customer.id;sql=new DatabaseSync(path.join(stack.dir,'panel.db'));
});
after(async()=>{sql?.close();await stack?.stop();await remote?.close();});
test('billing starts disabled and scoped to customer admins; credentials are encrypted and never returned',async()=>{
 let d=await detail();assert.equal(d.summary.enabled,false);assert.equal(d.summary.complete,false);
 assert.equal((await user.get('/api/admin/billing')).status,404);
 assert.equal((await admin.put('/api/admin/billing',await config({enabled:true}))).status,400);
 const r=await admin.put('/api/admin/billing',await config({secretKey:'sk_test_simulatorOnly123',webhookSecret:secret}));assert.equal(r.status,200,r.text);assert.equal(r.json.keyConfigured,true);assert.equal(r.text.includes('sk_test_'),false);assert.equal(r.text.includes(secret),false);
 const row=sql.prepare('SELECT secret_key,webhook_secret FROM billing_settings').get();assert.ok(!row.secret_key.includes('sk_test_'));assert.ok(!row.webhook_secret.includes(secret));
 assert.equal((await admin.put('/api/admin/billing',await config({revision:0}))).status,409);
 const rates=(await config()).rates;rates[0].amountMinor=-1;assert.equal((await admin.put('/api/admin/billing',await config({rates}))).status,400);
 sql.prepare("UPDATE customer_memberships SET role='viewer' WHERE user_id=?").run(user.userId);assert.equal((await user.get('/api/billing')).status,403);assert.equal((await user.post('/api/billing/checkout')).status,403);sql.prepare("UPDATE customer_memberships SET role='admin' WHERE user_id=?").run(user.userId);
});
test('publishes immutable Stripe prices, enables billing, and estimates reserved resources including stopped VMs and Basic backups',async()=>{
 const d=(await admin.get('/api/admin/billing')).json;
 let r=await admin.post('/api/admin/billing/publish',{revision:d.settings.revision});assert.equal(r.status,200,r.text);assert.ok(remote.state.prices.size>5);
 r=await admin.put('/api/admin/billing',await config({enabled:true}));assert.equal(r.status,200,r.text);
 const offering={sizeId:'small',storageClassId:'fast',diskGb:20,haEnabled:true};
 sql.prepare("INSERT INTO compute_allocations(id,vmid,customer_id,offering,started_at) VALUES('billing-allocation',4242,?,?,datetime('now'))").run(customerId,JSON.stringify(offering));
 sql.prepare("INSERT INTO compute_backup_reservations(job_id,customer_id,vmid,node,storage,storage_key,reserved_bytes,state) VALUES(4242,?,4242,'pve1','pbs','shared/pbs',?,'retained')").run(customerId,2.5*2**30);
 const summary=(await detail()).summary;assert.equal(summary.lines.find(l=>l.key==='disk:fast').quantity,20);assert.equal(summary.lines.find(l=>l.key==='backup:basic').quantity,3);assert.equal(summary.lines.find(l=>l.key==='addon:ha').quantity,1);assert.equal(summary.backupStorageClass,'basic');assert.equal(summary.complete,true);
 const draft=await user.post('/api/billing/drafts');assert.equal(draft.status,200,draft.text);assert.equal(draft.json.status,'draft');assert.equal(draft.json.source,'reservation-estimate');assert.equal((await other.get('/api/billing')).json.drafts.length,0);
 sql.prepare("UPDATE compute_allocations SET ended_at=datetime('now') WHERE vmid=4242").run();sql.prepare("UPDATE compute_backup_reservations SET state='released' WHERE job_id=4242").run();
});
test('customer billing email, hosted Checkout, duplicate subscription protection, and payment confirmation use current Stripe state',async()=>{
 assert.equal((await user.put('/api/billing',{email:'accounts@example.com',required:true})).status,400);
 assert.equal((await user.put('/api/billing',{email:'accounts@example.com'})).status,200);
 const a=await admin.put(`/api/admin/customers/${customerId}/billing`,{required:true,email:'accounts@example.com'});assert.equal(a.status,200,a.text);
 remote.state.uncertainCheckout=true;
 const checkout=await user.post('/api/billing/checkout');assert.equal(checkout.status,200,checkout.text);assert.match(checkout.json.url,/^https:\/\/checkout.stripe.com\//);assert.equal(remote.state.sessions.size,1);
 assert.equal((await detail()).account.paymentValid,false);
 const session=[...remote.state.sessions.values()][0];assert.equal(session.success_url,stack.customerUrl+'/#billing');assert.equal(session.client_reference_id,String(customerId));sub=remote.state.complete(session.id);
 const r=await refresh();assert.equal(r.status,200,r.text);assert.equal(r.json.account.paymentValid,true);assert.equal(r.json.account.status,'active');
 assert.equal((await user.post('/api/billing/checkout')).status,409);assert.equal(remote.state.subscriptions.size,1);
 assert.equal((await user.post('/api/billing/portal')).status,200);
 assert.equal((await admin.put('/api/admin/billing',await config({mode:'live',secretKey:'sk_live_anotherTestKey123'}))).status,409);
});
test('signed webhooks reject forgery, replay safely and ignore stale payload status when payment fails',async()=>{
 const forged=await fetch(stack.customerUrl+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'invalid'},body:'{}'});assert.equal(forged.status,400);
 assert.equal((await event('invoice.paid',{livemode:true},'evt_wrongmode')).status,400);
 sub.status='past_due';sub.latest_invoice.status='open';sub.latest_invoice.amount_remaining=1000;
 const r=await event();assert.equal(r.status,200,JSON.stringify(r.json));assert.equal((await detail()).account.paymentValid,false);
 const replay=await event();assert.equal(replay.json.duplicate,true);
 sub.status='active';sub.latest_invoice.status='paid';sub.latest_invoice.amount_remaining=0;
 assert.equal((await event('invoice.payment_failed',{},'evt_outoforder')).status,200);assert.equal((await detail()).account.paymentValid,true);
 const oldBody=JSON.stringify({id:'evt_old',type:'invoice.paid',livemode:false,data:{object:{}}});const signature=Stripe.webhooks.generateTestHeaderString({payload:oldBody,secret,timestamp:Math.floor(Date.now()/1000)-600});
 assert.equal((await fetch(stack.customerUrl+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:oldBody})).status,400);
});
test('subscription quantities reconcile once from reservations, preview drafts and invoices stay tenant scoped',async()=>{
 sql.prepare("INSERT INTO compute_allocations(id,vmid,customer_id,offering,started_at) VALUES('billing-increase',4343,?,?,datetime('now'))").run(customerId,JSON.stringify({sizeId:'small',storageClassId:'fast',diskGb:40,haEnabled:false}));
 const r=await refresh();assert.equal(r.status,200,r.text);assert.equal(r.json.account.paymentValid,true);assert.equal(sub.items.data.find(i=>i.price.metadata.panel_rate==='disk:fast').quantity,40);
 const count=remote.state.requests.filter(r=>r.path.includes('/subscriptions/')&&r.method==='POST').length;await refresh();assert.equal(remote.state.requests.filter(r=>r.path.includes('/subscriptions/')&&r.method==='POST').length,count);
 const draft=await user.post('/api/billing/drafts');assert.equal(draft.status,200,draft.text);assert.equal(draft.json.source,'stripe-preview');
 const invoices=await user.get('/api/billing/invoices');assert.equal(invoices.status,200);assert.equal(invoices.json.items.length,1);assert.ok(invoices.json.items[0].url.startsWith('https://invoice.stripe.com'));
 assert.equal((await other.get('/api/billing/invoices')).json.items.length,0);assert.equal((await user.get('/api/billing/invoices?after=not-a-cursor')).status,400);
});
test('SCA, cancellation, pause and overdue invoices deny payment validation; API outages fail closed',async()=>{
 sub.status='incomplete';assert.equal((await refresh()).json.account.paymentValid,false);
 sub.status='active';sub.cancel_at_period_end=true;assert.equal((await refresh()).json.account.paymentValid,false);sub.cancel_at_period_end=false;
 sub.pause_collection={behavior:'void'};assert.equal((await refresh()).json.account.paymentValid,false);delete sub.pause_collection;
 const due={id:'in_overdue',customer:sub.customer,livemode:false,status:'open',amount_remaining:100,currency:'usd',due_date:1};remote.state.invoices.set(due.id,due);assert.equal((await refresh()).json.account.paymentValid,false);remote.state.invoices.delete(due.id);
 remote.state.fail='/subscriptions/';assert.equal((await refresh()).status,502);assert.equal((await detail()).account.paymentValid,false);remote.state.fail=null;
 assert.equal((await refresh()).json.account.paymentValid,true);
});
test('payment admission protects actual catalog creates and add-ons while existing reads and deletion remain available', async () => {
 await stack.offerTemplates();
 stack.mock.perms['/vms'] = ['VM.Audit']; stack.mock.perms['/pool/customers'].push('Pool.Audit');
 stack.mock.cluster.nodes = [{node:'pve1',status:'online',maxcpu:32,maxmem:128*2**30,mem:2**30}];
 stack.mock.cluster.storageInventories = {pve1:[{storage:'VMStorage',content:'images,rootdir',active:1,enabled:1,shared:1,total:1000*2**30,avail:900*2**30}]};
 let catalog=(await admin.get('/api/admin/compute-catalog')).json;
 const c={revision:catalog.revision,sizes:catalog.sizes,classes:catalog.classes.map(({id,enabled,bindings})=>({id,enabled,bindings})),reserves:catalog.reserves};
 c.sizes.find(s=>s.id==='small').enabled=true;c.classes.find(s=>s.id==='basic').enabled=true;c.classes.find(s=>s.id==='basic').bindings=[{node:'pve1',storage:'VMStorage',purpose:'vm'}];
 let r=await admin.put('/api/admin/compute-catalog',c);assert.equal(r.status,200,r.text);
 const profile=(await admin.get(`/api/admin/customers/${customerId}/compute-profile`)).json;
 const {revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb}=profile;
 r=await admin.put(`/api/admin/customers/${customerId}/compute-profile`,{revision,tier,sizeIds,storageClassIds,haAllowed,backupServiceEnabled,storageLimitsGb,backupLimitGb,catalogRevision:r.json.revision,catalogEnabled:true,network:{bridge:'vmbr0',vlan:null,verified:true}});assert.equal(r.status,200,r.text);
 const spec={hostname:'paid-reservation',templateId:9000,sizeId:'small',storageClassId:'basic',diskGb:20,username:'debian',password:'compute-password-123'};
 const request=async()=>{const result=await fetch(user.base+'/api/vms',{method:'POST',headers:{cookie:[...user.cookies].map(([k,v])=>`${k}=${v}`).join('; '),'content-type':'application/json','idempotency-key':`paid-request-${Date.now()}`},body:JSON.stringify(spec)});return {status:result.status,json:await result.json()};};
 sub.status='past_due';r=await request();assert.equal(r.status,402,JSON.stringify(r.json));assert.equal(sql.prepare("SELECT count(*) n FROM compute_operations WHERE customer_id=?").get(customerId).n,0);
 let service=(await user.get('/api/compute-services')).json;r=await user.put('/api/compute-services',{revision:service.revision,backupServiceEnabled:true});assert.equal(r.status,402,r.text);
 sub.status='active';sub.latest_invoice.status='paid';r=await request();assert.equal(r.status,202,JSON.stringify(r.json));const vmid=r.json.vmid;
 const settled=await stack.serverSettled(user,vmid);assert.equal(settled.state,'ready',settled.error);
 assert.equal((await refresh()).json.account.paymentValid,true);
 stack.mock.vms.get(vmid).status='stopped';sub.status='past_due';
 assert.equal((await user.get(`/api/vms/${vmid}`)).status,200);
 r=await user.del(`/api/vms/${vmid}`);assert.equal(r.status,202,r.text);
 await waitFor(()=>!sql.prepare('SELECT 1 FROM compute_allocations WHERE vmid=? AND ended_at IS NULL').get(vmid));await refresh();assert.equal(sub.items.data.some(i=>i.price.metadata.panel_rate==='disk:basic'),false);
});
test('draft cursor pagination covers all history and rejects another customer’s cursor', async () => {
 for (let i=0;i<55;i++) sql.prepare('INSERT INTO billing_invoice_drafts(id,customer_id,created_at,document) VALUES(?,?,?,?)').run(randomUUID(),customerId,new Date(Date.now()-i*1000).toISOString(),JSON.stringify({source:'reservation-estimate',status:'draft',currency:'usd',totalMinor:100,lines:[]}));
 let page=(await user.get('/api/billing/drafts')).json, ids=new Set(page.items.map(i=>i.id));assert.equal(page.items.length,25);assert.equal(page.hasMore,true);
 const cursor=page.items.at(-1).id;assert.equal((await other.get(`/api/billing/drafts?before=${cursor}`)).status,404);
 while(page.hasMore){page=(await user.get(`/api/billing/drafts?before=${page.items.at(-1).id}`)).json;for(const item of page.items){assert.equal(ids.has(item.id),false);ids.add(item.id);}}
 assert.ok(ids.size>=55);assert.equal((await user.get('/api/billing/drafts?before=invalid')).status,400);
});
test('failed signed events and durable subscription updates retry after restart with the same idempotency key', async () => {
 const payload={items:[{id:sub.items.data[0].id,quantity:sub.items.data[0].quantity,price:sub.items.data[0].price.id}],proration_behavior:'always_invoice',payment_behavior:'allow_incomplete',expand:['latest_invoice','default_payment_method']};
 const request={id:randomUUID(),created:Date.now(),payload};sql.prepare('UPDATE billing_customers SET sync_request=? WHERE customer_id=?').run(JSON.stringify(request),customerId);
 remote.state.fail='/subscriptions/';const failed=await event('invoice.paid',{},'evt_retryAfterRestart');assert.equal(failed.status,502);assert.equal(sql.prepare("SELECT state FROM billing_webhook_events WHERE id='evt_retryAfterRestart'").get().state,'pending');assert.equal(JSON.parse(sql.prepare('SELECT sync_request FROM billing_customers WHERE customer_id=?').get(customerId).sync_request).id,request.id);
 remote.state.fail=null;await stack.restartPanel();admin=await stack.adminSession();
 const r=await event('invoice.paid',{},'evt_retryAfterRestart');assert.equal(r.status,200);assert.equal(sql.prepare('SELECT sync_request FROM billing_customers WHERE customer_id=?').get(customerId).sync_request,null);
 const calls=remote.state.requests.filter(r=>r.method==='POST'&&r.path.includes('/subscriptions/')&&r.idempotency?.endsWith(`sync:${request.id}`));assert.ok(calls.length>=1);assert.equal(new Set(calls.map(c=>c.idempotency)).size,1);
});
test('Stripe account and subscription ownership changes are rejected; real billing activation cannot hide unmanaged VMs',async()=>{
 const before=sub.metadata.panel_customer_id;sub.metadata.panel_customer_id='9999';assert.equal((await refresh()).status,409);assert.equal((await detail()).account.paymentValid,false);sub.metadata.panel_customer_id=before;
 const current=await config({secretKey:'sk_test_rotatedSimulator123'});assert.equal((await admin.put('/api/admin/billing',current)).status,200);remote.state.account='acct_wrong';assert.equal((await refresh()).status,409);remote.state.account='acct_testpanel';
 const guest=[...stack.mock.vms.values()].find(v=>!v.template&&v.vmid!==150);if(guest){await admin.put(`/api/admin/vms/${guest.vmid}`,{customerId});assert.equal((await user.post('/api/billing/checkout')).status,409);}
});
test('unreadable customer pools leave billing setup accessible and block activation and Checkout',async()=>{
 const input={name:'Pool billing',slug:'pool-billing',enabled:true,pools:['billing-private'],allowedDomains:[],sso:{groups:[],entitlements:[],match:'any',required:false},limits:{servers:0,cores:0,memoryMb:0,diskGb:0}};
 const created=await admin.post('/api/admin/customers',input);assert.equal(created.status,201,created.text);const id=created.json.id;
 assert.equal((await admin.get('/api/admin/billing')).status,200);
 const d=await admin.get(`/api/admin/customers/${id}/billing`);assert.equal(d.status,200,d.text);assert.equal(d.json.summary.inventoryVerified,false);
 const r=await admin.put(`/api/admin/customers/${id}/billing`,{required:true,email:'pool-billing@example.com'});assert.notEqual(r.status,200);
});
