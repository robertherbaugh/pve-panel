import http from 'node:http';
import { randomUUID } from 'node:crypto';
export async function startMockZiti() {
  const objects = new Map(),
    calls = [],
    token = 'controller-session-not-an-enrollment',
    secret = 'management-secret-not-in-database';
  for (const type of [
    'identities',
    'configs',
    'services',
    'service-policies',
    'edge-router-policies',
    'service-edge-router-policies',
  ])
    objects.set(type, new Map());
  let failDelete = false,
    redirect = false,
    invalidOwner = false,
    dropCreateType = null,
    pauseCreate = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'),
      path = url.pathname.replace('/edge/management/v1', ''),
      parts = path.split('/').filter(Boolean);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path, body });
    const send = (status, data) => {
      const total = Array.isArray(data) ? data.length : 1,
        offset = Number(url.searchParams.get('offset') || 0),
        limit = Number(url.searchParams.get('limit') || 100);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: Array.isArray(data) ? data.slice(offset, offset + limit) : data,
          meta: { pagination: { totalCount: total, limit, offset } },
        }),
      );
    };
    if (redirect) {
      res.writeHead(302, { location: 'http://127.0.0.1:9/leak' });
      res.end();
      return;
    }
    if (path === '/authenticate') {
      if (body?.password !== secret) return send(401, null);
      return send(200, { token, identity: { id: 'admin' } });
    }
    if (req.headers['zt-session'] !== token) return send(401, null);
    if (path === '/current-identity')
      return send(200, { id: 'admin', isAdmin: true });
    if (path === '/current-api-session' && req.method === 'DELETE')
      return send(200, {});
    if (path === '/config-types')
      return send(200, [
        { id: 'host-type', name: 'host.v1' },
        { id: 'intercept-type', name: 'intercept.v1' },
      ]);
    if (path === '/edge-routers')
      return send(200, [
        {
          id: 'customer-router',
          isOnline: true,
          roleAttributes: ['rcadea-customers'],
        },
      ]);
    const bucket = objects.get(parts[0]);
    if (!bucket) return send(404, null);
    if (req.method === 'GET' && parts.length === 1) {
      const name = /name="([^"]+)"/.exec(
        url.searchParams.get('filter') || '',
      )?.[1];
      return send(
        200,
        [...bucket.values()].filter((o) => !name || o.name === name),
      );
    }
    if (req.method === 'GET') {
      const o = bucket.get(parts[1]);
      return send(
        o ? 200 : 404,
        o
          ? {
              ...o,
              ...(invalidOwner
                ? { tags: { panelInstance: 'another-panel' } }
                : {}),
            }
          : null,
      );
    }
    if (req.method === 'POST') {
      if (pauseCreate) await pauseCreate;
      if ([...bucket.values()].some((o) => o.name === body.name))
        return send(409, null);
      const id = randomUUID(),
        o = { ...body, id };
      if (parts[0] === 'identities')
        o.enrollment = {
          ott: {
            jwt: `secret-enrollment-${id}`,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      bucket.set(id, o);
      if (dropCreateType === parts[0]) {
        dropCreateType = null;
        res.destroy();
        return;
      }
      return send(201, { id });
    }
    if (req.method === 'DELETE') {
      if (failDelete) return send(503, { message: secret });
      const had = bucket.delete(parts[1]);
      return send(had ? 200 : 404, {});
    }
    send(400, null);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    secret,
    objects,
    calls,
    set failDelete(v) {
      failDelete = v;
    },
    set redirect(v) {
      redirect = v;
    },
    set invalidOwner(v) {
      invalidOwner = v;
    },
    set dropCreateType(v) {
      dropCreateType = v;
    },
    set pauseCreate(v) {
      pauseCreate = v;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
