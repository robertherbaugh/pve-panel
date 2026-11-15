// Stripe HTTP simulator: real SDK serialization and webhook signatures, no network billing.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
export async function startMockStripe() {
  const state = { account: 'acct_testpanel', customers: new Map(), prices: new Map(), sessions: new Map(), subscriptions: new Map(), invoices: new Map(), requests: [], fail: null, uncertainCheckout: false };
  const idem = new Map(); let n = 0;
  const id = prefix => `${prefix}_${++n}`;
  function decode(raw) {
    const out = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      const parts = key.match(/[^\[\]]+/g); let dest = out;
      for (let i = 0; i < parts.length - 1; i++) dest = dest[parts[i]] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
      dest[parts.at(-1)] = ['true','false'].includes(value) ? value === 'true' : /^\d+$/.test(value) && ['quantity','unit_amount','limit'].includes(parts.at(-1)) ? Number(value) : value;
    }
    return out;
  }
  state.complete = sessionId => {
    const session = state.sessions.get(sessionId), customer = state.customers.get(session.customer);
    const subscription = { id: id('sub'), object: 'subscription', livemode: false, customer: customer.id, metadata: session.subscription_data.metadata, status: 'active', cancel_at_period_end: false,
      default_payment_method: 'pm_test', items: { data: session.line_items.map(item => ({ id: id('si'), price: state.prices.get(item.price), quantity: Number(item.quantity), current_period_end: Math.floor(Date.now()/1000)+30*86400 })), has_more: false } };
    const invoice = { id: id('in'), object: 'invoice', livemode: false, customer: customer.id, currency: 'usd', status: 'paid', amount_due: 1000, amount_remaining: 0, total: 1000, amount_paid: 1000, hosted_invoice_url: 'https://invoice.stripe.com/i/test', created: Math.floor(Date.now()/1000) };
    subscription.latest_invoice = invoice; state.invoices.set(invoice.id, invoice); state.subscriptions.set(subscription.id, subscription);
    session.status = 'complete'; session.url = null; session.subscription = subscription.id; return subscription;
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const data = decode(raw), url = new URL(req.url,'http://localhost'), path = url.pathname, method = req.method;
    state.requests.push({ path, method, data, idempotency: req.headers['idempotency-key'] });
    const send = (v, status=200) => { res.writeHead(status, {'content-type':'application/json','request-id':randomUUID()}); res.end(JSON.stringify(v)); };
    if (state.fail && path.includes(state.fail)) return send({error:{message:'simulated billing outage',type:'api_error'}},503);
    const k = req.headers['idempotency-key'];
    if (k && idem.has(k)) return send(idem.get(k));
    let result;
    if (path === '/v1/account') result = { id:state.account, object:'account' };
    else if (path === '/v1/products' && method === 'POST') result = {id:id('prod'),...data,livemode:false};
    else if (path === '/v1/prices' && method === 'POST') { result={id:id('price'),object:'price',...data,livemode:false};state.prices.set(result.id,result); }
    else if (path === '/v1/customers' && method === 'POST') {result={id:id('cus'),object:'customer',...data,livemode:false,invoice_settings:{default_payment_method:'pm_test'}};state.customers.set(result.id,result);}
    else if (/^\/v1\/customers\//.test(path)) {result=state.customers.get(path.split('/').at(-1));if(result && method==='POST')Object.assign(result,data);}
    else if (path === '/v1/checkout/sessions' && method === 'POST') {result={id:id('cs'),object:'checkout.session',...data,livemode:false,status:'open',url:'https://checkout.stripe.com/c/test'};state.sessions.set(result.id,result);}
    else if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(path)) {result=state.sessions.get(path.split('/').at(-2));if(result)result.status='expired';}
    else if (/^\/v1\/checkout\/sessions\//.test(path)) result=state.sessions.get(path.split('/').at(-1));
    else if (/^\/v1\/subscriptions\//.test(path)) {
      result=state.subscriptions.get(path.split('/').at(-1));
      if(result && method==='POST') for(const update of data.items ?? []) {
        if(update.deleted) result.items.data=result.items.data.filter(i=>i.id!==update.id);
        else {const existing=result.items.data.find(i=>i.id===update.id);if(existing)existing.quantity=Number(update.quantity);else result.items.data.push({id:id('si'),price:state.prices.get(update.price),quantity:Number(update.quantity),current_period_end:Math.floor(Date.now()/1000)+30*86400});}
      }
    }
    else if (path === '/v1/invoices/create_preview') {const sub=state.subscriptions.get(data.subscription);result={id:id('upcoming_in'),object:'invoice',livemode:false,customer:data.customer,currency:'usd',subtotal:1000,total:1000,lines:{data:sub.items.data.map(i=>({id:id('il'),description:i.price.metadata.panel_rate,quantity:i.quantity,amount:i.quantity*i.price.unit_amount})),has_more:false}};state.invoices.set(result.id,result);}
    else if (/^\/v1\/invoices\/[^/]+\/lines$/.test(path)) result={object:'list',url:path,...state.invoices.get(path.split('/').at(-2))?.lines};
    else if (path === '/v1/invoices') result={object:'list',url:path,has_more:false,data:[...state.invoices.values()].filter(i=>i.customer===url.searchParams.get('customer')&&!i.id.startsWith('upcoming_')&&(!url.searchParams.get('status')||i.status===url.searchParams.get('status')))};
    else if (path === '/v1/billing_portal/configurations') result={id:id('bpc'),...data};
    else if (path === '/v1/billing_portal/sessions') result={id:id('bps'),url:'https://billing.stripe.com/p/session/test',...data};
    if (!result) return send({error:{type:'invalid_request_error',message:`Unknown simulated Stripe resource ${method} ${path}`}},404);
    // Capture an immutable idempotent response, as Stripe does at request completion.
    if(k)idem.set(k,structuredClone(result));
    if(state.uncertainCheckout && path==='/v1/checkout/sessions' && method==='POST') {state.uncertainCheckout=false;req.socket.destroy();return;}
    send(result);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:()=>new Promise(r=>server.close(r))};
}
