import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const OPERATIONS = readFileSync(new URL('docs/OPERATIONS.md', ROOT), 'utf8');
const MIGRATION = readFileSync(new URL('db/migrations/0001_init.sql', ROOT), 'utf8');

/** The text of the `## Restore` section. */
function restoreSection(): string {
  const start = OPERATIONS.indexOf('\n## Restore');
  const end = OPERATIONS.indexOf('\n## Upgrades');
  return OPERATIONS.slice(start, end);
}

describe('restoring a pg_dump of a TimescaleDB database', () => {
  it('the schema really uses TimescaleDB hypertables and the compose image really has the extension', () => {
    expect(MIGRATION).toMatch(/create_hypertable\('unit_steps'/);
    expect(readFileSync(new URL('docker-compose.yml', ROOT), 'utf8')).toMatch(/image:\s*timescale\/timescaledb:/);
  });

  it('OPERATIONS.md restore wraps pg_restore in timescaledb_pre_restore() / timescaledb_post_restore()', () => {
    const section = restoreSection();
    expect(section, 'Restore section found').toMatch(/pg_restore/);
    // TimescaleDB's documented procedure: empty database with the extension created, then
    // SELECT timescaledb_pre_restore(); pg_restore (no --clean); SELECT timescaledb_post_restore();
    // The documented command is a bare `pg_restore --clean --if-exists` into the live database.
    expect(section).toMatch(/timescaledb_pre_restore\s*\(\s*\)/);
    expect(section).toMatch(/timescaledb_post_restore\s*\(\s*\)/);
  });
});
