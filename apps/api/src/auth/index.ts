/**
 * Session cookie handling + `requireRole` preHandlers.
 *
 * The onRequest hook resolves `req.auth` from the `fld_session` cookie on every request (loading the
 * user so deactivated accounts lose access immediately). A cookie also has to carry the user's current
 * `session_version`, which logout, a password reset and deactivation bump, so those end every session
 * the user already has, copies of the cookie included. Routes opt in with `requireRole(...)`.
 */
import type { Role, User } from '@fld/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../errors.js';
import { getSessionUser } from '../db/repo/users.js';
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
      const found = await getSessionUser(ctx.db, payload.userId);
      // Signed before the user's last logout, password reset or deactivation: no longer counts.
      const current = found?.sessionVersion === (payload.sessionVersion ?? 0);
      if (found && current && found.user.active) req.auth = found.user;
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

export async function setSessionCookie(
  reply: FastifyReply,
  user: User,
  sessionVersion: number,
  secret: string,
): Promise<void> {
  const token = await signSession({ userId: user.id, role: user.role, sessionVersion }, secret);
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
