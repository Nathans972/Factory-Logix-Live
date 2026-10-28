import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Start the real entry point (src/index.ts) against a database URL and return what it logged. */
function runApi(databaseUrl: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: API_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 's'.repeat(48),
        ENCRYPTION_KEY: 'a1'.repeat(32),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('close', () => resolve(out));
  });
}

describe('api start-up when the database cannot be reached', () => {
  it('logs why: the operator sees the real error, not just "not reachable yet"', async () => {
    // Port 1 refuses connections immediately. A wrong password, a password that does not parse as a URL,
    // or a stale POSTGRES_PASSWORD after the first start all end up in the same log lines.
    const out = await runApi('postgres://fld:secret@127.0.0.1:1/fld', 3500);
    expect(out, 'the api started and tried the database').toMatch(/database not reachable yet/);
    expect(out, 'the log never says what went wrong (pingDb() reduces every error to false)').toMatch(/ECONNREFUSED/);
  }, 20_000);
});
