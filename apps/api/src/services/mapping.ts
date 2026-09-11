/** Field mapping + cached $metadata, both stored in the `settings` table. */
import type { MappingConfig, ODataMetadata } from '@fld/shared';
import type { Db } from '../db/pool.js';
import { getSettingValue, setSettingValue } from '../db/repo/settings.js';

export const MAPPING_KEY = 'mapping';
export const METADATA_KEY = 'odata_metadata';

export async function getMapping(db: Db): Promise<MappingConfig | null> {
  return getSettingValue<MappingConfig>(db, MAPPING_KEY);
}

export async function saveMapping(db: Db, mapping: MappingConfig, updatedBy: string | null): Promise<void> {
  await setSettingValue(db, MAPPING_KEY, mapping, updatedBy);
}

/** Last successfully fetched $metadata (the live fetch happens on /admin/mapping/metadata). */
export async function getCachedMetadata(db: Db): Promise<ODataMetadata | null> {
  return getSettingValue<ODataMetadata>(db, METADATA_KEY);
}

export async function cacheMetadata(db: Db, metadata: ODataMetadata): Promise<void> {
  await setSettingValue(db, METADATA_KEY, metadata, 'system');
}
