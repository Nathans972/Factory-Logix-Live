import type { Role, User } from '@fld/shared';
import type { Pool } from 'pg';
import { withTransaction, type Db } from '../pool.js';
import { toBool, toMs, toMsOr } from '../util.js';

export type UserRow = {
  id: number;
  username: string;
  password_hash?: string;
  role: Role;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
};

const PUBLIC_COLUMNS = 'id, username, role, active, created_at, last_login_at';

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    active: toBool(row.active, true),
    created_at: toMsOr(row.created_at, 0),
    last_login_at: toMs(row.last_login_at),
  };
}

export async function countUsers(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  return rows[0]?.n ?? 0;
}

export async function countActiveAdmins(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE active AND role = 'admin'",
  );
  return rows[0]?.n ?? 0;
}

export async function listUsers(db: Db): Promise<User[]> {
  const { rows } = await db.query<UserRow>(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username`);
  return rows.map(mapUser);
}

export async function getUserById(db: Db, id: number): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows.length > 0 ? mapUser(rows[0]) : null;
}

export async function getUserWithHash(db: Db, username: string): Promise<(User & { password_hash: string }) | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE lower(username) = lower($1)`,
    [username],
  );
  if (rows.length === 0) return null;
  return { ...mapUser(rows[0]), password_hash: rows[0].password_hash ?? '' };
}

export async function createUser(
  db: Db,
  input: { username: string; password_hash: string; role: Role },
): Promise<User> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING ${PUBLIC_COLUMNS}`,
    [input.username, input.password_hash, input.role],
  );
  return mapUser(rows[0]);
}

/** Serializes first-admin setup: held for the setup transaction only. */
export const FIRST_ADMIN_LOCK_ID = 815_243_002;

/**
 * Creates the first admin; returns null when a user already exists (setup already done).
 * Two simultaneous setups would both see an empty `users` table under READ COMMITTED, so the
 * insert runs after a transaction-scoped advisory lock: the second one waits, then finds a user.
 */
export async function createFirstAdmin(pool: Pool, username: string, passwordHash: string): Promise<User | null> {
  return withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [FIRST_ADMIN_LOCK_ID]);
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (username, password_hash, role)
       SELECT $1, $2, 'admin'::user_role WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING ${PUBLIC_COLUMNS}`,
      [username, passwordHash],
    );
    return rows.length > 0 ? mapUser(rows[0]) : null;
  });
}

export async function updateUser(
  db: Db,
  id: number,
  patch: { role?: Role; active?: boolean; password_hash?: string },
): Promise<User | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.active !== undefined) {
    params.push(patch.active);
    sets.push(`active = $${params.length}`);
  }
  if (patch.password_hash !== undefined) {
    params.push(patch.password_hash);
    sets.push(`password_hash = $${params.length}`);
  }
  if (sets.length === 0) return getUserById(db, id);
  params.push(id);
  const { rows } = await db.query<UserRow>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${PUBLIC_COLUMNS}`,
    params,
  );
  return rows.length > 0 ? mapUser(rows[0]) : null;
}

export async function recordLogin(db: Db, id: number): Promise<void> {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}
