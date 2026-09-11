import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorResponse } from '@fld/shared';
import { registerAuth } from './auth/index.js';
import type { AppContext } from './context.js';
import { ApiError } from './errors.js';
import { registerAdminDisplayRoutes } from './routes/admin/displays.js';
import { registerAdminOpsRoutes } from './routes/admin/ops.js';
import { registerAdminScheduleRoutes } from './routes/admin/schedule.js';
import { registerAdminSettingsRoutes } from './routes/admin/settings.js';
import { registerAdminStandardsRoutes } from './routes/admin/standards.js';
import { registerAdminUserRoutes } from './routes/admin/users.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerTvRoutes } from './routes/tv.js';

function errorBody(statusCode: number, error: string, message: string, issues?: unknown): ErrorResponse & { issues?: unknown } {
  return issues === undefined ? { error, message, statusCode } : { error, message, statusCode, issues };
}

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
  503: 'unavailable',
};

function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
}

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  });

  app.decorate('ctx', ctx);

  // Tolerate an empty body on POSTs that carry a JSON content type.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) =>
      errorBody(429, 'too_many_requests', `rate limit exceeded, retry in ${context.after}`),
  });

  registerAuth(app, ctx);

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400).send(errorBody(400, 'bad_request', 'validation failed', err.issues));
      return;
    }
    if (err instanceof ApiError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'request failed');
      reply.code(err.statusCode).send(errorBody(err.statusCode, err.code, err.message, err.details));
      return;
    }
    const anyErr = err as { validation?: unknown; statusCode?: number; code?: string };
    if (anyErr.validation) {
      reply.code(400).send(errorBody(400, 'bad_request', err.message, anyErr.validation));
      return;
    }
    const status = typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400 ? anyErr.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled request error');
    const dbDown = anyErr.code === 'ECONNREFUSED' || anyErr.code === '57P01' || anyErr.code === '08006';
    if (status >= 500 && dbDown) {
      reply.code(503).send(errorBody(503, 'unavailable', 'the database is unavailable'));
      return;
    }
    reply
      .code(status)
      .send(errorBody(status, codeForStatus(status), status >= 500 ? 'internal server error' : err.message));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody(404, 'not_found', `no route for ${req.method} ${req.url}`));
  });

  await registerHealthRoutes(app, ctx);
  await registerEventRoutes(app, ctx);
  await registerSetupRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await registerTvRoutes(app, ctx);
  await registerPortalRoutes(app, ctx);
  await registerAdminDisplayRoutes(app, ctx);
  await registerAdminScheduleRoutes(app, ctx);
  await registerAdminSettingsRoutes(app, ctx);
  await registerAdminStandardsRoutes(app, ctx);
  await registerAdminUserRoutes(app, ctx);
  await registerAdminOpsRoutes(app, ctx);

  return app;
}
