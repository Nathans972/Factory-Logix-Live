/** Field mapping + cached $metadata, both stored in the `settings` table. */
import { MAPPING_KEY_HISTORY, nextMappingKeyHistory, parseMappingKeyHistory, type MappingConfig, type ODataMetadata } from '@fld/shared';
import type { Db } from '../db/pool.js';
import { getSettingValue, setSettingValue } from '../db/repo/settings.js';

export const MAPPING_KEY = 'mapping';
export const METADATA_KEY = 'odata_metadata';

export async function getMapping(db: Db): Promise<MappingConfig | null> {
  return getSettingValue<MappingConfig>(db, MAPPING_KEY);
}

/**
 * Saves the mapping, and first the natural keys it replaces (`MappingKeyHistory`): the rows the
 * collector stored under them are still there. Should the mapping then fail to save, the key added
 * is the one still in use, which the collector leaves out.
 */
export async function saveMapping(db: Db, mapping: MappingConfig, updatedBy: string | null): Promise<void> {
  const history = parseMappingKeyHistory(await getSettingValue(db, MAPPING_KEY_HISTORY));
  const next = nextMappingKeyHistory(history, await getMapping(db), mapping);
  if (JSON.stringify(next) !== JSON.stringify(history)) await setSettingValue(db, MAPPING_KEY_HISTORY, next, updatedBy);
  await setSettingValue(db, MAPPING_KEY, mapping, updatedBy);
}

/** Last successfully fetched $metadata (the live fetch happens on /admin/mapping/metadata). */
export async function getCachedMetadata(db: Db): Promise<ODataMetadata | null> {
  return getSettingValue<ODataMetadata>(db, METADATA_KEY);
}

export async function cacheMetadata(db: Db, metadata: ODataMetadata): Promise<void> {
  await setSettingValue(db, METADATA_KEY, metadata, 'system');
}
