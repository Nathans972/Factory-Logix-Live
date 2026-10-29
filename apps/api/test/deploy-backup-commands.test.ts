import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');

/** Fenced code blocks of the document, with the heading they sit under. */
function codeBlocks(): { heading: string; code: string }[] {
  const out: { heading: string; code: string }[] = [];
  let heading = '';
  let fence: string[] | null = null;
  for (const line of OPERATIONS.split('\n')) {
    if (fence) {
      if (line.trim().startsWith('```')) {
        out.push({ heading, code: fence.join('\n') });
        fence = null;
      } else fence.push(line);
    } else if (/^```/.test(line.trim())) fence = [];
    else if (/^#{2,3} /.test(line)) heading = line.replace(/^#+\s*/, '');
  }
  return out;
}

/** The text the HOST shell expands: everything outside single quotes, without `\$` escapes. */
function hostShellText(code: string): string {
  return code.replace(/'[^']*'/g, "''").replace(/\\\$/g, '');
}

/** True when the block loads `.env` itself (so `$POSTGRES_USER` has a value on the host). */
function loadsDotEnv(code: string): boolean {
  return /(^|\s)(source|\.)\s+\S*\.env\b|set -a|--env-file/.test(code);
}

describe('OPERATIONS.md commands run from a plain host shell or from cron', () => {
  it('does not rely on .env variables that only exist inside the containers', () => {
    // cron and a fresh ssh session do not read .env; Compose only passes it to the containers.
    const offenders = codeBlocks().flatMap(({ heading, code }) =>
      !loadsDotEnv(code) && /\$\{?POSTGRES_(USER|DB|PASSWORD)\b/.test(hostShellText(code))
        ? code
            .split('\n')
            .filter((l) => /\$\{?POSTGRES_(USER|DB|PASSWORD)\b/.test(hostShellText(l)))
            .map((l) => `[${heading}] ${l.trim()}`)
        : [],
    );
    expect(
      offenders,
      'the host shell expands these to an empty string, so pg_dump/pg_restore/psql run with `-U "" -d ""` ' +
        'and connect as the container user "root", which has no role in the database',
    ).toEqual([]);
  });

  it('the nightly backup block says where to run it from (cron starts in $HOME, not in the project)', () => {
    const block = codeBlocks().find((b) => b.heading.startsWith('Logical backup'));
    expect(block, 'Logical backup section has a code block').toBeDefined();
    // `docker compose` finds docker-compose.yml in the current directory; from $HOME it fails with
    // "no configuration file provided: not found".
    expect(block?.code).toMatch(/\bcd\b|docker compose\s+(-f|--file|--project-directory)\s|COMPOSE_FILE|\.sh\b/);
  });
});
