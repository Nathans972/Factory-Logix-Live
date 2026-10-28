import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * docs/OPERATIONS.md → Restore → "From a pg_dump file". These tests run the documented commands the way
 * an operator pastes them, from the project directory, with a stand-in `docker` that plays the db
 * container: it runs the `sh -c '...'` part with the container's POSTGRES_USER and POSTGRES_DB, and
 * stand-in PostgreSQL tools that record every call.
 */
const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
const BACKUP_SCRIPT = readFileSync(new URL('../../../scripts/backup.sh', import.meta.url), 'utf8');

/** The code block of the Restore section that runs pg_restore. */
function restoreCommands(): string {
  const section = OPERATIONS.slice(OPERATIONS.indexOf('\n## Restore'), OPERATIONS.indexOf('\n## Upgrades'));
  const block = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('pg_restore'));
  if (!block) throw new Error('the Restore section has no pg_restore code block');
  return block;
}

const FAKE_DOCKER = String.raw`#!/bin/sh
echo "docker $2" >> "$CALLS"
case "$2" in
  cp) [ -f "$3" ] || { echo "lstat $3: no such file or directory" >&2; exit 1; } ;;
  exec)
    shift 4 # compose exec -T db
    export POSTGRES_USER=fld POSTGRES_DB=fld PATH="$CONTAINER_BIN:$PATH"
    exec "$@" ;;
esac
`;

/** pg_restore, dropdb, createdb, psql and rm in the container: record the call, and fail when it matches $FAIL. */
const FAKE_TOOL = String.raw`#!/bin/sh
call="$(basename "$0") $*"
echo "$call" >> "$CALLS"
case "$call" in $FAIL) echo "$call: error" >&2; exit 1 ;; esac
`;

/** Like PostgreSQL's dropdb, it also fails when an earlier run already dropped the database, unless --if-exists. */
const FAKE_DROPDB =
  FAKE_TOOL +
  String.raw`case "$*" in *--if-exists*) exit 0 ;; esac
if [ -n "$NO_DB" ]; then echo 'dropdb: error: database "fld" does not exist' >&2; exit 1; fi
`;

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function runRestore({ dumpOnHost = true, fail = '', databaseGone = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fld-restore-'));
  roots.push(root);
  const project = join(root, 'Factory-Logix-Live');
  const bin = join(root, 'bin');
  const containerBin = join(root, 'container-bin');
  for (const dir of [join(project, 'backups'), bin, containerBin]) mkdirSync(dir, { recursive: true });
  if (dumpOnHost) writeFileSync(join(project, 'backups', 'fld-YYYYMMDD-HHMM.dump'), 'dump');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  for (const tool of ['pg_restore', 'dropdb', 'createdb', 'psql', 'rm']) {
    writeFileSync(join(containerBin, tool), tool === 'dropdb' ? FAKE_DROPDB : FAKE_TOOL, { mode: 0o755 });
  }
  const callsFile = join(root, 'calls');
  writeFileSync(callsFile, '');

  const result = spawnSync('bash', ['-c', restoreCommands()], {
    cwd: project,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CALLS: callsFile,
      CONTAINER_BIN: containerBin,
      FAIL: fail,
      NO_DB: databaseGone ? '1' : '',
    },
    encoding: 'utf8',
  });
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
  const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
  return { ...result, calls, at };
}

// Reading the whole archive to /dev/null, not just its table of contents (-l), also catches a dump that was cut short.
const READ_DUMP = /^pg_restore -f \/dev\/null \/tmp\/fld-restore\.dump$/;
const RESTORE = /^pg_restore .*-d fld .*\/tmp\/fld-restore\.dump$/;

describe.skipIf(process.platform === 'win32')('OPERATIONS.md restore from a pg_dump file', () => {
  it("follows TimescaleDB's procedure: new empty database, extension, pre_restore, pg_restore, post_restore", () => {
    const run = runRestore();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n').at(-1)).toBe('restore finished');

    const read = run.at(READ_DUMP);
    const drop = run.at(/^dropdb .*\bfld$/);
    const create = run.at(/^createdb .*\bfld$/);
    const pre = run.at(/^psql .*-d fld .*CREATE EXTENSION IF NOT EXISTS timescaledb .*timescaledb_pre_restore\(\)$/);
    const restore = run.at(RESTORE);
    const post = run.at(/^psql .*-d fld .*SELECT timescaledb_post_restore\(\)$/);
    expect([read, drop, create, pre, restore, post].every((i) => i >= 0), run.calls.join('\n')).toBe(true);
    // The dump is read before the database is deleted, and goes into the new one between pre_restore and post_restore.
    expect(read).toBeLessThan(drop);
    expect(drop).toBeLessThan(create);
    expect(create).toBeLessThan(pre);
    expect(pre).toBeLessThan(restore);
    expect(restore).toBeLessThan(post);
    // TimescaleDB's procedure restores into the empty database without --clean, and not in parallel.
    expect(run.calls[restore]).not.toMatch(/\s(--clean|--if-exists|--jobs|-c\b|-j)/);
    // The stack is started separately, once the operator has seen "restore finished".
    expect(run.calls).not.toContain('docker up');
  });

  it('a dump file that is not there deletes nothing', () => {
    const run = runRestore({ dumpOnHost: false });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(['docker stop', 'docker cp']);
    expect(run.stdout).not.toContain('restore finished');
  });

  it('a dump that cannot be read through stops before the database is deleted', () => {
    const run = runRestore({ fail: 'pg_restore -f *' });
    expect(run.status).not.toBe(0);
    expect(run.calls.at(-1)).toMatch(READ_DUMP);
    expect(run.at(/^dropdb /)).toBe(-1);
    expect(run.stdout).not.toContain('restore finished');
  });

  it('errors from pg_restore stop it there, without "restore finished" and without starting the stack', () => {
    const run = runRestore({ fail: 'pg_restore *-d *' });
    expect(run.status).not.toBe(0);
    expect(run.calls.at(-1)).toMatch(RESTORE);
    expect(run.stdout).not.toContain('restore finished');
    expect(run.calls).not.toContain('docker up');
  });

  it('does not use the file scripts/backup.sh writes in the container, so a nightly backup cannot overwrite it', () => {
    const backupFile = /pg_dump .* -f (\S+)'/.exec(BACKUP_SCRIPT)?.[1];
    expect(backupFile, 'the dump file scripts/backup.sh writes in the container').toBeTruthy();
    expect(restoreCommands()).not.toContain(backupFile);
  });

  it('can be run again after a run that stopped once the database was dropped', () => {
    const run = runRestore({ databaseGone: true });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n').at(-1)).toBe('restore finished');
  });
});
