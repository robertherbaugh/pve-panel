import crypto from 'node:crypto';
import WebSocket from 'ws';
import { db, audit } from '../db.js';
import { config } from '../config.js';
import { pve, locateGuest, guestPath, authHeader, tlsOptions } from '../pve.js';
import { authorizedRow, authorizationFor } from '../access.js';

// One-time console sessions. A session is created by the POST route and
// consumed by the first websocket connection that presents its id.
const sessions = new Map();
const SESSION_TTL_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
}, 10_000).unref();

export default async function consoleRoutes(app) {
  // Step 1: ask Proxmox for a VNC ticket
  app.post('/api/vms/:vmid/console', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const vmid = Number(req.params.vmid);
    const row = await authorizedRow(req, vmid, 'console');
    if (row.state !== 'ready') return reply.code(409).send({ error: 'This server is not ready yet' });
    const guest = await locateGuest(vmid);
    const live=await pve.get(`${guestPath(guest)}/status/current`);
    if (live.status !== 'running') {
      return reply.code(409).send({ error: 'Start the server to open its console' });
    }

    const vnc = await pve.post(`${guestPath(guest)}/vncproxy`, { websocket: 1 });
    const id = crypto.randomBytes(24).toString('base64url');
    sessions.set(id, {
      userId: req.account.id, customerId:req.customer?.id,
      guest,
      port: vnc.port,
      ticket: vnc.ticket,
      expires: Date.now() + SESSION_TTL_MS,
    });
    audit(req, vmid, 'console_open');

    // noVNC uses the Proxmox ticket as the VNC password.
    return { session: id, password: vnc.ticket, name: guest.name };
  });

  // Step 2: browser websocket <-> Proxmox vncwebsocket
  app.get('/api/console/:session', {
    websocket: true,
    preHandler: app.authenticate,
  }, async (client, req) => {
    const s = sessions.get(req.params.session);
    sessions.delete(req.params.session);

    if (!s || s.userId !== req.account.id || s.customerId!==req.customer?.id || s.expires < Date.now()) {
      client.close(4001, 'Console session expired');
      return;
    }
    let row;
    try { row = await authorizedRow(req, s.guest.vmid, 'console'); }
    catch { client.close(4001, 'Console access expired'); return; }

    if (client.readyState !== WebSocket.OPEN) return;

    const upstreamUrl = new URL(`${config.pve.url}${'/api2/json'}${guestPath(s.guest)}/vncwebsocket`);
    upstreamUrl.protocol = upstreamUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    upstreamUrl.searchParams.set('port', String(s.port));
    upstreamUrl.searchParams.set('vncticket', s.ticket);

    const upstream = new WebSocket(upstreamUrl, ['binary'], {
      headers: { Authorization: authHeader },
      ...tlsOptions,
    });

    // Anything the browser sends before Proxmox is ready is queued.
    const queue = [];
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queue.push([data, isBinary]);
    });

    upstream.on('open', () => {
      for (const [data, isBinary] of queue) upstream.send(data, { binary: isBinary });
      queue.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    let timer;
    let leaseTimer;
    const closeBoth = () => {
      clearInterval(timer);
      clearTimeout(leaseTimer);
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    };
    let checking = false;
    timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const user = db.prepare('SELECT deleting,disabled FROM users WHERE id=?').get(req.account.id);
        if (!user || user.deleting || user.disabled) throw new Error('Account revoked');
        await authorizedRow(req, s.guest.vmid, 'console');
      } catch { closeBoth(); }
      finally { checking = false; }
    }, 5000);
    timer.unref();
    if (authorizationFor(req)) {
      const expires = authorizationFor(req)?.expiresAt ?? 0;
      leaseTimer = setTimeout(closeBoth, Math.max(0, expires * 1000 - Date.now()));
      leaseTimer.unref();
    }
    upstream.on('close', closeBoth);
    upstream.on('error', (err) => {
      req.log.warn({ err, vmid: s.guest.vmid }, 'console upstream error');
      closeBoth();
    });
    client.on('close', closeBoth);
    client.on('error', closeBoth);
  });
}
