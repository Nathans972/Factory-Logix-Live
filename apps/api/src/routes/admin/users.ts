import { createUserSchema, updateUserSchema, type User } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import { hashPassword } from '../../auth/password.js';
import type { AppContext } from '../../context.js';
import { isUniqueViolation } from '../../db/pool.js';
import { countActiveAdmins, createUser, getUserById, listUsers, updateUser } from '../../db/repo/users.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parseWith, requireIdParam } from '../../util/query.js';

export async function registerAdminUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = { preHandler: requireRole('admin') };

  app.get('/api/admin/users', admin, async (): Promise<User[]> => listUsers(ctx.db));

  app.post('/api/admin/users', admin, async (req): Promise<User> => {
    const body = parseWith(createUserSchema, req.body);
    const hash = await hashPassword(body.password);
    try {
      const created = await createUser(ctx.db, { username: body.username, password_hash: hash, role: body.role });
      await audit(req, 'user.created', 'user', created.id, null, created);
      return created;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`user ${body.username} already exists`);
      throw err;
    }
  });

  app.patch('/api/admin/users/:id', admin, async (req): Promise<User> => {
    const id = requireIdParam((req.params as { id: string }).id);
    const body = parseWith(updateUserSchema, req.body);
    const before = await getUserById(ctx.db, id);
    if (!before) throw notFound('unknown user');

    // Never lock everyone out of the admin area.
    const losesAdmin = before.role === 'admin' && before.active && (body.active === false || (body.role && body.role !== 'admin'));
    if (losesAdmin && (await countActiveAdmins(ctx.db)) <= 1) {
      throw badRequest('cannot deactivate or demote the last active admin');
    }

    const passwordHash = body.password ? await hashPassword(body.password) : undefined;
    const updated = await updateUser(ctx.db, id, { role: body.role, active: body.active, password_hash: passwordHash });
    if (!updated) throw notFound('unknown user');
    await audit(req, 'user.updated', 'user', id, before, {
      ...updated,
      password_changed: Boolean(passwordHash),
    });
    return updated;
  });
}
