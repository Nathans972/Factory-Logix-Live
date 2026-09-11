import { createRequire } from 'node:module';
import { pino, type Logger } from 'pino';
import type { AppEnv } from './env.js';

export type { Logger };

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** Structured JSON logs in production; human-readable in dev when pino-pretty is installed. */
export function createLogger(env: Pick<AppEnv, 'logLevel' | 'nodeEnv'>): Logger {
  const level = env.logLevel || 'info';
  if (env.nodeEnv !== 'production' && prettyAvailable()) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino({ level });
}
