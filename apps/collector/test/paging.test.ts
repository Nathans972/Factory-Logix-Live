import { describe, expect, it } from 'vitest';
import { ODataSource } from '../src/sources/ODataSource.js';
import { pullPages } from '../src/sync/paging.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { WatermarkTracker } from '../src/sync/watermark.js';

const BASE = 'http://fl:6065/odata';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeRows(count: number, startIndex: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    UnitSerial: `SN-${startIndex + i}`,
    CompletedDate: new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + (startIndex + i) * 60_000).toISOString(),
  }));
}

function sourceWith(handler: (url: string) => Response): { source: ODataSource; urls: string[] } {
  const urls: string[] = [];
  const source = new ODataSource({
    baseUrl: BASE,
    username: 'u',
    password: 'p',
    timeoutSeconds: 5,
    fetchImpl: async (url) => {
      urls.push(url);
      return handler(url);
    },
  });
  return { source, urls };
}

describe('paged pull', () => {
  it('follows $top/$skip until a short page and reports the max watermark', async () => {
    const pages = [makeRows(500, 0), makeRows(500, 500), makeRows(120, 1000)];
    const { source, urls } = sourceWith((url) => {
      const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] ?? '0');
      return json({ value: pages[skip / 500] ?? [] });
    });

    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const tracker = new WatermarkTracker('timestamp', timestamps, 'unit_steps');
    const collected: Record<string, unknown>[] = [];

    const summary = await pullPages(
      source,
      {
        entitySet: 'UnitProcessHistory',
        filter: 'CompletedDate ge 2025-01-01T00:00:00Z',
        orderBy: 'CompletedDate asc',
        select: ['UnitSerial', 'CompletedDate'],
        pageSize: 500,
        maxPages: 50,
      },
      (rows) => {
        collected.push(...rows);
        for (const row of rows) tracker.observe(row.CompletedDate);
      },
    );

    expect(summary.rows).toBe(1120);
    expect(summary.pages).toBe(3);
    expect(summary.truncated).toBe(false);
    expect(collected).toHaveLength(1120);
    expect(urls).toHaveLength(3);
    expect(urls[0]).not.toContain('$skip=');
    expect(urls[1]).toContain('$skip=500');
    expect(urls[2]).toContain('$skip=1000');
    expect(tracker.serialize()).toBe(new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + 1119 * 60_000).toISOString());
  });

  it('follows @odata.nextLink instead of $skip when the service returns one', async () => {
    const { source, urls } = sourceWith((url) => {
      if (url.includes('$skiptoken=page2')) return json({ value: makeRows(1, 100) });
      return json({ value: makeRows(2, 0), '@odata.nextLink': 'UnitProcessHistory?$skiptoken=page2' });
    });

    const summary = await pullPages(
      source,
      { entitySet: 'UnitProcessHistory', filter: null, orderBy: null, select: null, pageSize: 500, maxPages: 10 },
      () => undefined,
    );

    expect(summary.rows).toBe(3);
    expect(summary.pages).toBe(2);
    expect(urls[1]).toBe(`${BASE}/UnitProcessHistory?$skiptoken=page2`);
  });

  it('stops at the page cap and reports truncation', async () => {
    const { source } = sourceWith(() => json({ value: makeRows(500, 0) }));
    const summary = await pullPages(
      source,
      { entitySet: 'Things', filter: null, orderBy: null, select: null, pageSize: 500, maxPages: 3 },
      () => undefined,
    );
    expect(summary.pages).toBe(3);
    expect(summary.truncated).toBe(true);
  });

  it('surfaces HTTP failures as errors', async () => {
    const source = new ODataSource({
      baseUrl: BASE,
      username: 'u',
      password: 'p',
      timeoutSeconds: 5,
      fetchImpl: async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    });
    await expect(
      pullPages(source, { entitySet: 'Things', pageSize: 10, maxPages: 1 }, () => undefined),
    ).rejects.toThrow(/401/);
  });
});

describe('watermark tracking', () => {
  it('keeps the largest numeric id', () => {
    const timestamps = new TimestampResolver({ mode: 'utc', timezone: 'UTC' });
    const tracker = new WatermarkTracker('number', timestamps, 'defects');
    tracker.observe('10');
    tracker.observe(42);
    tracker.observe('7');
    expect(tracker.serialize()).toBe('42');
  });
});
