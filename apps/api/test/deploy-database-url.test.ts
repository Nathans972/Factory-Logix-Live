import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadEnv as loadCollectorEnv } from '../../collector/src/env.js';
import { loadEnv } from '../src/env.js';

const COMPOSE = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** The `environment:` entries of one compose service, as written (uninterpolated). */
function serviceEnvironment(service: string): Record<string, string> {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in docker-compose.yml`);
  const out: Record<string, string> = {};
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // next service
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    if (inEnv) {
      const m = /^ {6}([A-Z_]+):\s*(.*)$/.exec(line);
      if (!m) {
        if (/^ {4}\S/.test(line)) break; // next key of the service
        continue;
      }
      out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return out;
}

/** Docker Compose variable interpolation: ${VAR}, ${VAR:-default}, ${VAR:?message}. */
function interpolate(template: string, dotenv: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)(?::([-?])([^}]*))?\}/g, (_all, name: string, op?: string, arg?: string) => {
    const value = dotenv[name];
    if (value !== undefined && value !== '') return value;
    if (op === '-') return arg ?? '';
    if (op === '?') throw new Error(arg);
    return '';
  });
}

function composeEnv(service: string, dotenv: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, template] of Object.entries(serviceEnvironment(service))) out[key] = interpolate(template, dotenv);
  return out;
}

// What an operator gets from `openssl rand -base64 24`, a password manager, or a plain passphrase.
const PASSWORDS = {
  'openssl rand -base64 (contains /)': 'kQ3/9aBzq7f2Lm0Rt5u8wX+d',
  'password-manager style (contains ?)': 'Gr4?nite-Shift-2026',
  'password-manager style (contains #)': 'Gr4#nite-Shift-2026',
};

describe('docker-compose.yml DATABASE_URL survives the characters strong passwords contain', () => {
  for (const service of ['api', 'collector']) {
    for (const [label, password] of Object.entries(PASSWORDS)) {
      it(`${service}: POSTGRES_PASSWORD ${label}`, () => {
        const dotenv = {
          POSTGRES_DB: 'fld',
          POSTGRES_USER: 'fld',
          POSTGRES_PASSWORD: password,
          SESSION_SECRET: 'x'.repeat(64),
          ENCRYPTION_KEY: KEY,
        };
        const env = composeEnv(service, dotenv);
        // Each service turns its environment into a connection string with its own loader.
        const url = service === 'api' ? loadEnv(env).databaseUrl : loadCollectorEnv(env).databaseUrl;

        let client: pg.Client;
        try {
          client = new pg.Client({ connectionString: url });
        } catch (err) {
          throw new Error(`pg cannot parse the DATABASE_URL compose gives ${service}: ${(err as Error).message}`);
        }
        expect(client.host).toBe('db');
        expect(client.port).toBe(5432);
        expect(client.user).toBe('fld');
        expect(client.password).toBe(password);
        expect(client.database).toBe('fld');
      });
    }
  }
});
