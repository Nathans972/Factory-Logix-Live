import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const COMPOSE = readFileSync(new URL('docker-compose.yml', ROOT), 'utf8');
const DOCS = ['docs/INSTALL.md', 'docs/OPERATIONS.md', 'README.md'].map((f) => readFileSync(new URL(f, ROOT), 'utf8')).join('\n');

/** The lines of one service in docker-compose.yml. */
function serviceBlock(name: string): string {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

describe('container logs are bounded', () => {
  // Docker's default json-file driver keeps every line forever. Fastify logs two lines per request
  // (~425 bytes), nginx a third (~190 bytes); every TV refetches on each poll event and every 60 s.
  // 20 TVs is roughly 48,000 requests (~30 MB) a day, ~11 GB a year, from the TVs alone.
  const services = ['db', 'api', 'collector', 'web'];

  it('docker-compose.yml caps every service log (logging: options: max-size / max-file), or the docs tell the operator to', () => {
    const uncapped = services.filter((s) => !/logging:[\s\S]*max-size/.test(serviceBlock(s)));
    const documented = /max-size|log-opts|daemon\.json/.test(DOCS);
    expect(
      uncapped.length === 0 || documented,
      `services without a log size limit: ${uncapped.join(', ')}; and no doc mentions max-size/log-opts/daemon.json`,
    ).toBe(true);
  });
});
