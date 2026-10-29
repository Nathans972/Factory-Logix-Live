import { loginSchema, type AuthMe, type OkResponse } from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { clearSessionCookie, setSessionCookie } from '../auth/index.js';
import { verifyPassword } from '../auth/password.js';
import type { AppContext } from '../context.js';
import { getUserWithHash, recordLogin, revokeSessions } from '../db/repo/users.js';
import { unauthorized } from '../errors.js';
import { parseWith } from '../util/query.js';

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply): Promise<AuthMe> => {
      const body = parseWith(loginSchema, req.body);
      const found = await getUserWithHash(ctx.db, body.username);
      const ok = found ? await verifyPassword(found.password_hash, body.password) : false;
      if (!found || !ok || !found.active) {
        req.log.warn({ username: body.username, ip: req.ip }, 'failed login');
        throw unauthorized('invalid username or password');
      }
      const { password_hash: _hash, session_version: sessionVersion, ...user } = found;
      await recordLogin(ctx.db, user.id);
      await setSessionCookie(reply, user, sessionVersion, ctx.env.sessionSecret);
      return { user: { ...user, last_login_at: Date.now() } };
    },
  );

  // Ends the user's sessions on the server as well (all of them: a cookie only holds a version, not an
  // id of its own), so a copy of this cookie taken before the logout stops working too.
  app.post('/api/auth/logout', async (req, reply): Promise<OkResponse> => {
    if (req.auth) await revokeSessions(ctx.db, req.auth.id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req): Promise<AuthMe> => ({ user: req.auth }));
}
