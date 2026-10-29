/**
 * Paged pull loop (spec 4.5): `$top`/`$skip` client-driven paging, following `@odata.nextLink`
 * when the service also pages on its side. `$top` still caps a server-paged answer: the links
 * stop once `$top` rows are out, even when more rows match. So only a request that came back
 * short, its links included, can be the last one. A short answer is not the end either when the
 * service has a result limit below `$top` and stops there without a nextLink. Until a request of
 * the pull has come back full, the pull asks again past a short answer's rows and ends only at an
 * empty answer, or at one that repeats it (a service that ignores `$skip`). Pages are handed to
 * `onRows` as they arrive so memory stays flat; `onRows` returning false ends the pull there.
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
  /** A request of this pull came back full: the service sends `$top` rows when it has them. */
  let fullAnswer = false;
  /** The first row of the current request's answer, as JSON. */
  let requestFirst: string | null = null;
  /** The current request asks past a short answer: that answer's first row, as JSON. */
  let afterShort: string | null = null;
  let nextLink: string | null = null;
  let truncated = false;

  for (;;) {
    if (pages >= req.maxPages) {
      truncated = true;
      break;
    }
    const linked = nextLink !== null;
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
    if (!linked) {
      requestFirst = page.rows.length > 0 ? JSON.stringify(page.rows[0]) : null;
      // A service that ignores `$skip` answers the request past a short answer with that answer
      // again: it was the end, and asking on would read it again up to the page cap.
      if (requestFirst !== null && requestFirst === afterShort) break;
    }
    rows += page.rows.length;
    requestRows += page.rows.length;
    if ((await onRows(page.rows, pages - 1)) === false) break;

    if (page.nextLink) {
      nextLink = page.nextLink;
      continue;
    }
    // A short answer says the data source ran out once the service has answered a request in full.
    // Before that it may be a result limit below `$top`, and only an empty answer says so.
    if (requestRows === 0 || (requestRows < pageSize && fullAnswer)) break;
    if (requestRows >= pageSize) fullAnswer = true;
    afterShort = requestRows < pageSize ? requestFirst : null;
    // Skip past every row of the answer: a service that ignores `$top` sent more, one with a
    // result limit below it fewer.
    skip += requestRows;
    requestRows = 0;
    nextLink = null;
  }

  // A cap reached between the nextLinks of one answer goes on after the rows of it already read.
  return { rows, pages, truncated, nextSkip: truncated ? skip + requestRows : null };
}
