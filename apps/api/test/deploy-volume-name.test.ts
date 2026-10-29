import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const COMPOSE = readFileSync(new URL('docker-compose.yml', ROOT), 'utf8');
const OPERATIONS = readFileSync(new URL('docs/OPERATIONS.md', ROOT), 'utf8');
const INSTALL = readFileSync(new URL('docs/INSTALL.md', ROOT), 'utf8');

/**
 * The name Docker gives the `fld-db-data` volume. Compose prefixes a volume with the project name
 * (`<project>_fld-db-data`) unless the volume sets an explicit `name:`. The project name is the
 * top-level `name:` if there is one, otherwise the directory the stack is started from.
 */
function realVolumeName(): string {
  const lines = COMPOSE.split('\n');
  const top = lines.findIndex((l) => /^volumes:\s*$/.test(l));
  let explicit: string | null = null;
  if (top >= 0) {
    const entry = lines.findIndex((l, i) => i > top && /^ {2}fld-db-data:/.test(l));
    for (const line of lines.slice(entry + 1)) {
      if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
      const m = /^ {4}name:\s*(\S+)/.exec(line);
      if (m) explicit = m[1].replace(/^["']|["']$/g, '');
    }
  }
  if (explicit) return explicit;
  const project = lines.map((l) => /^name:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
  if (project) return `${project.replace(/^["']|["']$/g, '')}_fld-db-data`;
  // No pinned name: INSTALL.md tells the operator to `cd Factory-Logix-Live`, so Compose uses
  // the lower-cased directory name.
  const dir = /^cd\s+(\S+)\s*$/m.exec(INSTALL)?.[1] ?? 'unknown';
  return `${dir.toLowerCase().replace(/[^a-z0-9_-]/g, '')}_fld-db-data`;
}

/** Literal volume names the operator is told to type in `docker volume ...` / `docker run -v` commands. */
function volumeNamesInDocs(): string[] {
  const names: string[] = [];
  for (const m of OPERATIONS.matchAll(/docker volume (?:rm|create|inspect)\s+(\S+)/g)) names.push(m[1]);
  for (const m of OPERATIONS.matchAll(/docker run[^\n]*?\s-v\s+([^\s:]+):\/data/g)) names.push(m[1]);
  return names.filter((n) => !n.includes('$'));
}

describe('OPERATIONS.md volume backup and restore name the volume Compose actually creates', () => {
  it('every literal volume name equals the volume Compose creates', () => {
    const real = realVolumeName();
    const wrong = volumeNamesInDocs().filter((n) => n !== real);
    expect(
      wrong,
      `docs use ${JSON.stringify([...new Set(wrong)])}, but Compose creates "${real}": ` +
        '`docker run -v <missing name>:/data` silently creates an EMPTY volume, so the backup tars an empty ' +
        'directory and the restore never touches the volume the db service uses',
    ).toEqual([]);
  });
});
