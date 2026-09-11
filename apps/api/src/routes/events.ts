import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** SSE stream: `event: <type>` + `data: <SseEvent JSON>` (docs/API.md). */
export async function registerEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const id = ctx.sse.addClient(reply.raw);
    const drop = (): void => ctx.sse.removeClient(id);
    req.raw.on('close', drop);
    req.raw.on('error', drop);
    reply.raw.on('close', drop);
    reply.raw.on('error', drop);
  });
}
