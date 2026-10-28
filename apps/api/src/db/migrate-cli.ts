/** `pnpm --filter @fld/api migrate` — apply pending migrations and exit. */
import { loadEnv } from '../env.js';
import { createLogger } from '../logger.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env);
  const pool = createPool(env, log);
  try {
    const applied = await migrate(
      pool,
      env.migrationsDir,
      { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    );
    log.info({ applied }, 'migrations complete');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
