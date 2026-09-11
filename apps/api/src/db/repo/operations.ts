import type { Db } from '../pool.js';

/** Resolve an operation name to its id, inserting the row when it is new. */
export async function getOrCreateOperationId(db: Db, name: string): Promise<number> {
  const trimmed = name.trim();
  const existing = await db.query<{ id: number }>('SELECT id FROM operations WHERE name = $1', [trimmed]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await db.query<{ id: number }>(
    'INSERT INTO operations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
    [trimmed],
  );
  return inserted.rows[0].id;
}

export async function getOperationId(db: Db, name: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM operations WHERE name = $1', [name]);
  return rows.length > 0 ? rows[0].id : null;
}

export async function listOperationNames(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM operations ORDER BY name');
  return rows.map((r) => r.name);
}

export async function getOperationNames(db: Db, ids: number[]): Promise<Record<number, string>> {
  if (ids.length === 0) return {};
  const { rows } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM operations WHERE id = ANY($1::int[])',
    [ids],
  );
  const out: Record<number, string> = {};
  for (const r of rows) out[r.id] = r.name;
  return out;
}
