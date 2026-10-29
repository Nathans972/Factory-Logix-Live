import {
  DATASET_SPECS,
  HOUR_CELL_SETTINGS_KEYS,
  connectionWriteSchema,
  datasetMappingSchema,
  mappingConfigSchema,
  settingsPatchSchema,
  type ConnectionResponse,
  type ConnectionTestResult,
  type DatasetName,
  type MappingPreviewResult,
  type MappingResponse,
  type ODataMetadata,
  type SettingsResponse,
} from '@fld/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../audit.js';
import { requireRole } from '../../auth/index.js';
import type { AppContext } from '../../context.js';
import { applySettingsPatch, getSettings } from '../../db/repo/settings.js';
import { ApiError, badRequest } from '../../errors.js';
import { requestCellRecompute, sendControl } from '../../notify.js';
import { fetchMetadata, runPreview, type ODataCredentials } from '../../odata.js';
import { getCredentials, getStoredConnection, saveConnection, toPublicConnection } from '../../services/connection.js';
import { cacheMetadata, getCachedMetadata, getMapping, saveMapping } from '../../services/mapping.js';
import { parseWith } from '../../util/query.js';

export async function registerAdminSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };

  /** `cells`: what was saved changes the stored hour cells, so the recent ones are recomputed in that time zone. */
  const configChanged = async (cells?: { tz: string }): Promise<void> => {
    ctx.sse.broadcast({ type: 'settings_updated', at: Date.now() });
    try {
      await sendControl(ctx.db, { cmd: 'restart' });
      if (cells) await requestCellRecompute(ctx.db, cells.tz);
    } catch (err) {
      ctx.log.warn({ err }, 'could not notify the collector');
    }
  };

  const timeoutMs = async (): Promise<number> => (await getSettings(ctx.db)).odata_timeout_seconds * 1000;

  // ---------------- settings ----------------

  app.get('/api/admin/settings', viewer, async (): Promise<SettingsResponse> => ({
    settings: await getSettings(ctx.db, { fresh: true }),
  }));

  app.patch('/api/admin/settings', admin, async (req): Promise<SettingsResponse> => {
    const patch = parseWith(settingsPatchSchema, req.body ?? {});
    const before = await getSettings(ctx.db, { fresh: true });
    await applySettingsPatch(ctx.db, patch, req.auth?.username ?? null);
    const after = await getSettings(ctx.db, { fresh: true });
    await audit(req, 'settings.updated', 'settings', null, before, after);
    const changesCells = HOUR_CELL_SETTINGS_KEYS.some((key) => patch[key] !== undefined && patch[key] !== before[key]);
    await configChanged(changesCells ? { tz: after.plant_timezone } : undefined);
    return { settings: after };
  });

  // ---------------- FactoryLogix connection ----------------

  app.get('/api/admin/connection', admin, async (): Promise<ConnectionResponse> => ({
    connection: toPublicConnection(await getStoredConnection(ctx.db)),
  }));

  app.put('/api/admin/connection', admin, async (req): Promise<ConnectionResponse> => {
    const body = parseWith(connectionWriteSchema, req.body);
    const before = toPublicConnection(await getStoredConnection(ctx.db));
    const saved = await saveConnection(
      ctx.db,
      { base_url: body.base_url, username: body.username, password: body.password ?? null },
      req.auth?.username ?? null,
    );
    const after = toPublicConnection(saved);
    await audit(req, 'connection.updated', 'fl_connection', null, before, after);
    await configChanged();
    return { connection: after };
  });

  app.post('/api/admin/connection/test', admin, async (req): Promise<ConnectionTestResult> => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const override =
      raw && typeof raw.base_url === 'string' && raw.base_url.length > 0
        ? parseWith(connectionWriteSchema, raw)
        : null;
    let creds: ODataCredentials | null;
    try {
      creds = await getCredentials(ctx.db, override);
    } catch (err) {
      // A URL holding a user name or password, or a saved password this ENCRYPTION_KEY cannot
      // decrypt: a failed test that says so.
      if (err instanceof ApiError) return { ok: false, error: err.message, metadata: null, latency_ms: null };
      throw err;
    }
    if (!creds) {
      return { ok: false, error: 'no FactoryLogix connection is configured', metadata: null, latency_ms: null };
    }
    const { metadata, error, latency_ms } = await fetchMetadata(creds, await timeoutMs());
    if (metadata) await cacheMetadata(ctx.db, metadata);
    await audit(req, 'connection.tested', 'fl_connection', null, null, {
      base_url: creds.base_url,
      ok: metadata !== null,
      error,
    });
    return { ok: metadata !== null, error, metadata, latency_ms };
  });

  // ---------------- mapping ----------------

  app.get('/api/admin/mapping', admin, async (): Promise<MappingResponse> => ({
    mapping: await getMapping(ctx.db),
    metadata: await getCachedMetadata(ctx.db),
  }));

  app.put('/api/admin/mapping', admin, async (req): Promise<MappingResponse> => {
    const mapping = parseWith(mappingConfigSchema, req.body);
    const before = await getMapping(ctx.db);
    await saveMapping(ctx.db, mapping, req.auth?.username ?? null);
    await audit(req, 'mapping.updated', 'mapping', null, before, mapping);
    await configChanged();
    return { mapping, metadata: await getCachedMetadata(ctx.db) };
  });

  app.get('/api/admin/mapping/metadata', admin, async (): Promise<ODataMetadata> => {
    const creds = await getCredentials(ctx.db);
    if (!creds) throw badRequest('no FactoryLogix connection is configured');
    const { metadata, error } = await fetchMetadata(creds, await timeoutMs());
    if (!metadata) throw badRequest(error ?? 'could not read $metadata');
    await cacheMetadata(ctx.db, metadata);
    return metadata;
  });

  app.post('/api/admin/mapping/preview', admin, async (req): Promise<MappingPreviewResult> => {
    const body = (req.body ?? {}) as { dataset?: unknown; mapping?: unknown };
    const dataset = String(body.dataset ?? '') as DatasetName;
    if (!DATASET_SPECS.some((s) => s.name === dataset)) throw badRequest(`unknown dataset ${String(body.dataset)}`);
    const mappingRecord = (body.mapping ?? {}) as Record<string, unknown>;
    const datasetMapping = parseWith(datasetMappingSchema, mappingRecord[dataset]);
    const creds = await getCredentials(ctx.db);
    if (!creds) throw badRequest('no FactoryLogix connection is configured');
    const { fl_timestamp_mode, plant_timezone } = await getSettings(ctx.db);
    const timestamps = { mode: fl_timestamp_mode, timezone: plant_timezone };
    return runPreview(creds, dataset, datasetMapping, timestamps, await timeoutMs());
  });
}
