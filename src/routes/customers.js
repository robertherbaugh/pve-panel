import { applyCustomerRule } from '../expiry.js';
import { db, audit } from '../db.js';
import { config } from '../config.js';
import {
  allCustomers,
  customerById,
  saveCustomer,
  availableCustomers,
  customerContext,
  requireCustomerAdmin,
  customerMembers,
  setMembership,
  removeMembership,
  customerDeletionPlan,
  deleteCustomer,
} from '../tenancy.js';

const memberBody = {
  body: {
    type: 'object',
    required: ['userId', 'role'],
    additionalProperties: false,
    properties: {
      userId: { type: 'integer', minimum: 1 },
      role: { type: 'string', enum: ['member', 'viewer', 'operator', 'admin'] },
    },
  },
};
export async function adminCustomerRoutes(app) {
  app.addHook('preHandler', app.requireAdmin);
  app.get('/api/admin/customers', async () => ({ customers: allCustomers() }));
  app.post('/api/admin/customers', async (req, reply) => {
    const customer = saveCustomer(req.body);
    audit({ account: req.account, ip: req.ip, customer }, null, 'admin_customer_create', {
      customerId: customer.id,
      name: customer.name,
    });
    return reply.code(201).send(customer);
  });
  app.put('/api/admin/customers/:id', async (req) => {
    const customer = saveCustomer(req.body, Number(req.params.id));
    applyCustomerRule(null, customer.id);
    audit({ account: req.account, ip: req.ip, customer }, null, 'admin_customer_update', {
      customerId: customer.id,
      enabled: customer.enabled,
    });
    return customer;
  });
  app.get('/api/admin/customers/:id/deletion', async (req) =>
    customerDeletionPlan(Number(req.params.id)),
  );
  app.delete(
    '/api/admin/customers/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['revision'],
          additionalProperties: false,
          properties: { revision: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      deleteCustomer(req, Number(req.params.id), req.body.revision);
      return reply.code(204).send();
    },
  );
  app.get('/api/admin/customers/:id/members', async (req, reply) => {
    const customer = customerById(Number(req.params.id));
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    return { customer, members: customerMembers(customer.id) };
  });
  app.put('/api/admin/customers/:id/members', { schema: memberBody }, async (req) => {
    const id = Number(req.params.id);
    setMembership(id, req.body.userId, req.body.role);
    audit(
      { account: req.account, ip: req.ip, customer: customerById(id) },
      null,
      'admin_customer_member_set',
      req.body,
    );
    return { members: customerMembers(id) };
  });
  app.delete('/api/admin/customers/:id/members/:userId', async (req, reply) => {
    const id = Number(req.params.id),
      userId = Number(req.params.userId);
    if (!customerById(id)) return reply.code(404).send({ error: 'Customer not found' });
    // A removed manual membership must not become an unexpected SSO grant.
    removeMembership(id, userId);
    audit(
      { account: req.account, ip: req.ip, customer: customerById(id) },
      null,
      'admin_customer_member_remove',
      { userId },
    );
    return reply.code(204).send();
  });
  app.post('/api/admin/users/:id/disable', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.account.id) return reply.code(400).send({ error: 'You cannot disable your own account' });
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(id))
      return reply.code(404).send({ error: 'User not found' });
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(id);
    db.prepare('DELETE FROM oidc_authorizations WHERE user_id=?').run(id);
    audit(req, null, 'admin_user_disable', { userId: id });
    return { ok: true };
  });
  app.post('/api/admin/users/:id/enable', async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(id))
      return reply.code(404).send({ error: 'User not found' });
    db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(id);
    audit(req, null, 'admin_user_enable', { userId: id });
    return { ok: true };
  });
}
export async function customerContextRoutes(app) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/customers', async (req) => ({
    customers: availableCustomers(req).map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      role: c.role,
      source: c.membershipSource,
    })),
    selectedCustomerId: customerContext(req)?.id ?? null,
  }));
  app.post(
    '/api/customers/select',
    {
      schema: {
        body: {
          type: 'object',
          required: ['customerId'],
          additionalProperties: false,
          properties: { customerId: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const customer = availableCustomers(req).find((c) => c.id === req.body.customerId);
      if (!customer) return reply.code(404).send({ error: 'Customer not found' });
      const token = app.jwt.sign(
        { sub: req.account.id, scope: 'customer-context', customerId: customer.id },
        { expiresIn: '8h' },
      );
      reply.setCookie('panel_customer', token, {
        path: '/',
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'strict',
        maxAge: 8 * 3600,
      });
      audit({ account: req.account, ip: req.ip, customer }, null, 'customer_selected');
      return { id: customer.id, name: customer.name };
    },
  );
  app.get('/api/customer/members', async (req) => {
    const c = requireCustomerAdmin(req);
    return { customer: { id: c.id, name: c.name }, members: customerMembers(c.id) };
  });
  app.put(
    '/api/customer/members',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'role'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            role: memberBody.body.properties.role,
          },
        },
      },
    },
    async (req, reply) => {
      const c = requireCustomerAdmin(req);
      const user = db.prepare('SELECT id FROM users WHERE email=? AND disabled=0').get(req.body.email.trim());
      if (!user)
        return reply.code(404).send({ error: 'An active panel user with that address must exist first' });
      if (
        user.id === req.account.id &&
        req.body.role !== 'admin' &&
        !customerMembers(c.id).some(
          (m) => m.userId !== user.id && m.role === 'admin' && !m.disabled && m.source === 'manual',
        )
      )
        return reply
          .code(409)
          .send({ error: 'Add another customer administrator before changing your own role' });
      setMembership(c.id, user.id, req.body.role);
      audit({ account: req.account, ip: req.ip, customer: c }, null, 'customer_member_set', {
        userId: user.id,
        role: req.body.role,
      });
      return { members: customerMembers(c.id) };
    },
  );
  app.delete('/api/customer/members/:userId', async (req, reply) => {
    const c = requireCustomerAdmin(req),
      id = Number(req.params.userId);
    if (
      id === req.account.id &&
      !customerMembers(c.id).some(
        (m) => m.userId !== id && m.role === 'admin' && !m.disabled && m.source === 'manual',
      )
    )
      return reply
        .code(409)
        .send({ error: 'Add another customer administrator before removing your membership' });
    removeMembership(c.id, id);
    audit({ account: req.account, ip: req.ip, customer: c }, null, 'customer_member_remove', { userId: id });
    return reply.code(204).send();
  });
}
