/** operations table cache: operation name -> id, inserting on first sight. */
import { exec, q, type Pool, type Queryable } from '../db.js';

interface OperationRow {
  id: number;
  name: string;
}

export class OperationCache {
  private readonly byName = new Map<string, number>();
  private readonly byId = new Map<number, string>();
  private loaded = false;

  constructor(private readonly pool: Pool) {}

  clear(): void {
    this.byName.clear();
    this.byId.clear();
    this.loaded = false;
  }

  async preload(db: Queryable = this.pool): Promise<void> {
    if (this.loaded) return;
    const rows = await q<OperationRow>(db, 'SELECT id, name FROM operations');
    for (const row of rows) this.remember(row.id, row.name);
    this.loaded = true;
  }

  private remember(id: number, name: string): void {
    this.byName.set(name, id);
    this.byId.set(id, name);
  }

  peek(name: string): number | undefined {
    return this.byName.get(name);
  }

  nameOf(id: number): string | undefined {
    return this.byId.get(id);
  }

  /** Resolve many operation names at once, inserting the ones we have never seen. */
  async resolveMany(names: Iterable<string>, db: Queryable = this.pool): Promise<Map<string, number>> {
    const wanted = new Set<string>();
    const out = new Map<string, number>();
    for (const raw of names) {
      const name = (raw ?? '').trim();
      if (!name) continue;
      const known = this.byName.get(name);
      if (known !== undefined) out.set(name, known);
      else wanted.add(name);
    }
    if (wanted.size === 0) return out;

    const list = [...wanted];
    await exec(db, 'INSERT INTO operations (name) SELECT DISTINCT unnest($1::text[]) ON CONFLICT (name) DO NOTHING', [list]);
    const rows = await q<OperationRow>(db, 'SELECT id, name FROM operations WHERE name = ANY($1::text[])', [list]);
    for (const row of rows) {
      this.remember(row.id, row.name);
      out.set(row.name, row.id);
    }
    return out;
  }

  async resolve(name: string, db: Queryable = this.pool): Promise<number | null> {
    const map = await this.resolveMany([name], db);
    return map.get(name.trim()) ?? null;
  }
}
