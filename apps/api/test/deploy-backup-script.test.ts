import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * docs/OPERATIONS.md tells you to run scripts/backup.sh from root's crontab. Cron starts it in $HOME, with
 * PATH=/usr/bin:/bin and nothing from .env. These tests run it the same way, from a copy of the project, with
 * a stand-in `docker` that records every call and plays the db container.
 */
const SCRIPT = fileURLToPath(new URL('../../../scripts/backup.sh', import.meta.url));
const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');

const FAKE_DOCKER = String.raw`#!/bin/sh
printf '%s|%s\n' "$(pwd -P)" "$*" >> "$DOCKER_CALLS"
case "$2" in
  exec)
    case "$*" in *pg_dump*)
      if [ -n "$FAIL_DUMP" ]; then echo 'FATAL:  role "root" does not exist' >&2; exit 1; fi ;;
    esac ;;
  cp)
    echo dump > "$4"
    if [ -n "$FAIL_CP" ]; then echo 'no space left on device' >&2; exit 1; fi ;;
esac
`;

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function runLikeCron(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fld-backup-'));
  roots.push(root);
  const project = join(root, 'Factory-Logix-Live');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  for (const dir of [join(project, 'scripts'), bin, home]) mkdirSync(dir, { recursive: true });
  copyFileSync(SCRIPT, join(project, 'scripts', 'backup.sh'));
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  const callsFile = join(root, 'docker-calls');
  writeFileSync(callsFile, '');

  const result = spawnSync(join(project, 'scripts', 'backup.sh'), [], {
    cwd: home,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, DOCKER_CALLS: callsFile, ...extraEnv },
    encoding: 'utf8',
  });
  const calls = readFileSync(callsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [cwd, args] = line.split('|');
      return { cwd, args };
    });
  return { ...result, project: realpathSync(project), calls, backups: readdirSync(join(project, 'backups')) };
}

describe.skipIf(process.platform === 'win32')('scripts/backup.sh run the way cron runs it', () => {
  it('is executable, because cron runs it by its path', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('dumps the database from the project directory, with the db container filling in the user and database', () => {
    const run = runLikeCron();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.backups).toEqual([expect.stringMatching(/^fld-\d{8}-\d{4}\.dump$/)]);
    expect(run.stdout).toContain(`backup written: backups/${run.backups[0]}`);
    // Compose finds docker-compose.yml and .env in the current directory, so every call has to run there.
    expect(run.calls.map((c) => c.cwd)).toEqual([run.project, run.project, run.project]);
    // Not expanded on the host, where they would be empty: the container's shell expands them.
    expect(run.calls[0].args).toBe(
      'compose exec -T db sh -c pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c -f /tmp/fld.dump',
    );
    expect(run.calls[1].args).toBe(`compose cp db:/tmp/fld.dump backups/${run.backups[0]}.partial`);
    expect(run.calls[2].args).toBe('compose exec -T db rm /tmp/fld.dump');
  });

  it('stops when pg_dump fails: no copy, no dump file, "backup FAILED" and a non-zero exit', () => {
    const run = runLikeCron({ FAIL_DUMP: '1' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('role "root" does not exist');
    expect(run.stderr).toMatch(/backup FAILED\n$/);
    expect(run.stdout).not.toContain('backup written');
    expect(run.calls).toHaveLength(1);
    expect(run.backups).toEqual([]);
  });

  it('leaves no half-copied file that looks like a dump when the copy out of the container fails', () => {
    const run = runLikeCron({ FAIL_CP: '1' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/backup FAILED\n$/);
    expect(run.calls).toHaveLength(2);
    expect(run.backups).toEqual([]);
  });
});

describe('the cron line in OPERATIONS.md', () => {
  const cronLines = OPERATIONS.split('\n').filter((line) => /^([\d*,-]+\s+){5}\//.test(line.trim()));

  it('runs the script and keeps its output in a log, since cron mail goes nowhere on a server without mail', () => {
    expect(cronLines.length).toBeGreaterThan(0);
    for (const line of cronLines) {
      expect(line).toMatch(/\/scripts\/backup\.sh\s+>>\s*\S+\s+2>&1/);
    }
  });

  it('has no %, which cron turns into a newline, cutting the command short', () => {
    for (const line of cronLines) expect(line).not.toContain('%');
  });
});
