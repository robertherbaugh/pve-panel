import { randomUUID } from 'node:crypto';
import { db, audit } from './db.js';
import { authorizedRow, authorizationFor, customerHasGuest } from './access.js';
import { requireCustomer, customerById } from './tenancy.js';
import { clusterGuests } from './pve.js';
import { assertComputeIdle } from './compute-state.js';
import { capacityBusy } from './capacity.js';
import { withPrivateAccessSetup } from './private-access-guard.js';
import {
  zitiSettings,
  zitiError,
  withController,
  assertScopedController,
} from './openziti-controller.js';

const service = (id) =>
  db.prepare('SELECT * FROM openziti_services WHERE id=?').get(id);
const grant = (id) =>
  db.prepare('SELECT * FROM openziti_grants WHERE id=?').get(id);
const now = () => Math.floor(Date.now() / 1000);
let queue = Promise.resolve();
export function zitiLock(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
const objectName = (owner, suffix) =>
  `panel-${zitiSettings().instanceId}-${owner}-${suffix}`;
const owned = (client, entity, name, owner) => {
  if (
    entity.name !== name ||
    entity.tags?.panelInstance !== client.settings.instanceId ||
    entity.tags?.panelOwner !== owner
  )
    throw zitiError(
      'Controller object ownership does not match this panel. Provider review is required.',
      409,
    );
  return entity;
};
async function find(client, type, name, owner) {
  const rows = await client.list(type, `name="${name}"`);
  if (rows.length > 1)
    throw zitiError(
      'Duplicate managed controller object. Provider review is required.',
      409,
    );
  return rows.length ? owned(client, rows[0], name, owner) : null;
}
async function ensure(client, owner, suffix, type, body) {
  const name = objectName(owner, suffix);
  db.prepare(
    'INSERT OR IGNORE INTO openziti_objects(name,owner_id,type) VALUES(?,?,?)',
  ).run(name, owner, type);
  let row = await find(client, type, name, owner);
  if (!row) {
    try {
      const result = await client.request('POST', `/${type}`, {
        ...body,
        name,
        tags: { panelInstance: client.settings.instanceId, panelOwner: owner },
      });
      if (typeof result?.id !== 'string')
        throw zitiError(
          'Controller creation outcome needs reconciliation',
          502,
        );
      row = { id: result.id };
    } catch (err) {
      // A definite rejected request did not create an object. Unknown outcomes retain their durable name.
      if (/HTTP (400|401|403|404|422)$/.test(err.message))
        db.prepare(
          'DELETE FROM openziti_objects WHERE name=? AND remote_id IS NULL',
        ).run(name);
      throw err;
    }
  }
  db.prepare('UPDATE openziti_objects SET remote_id=? WHERE name=?').run(
    row.id,
    name,
  );
  return row.id;
}
async function identity(client, owner) {
  return ensure(client, owner, 'identity', 'identities', {
    type: 'Device',
    isAdmin: false,
    roleAttributes: [],
    enrollment: { ott: true },
  });
}
async function cleanup(client, owner) {
  const objects = db
    .prepare(
      "SELECT * FROM openziti_objects WHERE owner_id=? ORDER BY CASE type WHEN 'service-policies' THEN 0 WHEN 'edge-router-policies' THEN 1 WHEN 'service-edge-router-policies' THEN 1 WHEN 'identities' THEN 2 WHEN 'services' THEN 3 WHEN 'configs' THEN 4 ELSE 2 END",
    )
    .all(owner);
  for (const o of objects) {
    const entity = o.remote_id
      ? await client.request(
          'GET',
          `/${o.type}/${encodeURIComponent(o.remote_id)}`,
          undefined,
          { missing: true },
        )
      : await find(client, o.type, o.name, o.owner_id);
    if (!entity && !o.remote_id)
      throw zitiError(
        'An unknown controller creation outcome needs provider reconciliation. Retry setup before removal.',
        409,
      );
    if (entity) {
      owned(client, entity, o.name, o.owner_id);
      await client.request(
        'DELETE',
        `/${o.type}/${encodeURIComponent(entity.id)}`,
        undefined,
        { missing: true },
      );
    }
    db.prepare('DELETE FROM openziti_objects WHERE name=?').run(o.name);
  }
}
async function routerPolicy(client, owner, identityId) {
  return ensure(client, owner, 'routers', 'edge-router-policies', {
    semantic: 'AllOf',
    identityRoles: [`@${identityId}`],
    edgeRouterRoles: [`#${client.settings.routerRole}`],
  });
}
function enabled() {
  if (!zitiSettings().enabled)
    throw zitiError('OpenZiti enrollment is disabled', 409);
}
async function authorize(req, vmid, action) {
  if (req.user?.az && !authorizationFor(req))
    throw zitiError(
      'Refresh your SSO authorization before using private access',
      403,
    );
  requireCustomer(req);
  const row = await authorizedRow(req, Number(vmid), action);
  if (row.state !== 'ready')
    throw zitiError('Wait until the server operation finishes', 409);
  const guest = (await clusterGuests()).get(Number(vmid));
  if (!guest || guest.template) throw zitiError('Server not found', 404);
  return guest;
}
async function scoped(req, id, action) {
  const s = service(id);
  if (!s || s.customer_id !== requireCustomer(req).id)
    throw zitiError('Service not found', 404);
  await authorize(req, s.vmid, action);
  return s;
}
async function enrollment(client, owner) {
  const object = db
    .prepare(
      "SELECT * FROM openziti_objects WHERE owner_id=? AND type='identities'",
    )
    .get(owner);
  if (!object?.remote_id)
    throw zitiError('Identity setup needs reconciliation', 409);
  const data = owned(
    client,
    await client.request(
      'GET',
      `/identities/${encodeURIComponent(object.remote_id)}`,
    ),
    object.name,
    owner,
  );
  const ott = data.enrollment?.ott;
  if (!ott?.jwt || Date.parse(ott.expiresAt) <= Date.now())
    throw zitiError(
      'The enrollment was consumed or expired. Revoke and create a new identity.',
      409,
    );
  return { jwt: ott.jwt, expiresAt: ott.expiresAt, filename: `${owner}.jwt` };
}
export function zitiOverview() {
  return {
    settings: zitiSettings(),
    services: db
      .prepare(
        `SELECT s.*,c.name AS customerName,
 (SELECT count(*) FROM openziti_grants g WHERE g.service_id=s.id) AS grants FROM openziti_services s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.created_at DESC`,
      )
      .all(),
    grants: db
      .prepare(
        'SELECT id,service_id,user_id,expires_at,state,error FROM openziti_grants',
      )
      .all(),
  };
}
export async function vmZitiAccess(req, vmid) {
  await authorize(req, vmid, 'private-access.read');
  const settings = zitiSettings();
  const rows = db
    .prepare('SELECT * FROM openziti_services WHERE customer_id=? AND vmid=?')
    .all(req.customer.id, vmid);
  return {
    enabled: settings.enabled,
    configured: settings.configured,
    services: rows.map((s) => ({
      ...s,
      grants: db
        .prepare(
          'SELECT id,expires_at,state,error FROM openziti_grants WHERE service_id=? AND user_id=?',
        )
        .all(s.id, req.account.id),
    })),
  };
}
export function createZitiService(req, vmid, kind) {
  return zitiLock(async () => {
    return withPrivateAccessSetup(vmid, async () => {
      enabled();
      await authorize(req, vmid, 'private-access.manage');
      assertComputeIdle(vmid);
      if (capacityBusy(req.customer.id))
        throw zitiError(
          'Wait until this customer’s compute operation finishes',
          409,
        );
      if (!['ssh', 'rdp'].includes(kind)) throw zitiError('Choose SSH or RDP');
      const customerId = req.customer.id;
      let row = db
        .prepare(
          'SELECT * FROM openziti_services WHERE customer_id=? AND vmid=? AND kind=?',
        )
        .get(customerId, vmid, kind);
      if (row?.state === 'revoking')
        throw zitiError('Service revocation is pending', 409);
      if (!row) {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO openziti_services VALUES(?,?,?,?,?,'pending',NULL,?)",
        ).run(
          id,
          customerId,
          vmid,
          kind,
          `vm-${vmid}-${kind}.customer-${customerId}.pve.ziti`,
          now(),
        );
        row = service(id);
      }
      try {
        await withController(async (c) => {
          await assertScopedController(c);
          const types = await c.list(
            'config-types',
            'name="host.v1" or name="intercept.v1"',
          );
          const type = (name) => {
            const id = types.find((t) => t.name === name)?.id;
            if (!id) throw zitiError(`Missing ${name} config type`, 502);
            return id;
          };
          const port = kind === 'ssh' ? 22 : 3389;
          const host = await ensure(c, row.id, 'host', 'configs', {
            configTypeId: type('host.v1'),
            data: { protocol: 'tcp', address: '127.0.0.1', port },
          });
          const intercept = await ensure(c, row.id, 'intercept', 'configs', {
            configTypeId: type('intercept.v1'),
            data: {
              protocols: ['tcp'],
              addresses: [row.hostname],
              portRanges: [{ low: port, high: port }],
            },
          });
          const serviceId = await ensure(c, row.id, 'service', 'services', {
            encryptionRequired: true,
            configs: [host, intercept],
            roleAttributes: [],
          });
          const hostId = await identity(c, row.id);
          await routerPolicy(c, row.id, hostId);
          await ensure(
            c,
            row.id,
            'service-routers',
            'service-edge-router-policies',
            {
              semantic: 'AllOf',
              serviceRoles: [`@${serviceId}`],
              edgeRouterRoles: [`#${c.settings.routerRole}`],
            },
          );
          await authorize(req, vmid, 'private-access.manage');
          await ensure(c, row.id, 'bind', 'service-policies', {
            type: 'Bind',
            semantic: 'AllOf',
            serviceRoles: [`@${serviceId}`],
            identityRoles: [`@${hostId}`],
          });
          await authorize(req, vmid, 'private-access.manage');
        });
        db.prepare(
          "UPDATE openziti_services SET state='ready',error=NULL WHERE id=?",
        ).run(row.id);
        audit(req, vmid, 'openziti_service_created', {
          serviceId: row.id,
          kind,
        });
        return service(row.id);
      } catch (err) {
        db.prepare(
          'UPDATE openziti_services SET state=?,error=? WHERE id=?',
        ).run(
          [403, 404].includes(err.statusCode) ? 'revoking' : 'error',
          err.message,
          row.id,
        );
        throw err;
      }
    });
  });
}
export function hostEnrollment(req, id) {
  return zitiLock(async () => {
    enabled();
    const s = await scoped(req, id, 'private-access.manage');
    if (s.state !== 'ready') throw zitiError('Finish service setup first', 409);
    const result = await withController((c) => enrollment(c, id));
    await scoped(req, id, 'private-access.manage');
    audit(req, s.vmid, 'openziti_host_enrollment', { serviceId: id });
    return result;
  });
}
export function createZitiGrant(req, id) {
  return zitiLock(async () => {
    enabled();
    const s = await scoped(req, id, 'private-access.read');
    if (s.state !== 'ready') throw zitiError('Service is not ready', 409);
    if (
      db
        .prepare(
          'SELECT 1 FROM openziti_grants WHERE service_id=? AND user_id=?',
        )
        .get(id, req.account.id)
    )
      throw zitiError(
        'Renew or revoke your existing access before creating another identity',
        409,
      );
    const gid = randomUUID(),
      expires = Math.min(
        now() + 900,
        authorizationFor(req)?.expiresAt ?? Infinity,
      );
    db.prepare(
      "INSERT INTO openziti_grants VALUES(?,?,?,?,?,'pending',NULL)",
    ).run(gid, id, req.account.id, req.user?.az ?? null, expires);
    try {
      const result = await withController(async (c) => {
        await assertScopedController(c);
        const identityId = await identity(c, gid);
        await routerPolicy(c, gid, identityId);
        const target = db
          .prepare(
            "SELECT remote_id FROM openziti_objects WHERE owner_id=? AND type='services'",
          )
          .get(id);
        await scoped(req, id, 'private-access.read');
        await ensure(c, gid, 'dial', 'service-policies', {
          type: 'Dial',
          semantic: 'AllOf',
          serviceRoles: [`@${target.remote_id}`],
          identityRoles: [`@${identityId}`],
        });
        await scoped(req, id, 'private-access.read');
        return enrollment(c, gid);
      });
      db.prepare("UPDATE openziti_grants SET state='active' WHERE id=?").run(
        gid,
      );
      audit(req, s.vmid, 'openziti_access_granted', {
        grantId: gid,
        expiresAt: expires,
      });
      return { ...result, id: gid, accessExpiresAt: expires };
    } catch (err) {
      db.prepare(
        "UPDATE openziti_grants SET state='revoking',error=? WHERE id=?",
      ).run(err.message, gid);
      throw err;
    }
  });
}
export function renewZitiGrant(req, id) {
  return zitiLock(async () => {
    enabled();
    const g = grant(id);
    if (!g || g.user_id !== req.account.id)
      throw zitiError('Access identity not found', 404);
    const s = await scoped(req, g.service_id, 'private-access.read');
    if (g.state !== 'active' || g.expires_at <= now())
      throw zitiError('Access expired. Revoke it and enroll again.', 409);
    await withController(async (c) => {
      await assertScopedController(c);
      const o = db
        .prepare(
          "SELECT * FROM openziti_objects WHERE owner_id=? AND type='identities'",
        )
        .get(id);
      owned(
        c,
        await c.request(
          'GET',
          `/identities/${encodeURIComponent(o.remote_id)}`,
        ),
        o.name,
        id,
      );
    });
    await scoped(req, s.id, 'private-access.read');
    const expires = Math.min(
      now() + 900,
      authorizationFor(req)?.expiresAt ?? Infinity,
    );
    db.prepare(
      'UPDATE openziti_grants SET expires_at=?,authorization_id=? WHERE id=?',
    ).run(expires, req.user?.az ?? null, id);
    audit(req, s.vmid, 'openziti_access_renewed', {
      grantId: id,
      expiresAt: expires,
    });
    return { id, accessExpiresAt: expires };
  });
}
async function removeGrant(client, g) {
  await cleanup(client, g.id);
  db.prepare('DELETE FROM openziti_grants WHERE id=?').run(g.id);
}
export function revokeZitiGrant(req, id) {
  return zitiLock(async () => {
    const g = grant(id);
    if (
      !g ||
      g.user_id !== req.account.id ||
      service(g.service_id)?.customer_id !== requireCustomer(req).id
    )
      throw zitiError('Access identity not found', 404);
    db.prepare("UPDATE openziti_grants SET state='revoking' WHERE id=?").run(
      id,
    );
    await withController((c) => removeGrant(c, g));
    audit(req, service(g.service_id)?.vmid, 'openziti_access_revoked', {
      grantId: id,
    });
    return { ok: true };
  });
}
export async function removeZitiService(id) {
  const s = service(id);
  if (!s) return;
  db.prepare("UPDATE openziti_services SET state='revoking' WHERE id=?").run(
    id,
  );
  try {
    await withController(async (c) => {
      for (const g of db
        .prepare('SELECT * FROM openziti_grants WHERE service_id=?')
        .all(id))
        await removeGrant(c, g);
      await cleanup(c, id);
    });
    db.prepare('DELETE FROM openziti_services WHERE id=?').run(id);
  } catch (err) {
    db.prepare('UPDATE openziti_services SET error=? WHERE id=?').run(
      err.message,
      id,
    );
    throw err;
  }
}
export function deleteZitiService(req, id, { admin = false } = {}) {
  return zitiLock(async () => {
    const s = !admin
      ? await scoped(req, id, 'private-access.manage')
      : service(id);
    await removeZitiService(id);
    if (!admin)
      audit(req, s.vmid, 'openziti_service_removed', { serviceId: id });
    return { ok: true };
  });
}
export function reconcileZitiAccess() {
  return zitiLock(async () => {
    if (!db.prepare('SELECT 1 FROM openziti_services LIMIT 1').get()) return;
    for (const g of db.prepare('SELECT * FROM openziti_grants').all()) {
      let valid =
        zitiSettings().enabled && g.state === 'active' && g.expires_at > now();
      const s = service(g.service_id);
      if (valid)
        try {
          const req = {
            account: { id: g.user_id },
            user: { az: g.authorization_id },
            selectedCustomerId: s.customer_id,
          };
          await authorize(req, s.vmid, 'private-access.read');
        } catch {
          valid = false;
        }
      if (!valid) {
        db.prepare(
          "UPDATE openziti_grants SET state='revoking' WHERE id=?",
        ).run(g.id);
        try {
          await withController((c) => removeGrant(c, g));
        } catch (err) {
          db.prepare('UPDATE openziti_grants SET error=? WHERE id=?').run(
            err.message,
            g.id,
          );
        }
      }
    }
    for (const s of db.prepare('SELECT * FROM openziti_services').all()) {
      const c = customerById(s.customer_id);
      const assignment = db
        .prepare('SELECT customer_id,state FROM vms WHERE vmid=?')
        .get(s.vmid);
      let keep =
        zitiSettings().enabled &&
        c?.enabled &&
        s.state !== 'revoking' &&
        (!assignment ||
          (assignment.customer_id === s.customer_id &&
            assignment.state === 'ready'));
      if (keep)
        try {
          keep = await customerHasGuest(
            c,
            (await clusterGuests()).get(s.vmid),
            assignment,
          );
        } catch {
          keep = false;
        }
      if (!keep)
        try {
          await removeZitiService(s.id);
        } catch {
          /* Durable revocation is retried. */
        }
    }
  });
}
export function startZitiReconciliation(log) {
  const run = () =>
    reconcileZitiAccess().catch(() =>
      log.warn('OpenZiti reconciliation needs provider attention'),
    );
  const timer = setInterval(run, 30000);
  timer.unref();
  void run();
}
