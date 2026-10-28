import { execFile, execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkExtraCaFile } from '@fld/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * An https:// FactoryLogix whose certificate is self-signed or issued by the plant's own CA. Node trusts
 * only its built-in public CAs, so Test connection (api) and every poll (collector) failed with
 * "certificate not trusted", and nothing offered a way to add the plant CA: the compose `environment:`
 * lists are explicit, nothing was mounted, and neither .env.example nor INSTALL.md said a word.
 * FACTORYLOGIX_CA_CERT in .env names a PEM file in certs/, which compose mounts into both services and
 * hands to Node as NODE_EXTRA_CA_CERTS.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const SERVICES = ['api', 'collector'] as const;
type Service = (typeof SERVICES)[number];

/** What `.env` must hold for compose to start at all. */
const DOTENV: Record<string, string> = {
  POSTGRES_PASSWORD: 'pw',
  SESSION_SECRET: 'x'.repeat(64),
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

/** The entries of one list (`environment:` or `volumes:`) of one compose service, as written. */
function serviceList(service: Service, key: 'environment' | 'volumes'): string[] {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in docker-compose.yml`);
  const out: string[] = [];
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break; // next service or top-level key
    if (/^ {4}\S/.test(line)) {
      inside = line.trimEnd() === `    ${key}:`;
      continue;
    }
    if (inside && /^ {6}[^\s#]/.test(line)) out.push(line.trim());
  }
  return out;
}

/** Docker Compose variable interpolation: ${VAR}, ${VAR:-default}, ${VAR:?message}, ${VAR:+replacement}. */
function interpolate(template: string, dotenv: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)(?::([-?+])([^}]*))?\}/g, (_all, name: string, op?: string, arg?: string) => {
    const value = dotenv[name] ?? '';
    if (op === '+') return value !== '' ? (arg ?? '') : '';
    if (value !== '') return value;
    if (op === '-') return arg ?? '';
    if (op === '?') throw new Error(arg);
    return '';
  });
}

function composeEnv(service: Service, dotenv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of serviceList(service, 'environment')) {
    const m = /^([A-Z_]+):\s*(.*)$/.exec(entry);
    if (m) out[m[1]] = interpolate(m[2].replace(/^"(.*)"$/, '$1'), dotenv);
  }
  return out;
}

/** The file on the host a path inside the service's container is, through its bind mounts. */
function hostPath(service: Service, inContainer: string, installDir: string): { path: string; readOnly: boolean } | null {
  for (const entry of serviceList(service, 'volumes')) {
    const [source, target, mode] = entry.replace(/^-\s*/, '').split(':');
    if (!source.startsWith('.') && !source.startsWith('/')) continue; // a named volume
    if (inContainer !== target && !inContainer.startsWith(`${target}/`)) continue;
    // Compose resolves a relative source against the folder docker-compose.yml is in.
    return { path: join(resolve(installDir, source), inContainer.slice(target.length)), readOnly: mode === 'ro' };
  }
  return null;
}

describe('docker-compose.yml hands the CA FACTORYLOGIX_CA_CERT names to the api and the collector', () => {
  for (const service of SERVICES) {
    it(`${service}: FACTORYLOGIX_CA_CERT=plant-ca.pem makes Node trust certs/plant-ca.pem, mounted read-only`, () => {
      const extra = composeEnv(service, { ...DOTENV, FACTORYLOGIX_CA_CERT: 'plant-ca.pem' }).NODE_EXTRA_CA_CERTS;
      expect(extra, `${service} gets no NODE_EXTRA_CA_CERTS from FACTORYLOGIX_CA_CERT`).toBeTruthy();
      const file = hostPath(service, extra, ROOT);
      expect(file, `${service} has no bind mount holding ${extra}`).not.toBeNull();
      expect(file?.path).toBe(join(ROOT, 'certs', 'plant-ca.pem'));
      expect(file?.readOnly).toBe(true);
    });

    it(`${service}: without FACTORYLOGIX_CA_CERT, NODE_EXTRA_CA_CERTS is empty, which Node ignores`, () => {
      expect(composeEnv(service, DOTENV).NODE_EXTRA_CA_CERTS ?? '').toBe('');
      expect(composeEnv(service, { ...DOTENV, FACTORYLOGIX_CA_CERT: '' }).NODE_EXTRA_CA_CERTS ?? '').toBe('');
    });
  }

  it('certs/ is in the repository, so Docker never has to create the folder it mounts', () => {
    expect(statSync(join(ROOT, 'certs')).isDirectory()).toBe(true);
    expect(existsSync(join(ROOT, 'certs', 'README.md'))).toBe(true);
  });

  it('.env.example and INSTALL.md document FACTORYLOGIX_CA_CERT', () => {
    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toMatch(/^FACTORYLOGIX_CA_CERT=$/m);
    const install = readFileSync(join(ROOT, 'docs', 'INSTALL.md'), 'utf8');
    expect(install).toMatch(/^\| `FACTORYLOGIX_CA_CERT` \|/m);
    expect(install).toMatch(/^### FactoryLogix over https$/m);
  });
});

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = opensslAvailable();
const run = promisify(execFile);
const EDMX =
  '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices>' +
  '<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="FL"><EntityType Name="Job"><Property Name="Id" Type="Edm.Int32"/></EntityType>' +
  '<EntityContainer Name="C"><EntitySet Name="Jobs" EntityType="FL.Job"/></EntityContainer></Schema>' +
  '</edmx:DataServices></edmx:Edmx>';

describe.skipIf(!HAS_OPENSSL)('Test connection and polls against an https:// FactoryLogix, in processes started as compose starts them', () => {
  let dir = '';
  let installDir = '';
  let child = '';
  const servers: https.Server[] = [];
  let plantCaUrl = '';
  let selfSignedUrl = '';

  function openssl(...args: string[]): void {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  }

  async function serve(key: string, cert: string): Promise<string> {
    const server = https.createServer({ key: readFileSync(join(dir, key)), cert: readFileSync(join(dir, cert)) }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(EDMX);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}/odata`;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fl-plant-ca-'));
    // The plant's own CA, and the FactoryLogix server certificate it issued.
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Plant Root CA');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'fl.key', '-out', 'fl.csr', '-subj', '/CN=fl-server');
    writeFileSync(join(dir, 'fl.ext'), 'subjectAltName=IP:127.0.0.1\n');
    openssl('x509', '-req', '-in', 'fl.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '4096', '-days', '2', '-extfile', 'fl.ext', '-out', 'fl.pem');
    // A self-signed FactoryLogix certificate, as in the report.
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.pem', '-days', '2', '-subj', '/CN=fl-server', '-addext', 'subjectAltName=IP:127.0.0.1');
    plantCaUrl = await serve('fl.key', 'fl.pem');
    selfSignedUrl = await serve('self.key', 'self.pem');

    // The install folder: docker-compose.yml's certs/ with the files INSTALL.md says to put there.
    installDir = join(dir, 'install');
    mkdirSync(join(installDir, 'certs'), { recursive: true });
    copyFileSync(join(dir, 'ca.pem'), join(installDir, 'certs', 'plant-ca.pem'));
    copyFileSync(join(dir, 'self.pem'), join(installDir, 'certs', 'fl-self.pem'));

    // The api's Test connection and the collector's poll client, each run in a process of its own.
    const apiOdata = pathToFileURL(join(ROOT, 'apps/api/src/odata.ts')).href;
    const collectorClient = pathToFileURL(join(ROOT, 'apps/collector/src/odata/client.ts')).href;
    child = join(dir, 'connect.mjs');
    writeFileSync(
      child,
      `const [service, url] = process.argv.slice(2);
let result;
if (service === 'api') {
  const { fetchMetadata } = await import(${JSON.stringify(apiOdata)});
  const res = await fetchMetadata({ base_url: url, username: 'u', password: 'p' }, 10000);
  result = { ok: res.metadata !== null, error: res.error, sets: res.metadata?.entity_sets.map((s) => s.name) ?? [] };
} else {
  const { ODataClient } = await import(${JSON.stringify(collectorClient)});
  const client = new ODataClient({ baseUrl: url, username: 'u', password: 'p', timeoutSeconds: 10 });
  try {
    const metadata = await client.fetchMetadata();
    result = { ok: true, error: null, sets: metadata.entity_sets.map((s) => s.name) };
  } catch (err) {
    result = { ok: false, error: err.message, sets: [] };
  }
}
console.log(JSON.stringify(result));
`,
    );
  }, 60_000);

  afterAll(() => {
    for (const server of servers) server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Fetch `$metadata` the way `service` does, with the environment compose gives it for this `.env`. */
  async function connect(service: Service, dotenv: Record<string, string>, url: string) {
    const env = composeEnv(service, { ...DOTENV, ...dotenv });
    if (env.NODE_EXTRA_CA_CERTS) {
      const file = hostPath(service, env.NODE_EXTRA_CA_CERTS, installDir);
      if (!file) throw new Error(`${service}: no bind mount holds ${env.NODE_EXTRA_CA_CERTS}`);
      env.NODE_EXTRA_CA_CERTS = file.path;
    }
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', child, service, url], {
      cwd: join(ROOT, 'apps', service),
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok: boolean; error: string | null; sets: string[] };
    return { ...result, stderr };
  }

  it('fails as reported without FACTORYLOGIX_CA_CERT, with no Node warning on installs that do not set it', async () => {
    for (const service of SERVICES) {
      const res = await connect(service, {}, plantCaUrl);
      expect(res.ok, service).toBe(false);
      expect(res.error, service).toMatch(/certificate not trusted .*UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
      expect(res.stderr, service).not.toMatch(/extra certs/i);
    }
  }, 120_000);

  it('connects once FACTORYLOGIX_CA_CERT names the plant CA in certs/', async () => {
    for (const service of SERVICES) {
      const res = await connect(service, { FACTORYLOGIX_CA_CERT: 'plant-ca.pem' }, plantCaUrl);
      expect(res, service).toMatchObject({ ok: true, error: null, sets: ['Jobs'] });
      expect(res.stderr, service).not.toMatch(/extra certs/i);
    }
  }, 120_000);

  it('connects to a self-signed FactoryLogix once FACTORYLOGIX_CA_CERT names that certificate', async () => {
    for (const service of SERVICES) {
      const res = await connect(service, { FACTORYLOGIX_CA_CERT: 'fl-self.pem' }, selfSignedUrl);
      expect(res, service).toMatchObject({ ok: true, error: null, sets: ['Jobs'] });
    }
  }, 120_000);

  it('the start-up check confirms the PEM file and flags the same CA saved as DER, the Windows default', () => {
    const read = (path: string): string => readFileSync(path, 'latin1');
    const pem = join(installDir, 'certs', 'plant-ca.pem');
    expect(checkExtraCaFile(pem, read)).toEqual({
      ok: true,
      message: `FACTORYLOGIX_CA_CERT: ${pem} holds 1 certificate, trusted for https:// FactoryLogix`,
    });
    const der = join(installDir, 'certs', 'plant-ca.cer');
    writeFileSync(der, new X509Certificate(readFileSync(pem)).raw);
    const flagged = checkExtraCaFile(der, read);
    expect(flagged?.ok).toBe(false);
    expect(flagged?.message).toContain(`${der} holds no PEM certificate`);
  });
});
