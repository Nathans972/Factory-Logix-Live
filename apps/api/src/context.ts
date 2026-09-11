import type { Pool } from 'pg';
import type { AppEnv } from './env.js';
import type { Db } from './db/pool.js';
import type { Logger } from './logger.js';
import type { SseHub } from './sse.js';

export interface AppContext {
  env: AppEnv;
  pool: Pool;
  db: Db;
  log: Logger;
  sse: SseHub;
  version: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
