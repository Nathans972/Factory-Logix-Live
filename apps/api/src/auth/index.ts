/**
 * Session cookie handling + `requireRole` preHandlers.
 *
 * The onRequest hook resolves `req.auth` from the `fld_session` cookie on every request (loading the
 * user so deactivated accounts lose access immediately). Routes opt in with `requireRole(...)`.
 */
import type { Role, User } from '@fld/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { getUserById } from '../db/repo/users.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, roleAtLeast, signSession, verifySession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: User | null;
  }
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.auth = null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return;
    const payload = await verifySession(token, ctx.env.sessionSecret);
    if (!payload) return;
    try {
      const user = await getUserById(ctx.db, payload.userId);
      if (user && user.active) req.auth = user;
    } catch (err) {
      req.log.warn({ err }, 'failed to load session user');
    }
  });
}

export function requireRole(required: Role) {
  return async function roleGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.auth) throw unauthorized();
    if (!roleAtLeast(req.auth.role, required)) throw forbidden(`requires role ${required}`);
  };
}

export async function setSessionCookie(reply: FastifyReply, user: User, secret: string): Promise<void> {
  const token = await signSession({ userId: user.id, role: user.role }, secret);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, roleAtLeast };
