/**
 * Paged pull loop (spec 4.5): `$top`/`$skip` client-driven paging, following `@odata.nextLink`
 * when the service also pages on its side. `$top` still caps a server-paged answer: the links
 * stop once `$top` rows are out, even when more rows match. So only a request that came back
 * short, its links included, is the last one. Pages are handed to `onRows` as they arrive so
 * memory stays flat; `onRows` returning false ends the pull there.
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
  /** `$skip` of the first request, to go on where an earlier pull stopped at the cap. */
  startSkip?: number;
}

export interface PullSummary {
  rows: number;
  pages: number;
  /** true when the page cap stopped us before the server ran out of rows. */
  truncated: boolean;
  /** When truncated: the `$skip` that goes on right after the last row read. */
  nextSkip: number | null;
}

export async function pullPages(
  source: Source,
  req: PullRequest,
  onRows: (rows: Record<string, unknown>[], pageIndex: number) => Promise<boolean | void> | boolean | void,
): Promise<PullSummary> {
  const pageSize = Math.max(1, req.pageSize);
  let skip = Math.max(0, req.startSkip ?? 0);
  let pages = 0;
  let rows = 0;
  /** Rows the current `$top`/`$skip` request returned, the pages of its nextLinks included. */
  let requestRows = 0;
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
    requestRows += page.rows.length;
    if ((await onRows(page.rows, pages - 1)) === false) break;

    if (page.nextLink) {
      nextLink = page.nextLink;
      continue;
    }
    if (requestRows < pageSize) break; // the data source ran out
    // A full answer. A service that ignores `$top` sent more: skip past all of it.
    skip += requestRows;
    requestRows = 0;
    nextLink = null;
  }

  // A cap reached between the nextLinks of one answer goes on after the rows of it already read.
  return { rows, pages, truncated, nextSkip: truncated ? skip + requestRows : null };
}
