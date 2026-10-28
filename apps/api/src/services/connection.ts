/**
 * FactoryLogix connection settings. Stored as the `fl_connection` row of `settings`:
 * `{ base_url, username, password_enc }` where password_enc is `enc:v1:...` (see src/crypto.ts).
 * The password never leaves the server, and the stored one is only sent with the URL and user name
 * it was saved with (see sameConnection).
 */
import { URL_CREDENTIALS_MESSAGE, urlHasCredentials, type FlConnection } from '@fld/shared';
import { decryptIfNeeded, encrypt } from '../crypto.js';
import type { Db } from '../db/pool.js';
import { getSettingValue, setSettingValue } from '../db/repo/settings.js';
import { badRequest } from '../errors.js';
import type { ODataCredentials } from '../odata.js';

export const FL_CONNECTION_KEY = 'fl_connection';

/**
 * A saved password this ENCRYPTION_KEY cannot decrypt was saved under another key, typically on the
 * install a backup was restored from (the key is in `.env`, not in the database). Typing the
 * password again is the only way to use the connection.
 */
export const UNREADABLE_PASSWORD_MESSAGE =
  "enter the password again: the saved password cannot be decrypted with this server's ENCRYPTION_KEY (it was saved under another key, as when a backup from another install is restored)";

export interface StoredConnection {
  base_url: string;
  username: string;
  password_enc: string | null;
}

/** The saved password in clear, or null when this ENCRYPTION_KEY cannot decrypt it. */
function decryptStored(passwordEnc: string): string | null {
  try {
    return decryptIfNeeded(passwordEnc);
  } catch {
    return null;
  }
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

/** A URL saved with a password in it by an earlier version is shown, and audited, with the password masked. */
function maskUrlPassword(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return url;
    parsed.password = '***';
    return parsed.href;
  } catch {
    return url;
  }
}

/** Public shape: never includes the password. */
export function toPublicConnection(stored: StoredConnection | null): FlConnection {
  const unreadable = stored?.password_enc ? decryptStored(stored.password_enc) === null : false;
  return {
    base_url: maskUrlPassword(stored?.base_url ?? ''),
    username: stored?.username ?? '',
    has_password: Boolean(stored?.password_enc),
    ...(unreadable ? { password_unreadable: true } : {}),
  };
}

/**
 * Same URL and user name, character for character once trimmed: the requests the collector makes
 * with the stored password. Any other URL or user name typed into the form (test or save) needs the
 * password typed too. Otherwise pointing the URL at a machine you control, or at another path or
 * account on the same server, would get the stored password sent there in the Authorization header.
 */
export function sameConnection(
  a: { base_url: string; username: string },
  b: { base_url: string; username: string },
): boolean {
  return a.base_url.trim() === b.base_url.trim() && a.username.trim() === b.username.trim();
}

export async function saveConnection(
  db: Db,
  input: { base_url: string; username: string; password?: string | null },
  updatedBy: string | null,
): Promise<StoredConnection> {
  const existing = await getStoredConnection(db);
  const password = typeof input.password === 'string' ? input.password : '';
  const base_url = input.base_url.trim();
  const username = input.username.trim();
  if (urlHasCredentials(base_url)) throw badRequest(URL_CREDENTIALS_MESSAGE);
  if (password.length === 0 && existing?.password_enc && !sameConnection({ base_url, username }, existing)) {
    throw badRequest(
      'enter the password again: the saved password is only sent with the server URL and user name it was saved with',
    );
  }
  // Keeping it would save a connection that neither the API nor the collector can use.
  if (password.length === 0 && existing?.password_enc && decryptStored(existing.password_enc) === null) {
    throw badRequest(UNREADABLE_PASSWORD_MESSAGE);
  }
  const next: StoredConnection = {
    base_url,
    username,
    password_enc: password.length > 0 ? encrypt(password) : (existing?.password_enc ?? null),
  };
  await setSettingValue(db, FL_CONNECTION_KEY, next, updatedBy);
  return next;
}

/**
 * Decrypted credentials for outbound calls; null when nothing usable is configured. An override
 * (unsaved form values) without a password only gets the stored one while its URL and user name are
 * the saved ones; otherwise the password is empty. A stored password that is needed but cannot be
 * decrypted is a 400 asking for it again. So is a URL holding a user name or password (typed into
 * the form, or saved by an earlier version), which fetch would repeat in its error.
 */
export async function getCredentials(
  db: Db,
  override?: { base_url?: string; username?: string; password?: string | null } | null,
): Promise<ODataCredentials | null> {
  const stored = await getStoredConnection(db);
  const base_url = (override?.base_url ?? stored?.base_url ?? '').trim();
  const username = (override?.username ?? stored?.username ?? '').trim();
  if (!base_url) return null;
  if (urlHasCredentials(base_url)) throw badRequest(URL_CREDENTIALS_MESSAGE);
  let password = '';
  if (override && typeof override.password === 'string' && override.password.length > 0) {
    password = override.password;
  } else if (stored?.password_enc && sameConnection({ base_url, username }, stored)) {
    const saved = decryptStored(stored.password_enc);
    if (saved === null) throw badRequest(UNREADABLE_PASSWORD_MESSAGE);
    password = saved;
  }
  return { base_url, username, password };
}
