/**
 * Paged pull loop (spec 4.5): `$top`/`$skip` client-driven paging, or `@odata.nextLink`
 * server-driven paging when the service returns one. Pages are handed to `onRows` as they
 * arrive so memory stays flat.
 */
import type { Source, SourcePage } from '../sources/Source.js';

export interface PullRequest {
  entitySet: string;
  filter?: string | null;
  orderBy?: string | null;
  select?: string[] | null;
  pageSize: number;
  /** Hard cap so one poll can never run away. */
  maxPages: number;
}

export interface PullSummary {
  rows: number;
  pages: number;
  /** true when the page cap stopped us before the server ran out of rows. */
  truncated: boolean;
}

export async function pullPages(
  source: Source,
  req: PullRequest,
  onRows: (rows: Record<string, unknown>[], pageIndex: number) => Promise<void> | void,
): Promise<PullSummary> {
  const pageSize = Math.max(1, req.pageSize);
  let skip = 0;
  let pages = 0;
  let rows = 0;
  let nextLink: string | null = null;
  let truncated = false;

  for (;;) {
    if (pages >= req.maxPages) {
      truncated = true;
      break;
    }
    const page: SourcePage = nextLink
      ? await source.fetchPage({ entitySet: req.entitySet, nextLink })
      : await source.fetchPage({
          entitySet: req.entitySet,
          filter: req.filter ?? null,
          orderBy: req.orderBy ?? null,
          select: req.select ?? null,
          top: pageSize,
          skip: skip || null,
        });

    pages += 1;
    rows += page.rows.length;
    await onRows(page.rows, pages - 1);

    if (page.nextLink) {
      nextLink = page.nextLink;
      continue;
    }
    if (nextLink) break; // server-driven paging finished
    if (page.rows.length < pageSize) break; // last client-driven page
    skip += pageSize;
  }

  return { rows, pages, truncated };
}
