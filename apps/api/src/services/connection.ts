/**
 * FactoryLogix connection settings. Stored as the `fl_connection` row of `settings`:
 * `{ base_url, username, password_enc }` where password_enc is `enc:v1:...` (see src/crypto.ts).
 * The password never leaves the server.
 */
import type { FlConnection } from '@fld/shared';
import { decryptIfNeeded, encrypt } from '../crypto.js';
import type { Db } from '../db/pool.js';
import { getSettingValue, setSettingValue } from '../db/repo/settings.js';
import type { ODataCredentials } from '../odata.js';

export const FL_CONNECTION_KEY = 'fl_connection';

export interface StoredConnection {
  base_url: string;
  username: string;
  password_enc: string | null;
}

export async function getStoredConnection(db: Db): Promise<StoredConnection | null> {
  const raw = await getSettingValue<Partial<StoredConnection>>(db, FL_CONNECTION_KEY);
  if (!raw || typeof raw !== 'object') return null;
  return {
    base_url: String(raw.base_url ?? ''),
    username: String(raw.username ?? ''),
    password_enc: raw.password_enc ? String(raw.password_enc) : null,
  };
}

/** Public shape: never includes the password. */
export function toPublicConnection(stored: StoredConnection | null): FlConnection {
  return {
    base_url: stored?.base_url ?? '',
    username: stored?.username ?? '',
    has_password: Boolean(stored?.password_enc),
  };
}

export async function saveConnection(
  db: Db,
  input: { base_url: string; username: string; password?: string | null },
  updatedBy: string | null,
): Promise<StoredConnection> {
  const existing = await getStoredConnection(db);
  const password = typeof input.password === 'string' ? input.password : '';
  const next: StoredConnection = {
    base_url: input.base_url.trim(),
    username: input.username.trim(),
    password_enc: password.length > 0 ? encrypt(password) : (existing?.password_enc ?? null),
  };
  await setSettingValue(db, FL_CONNECTION_KEY, next, updatedBy);
  return next;
}

/** Decrypted credentials for outbound calls; null when nothing usable is configured. */
export async function getCredentials(
  db: Db,
  override?: { base_url?: string; username?: string; password?: string | null } | null,
): Promise<ODataCredentials | null> {
  const stored = await getStoredConnection(db);
  const base_url = (override?.base_url ?? stored?.base_url ?? '').trim();
  const username = (override?.username ?? stored?.username ?? '').trim();
  if (!base_url) return null;
  let password = '';
  if (override && typeof override.password === 'string' && override.password.length > 0) {
    password = override.password;
  } else if (stored?.password_enc) {
    password = decryptIfNeeded(stored.password_enc) ?? '';
  }
  return { base_url, username, password };
}
