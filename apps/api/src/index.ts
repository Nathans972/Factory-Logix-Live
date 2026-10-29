/**
 * apps/api bootstrap: env -> database -> migrations -> settings seed -> SSE listener -> HTTP server.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { checkExtraCaFile } from '@fld/shared';
import { EnvError, loadEnv, type AppEnv } from './env.js';
import { createLogger } from './logger.js';
import { createPool, waitForDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seedSettingValue } from './db/repo/settings.js';
import { SseHub } from './sse.js';
import { buildServer } from './server.js';
import type { AppContext } from './context.js';

async function readVersion(env: AppEnv): Promise<string> {
  if (env.appVersion) return env.appVersion;
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env);
  const version = await readVersion(env);

  // FACTORYLOGIX_CA_CERT: Node skips a CA file it cannot use without saying so.
  const ca = checkExtraCaFile(process.env.NODE_EXTRA_CA_CERTS, (path) => readFileSync(path, 'latin1'));
  if (ca?.ok) log.info(ca.message);
  else if (ca) log.error(ca.message);

  const pool = createPool(env, log);
  await waitForDb(pool, log);
  await migrate(pool, env.migrationsDir, { info: (m) => log.info(m), warn: (m) => log.warn(m) });

  if (env.plantTimezone) {
    const seeded = await seedSettingValue(pool, 'plant_timezone', env.plantTimezone);
    if (seeded) log.info(`seeded plant_timezone = ${env.plantTimezone}`);
  }

  const sse = new SseHub(env.databaseUrl, log);
  await sse.start();

  const ctx: AppContext = { env, pool, db: pool, log, sse, version };
  const app = await buildServer(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await sse.stop();
      await pool.end();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.port, host: env.host });
  log.info(`api listening on http://${env.host}:${env.port} (version ${version})`);
}

main().catch((err) => {
  if (err instanceof EnvError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
