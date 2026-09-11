/** Structured JSON logging (pretty in development). Spec 14 observability. */
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  if (opts.pretty) {
    try {
      return pino({
        level: opts.level,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
      });
    } catch {
      // pino-pretty not installed (production image) -- fall through to JSON.
    }
  }
  return pino({ level: opts.level, base: { service: 'collector' } });
}

/** Reduce an unknown thrown value to a loggable/persistable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
