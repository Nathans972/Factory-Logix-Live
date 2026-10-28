/** TV pairing / state (spec 8.1-8.2). */
import type { TvState, UtcMs } from '@fld/shared';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { mapDisplay, touchDisplay, type DisplayRow } from '../db/repo/displays.js';
import { getSettings } from '../db/repo/settings.js';
import { ApiError } from '../errors.js';
import { buildDashboard } from './dashboard.js';
import { buildSyncHealth } from './sync-health.js';

/** `${x-forwarded-proto || req.protocol}://${host}/admin` */
export function adminUrlFor(req: FastifyRequest): string {
  const headers = req.headers;
  const forwardedProto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || 'localhost';
  return `${proto}://${host}/admin`;
}

export async function buildTvState(
  db: Db,
  row: DisplayRow,
  adminUrl: string,
  opts: { touch?: boolean; log?: { warn: (obj: unknown, msg: string) => void } } = {},
  now: UtcMs = Date.now(),
): Promise<TvState> {
  if (opts.touch) {
    await touchDisplay(db, row.id);
    row = { ...row, last_seen_at: new Date(now) };
  }

  const settings = await getSettings(db);
  const display = mapDisplay(row, settings.poll_interval_seconds, now);
  const sync = await buildSyncHealth(db, now);

  const status: TvState['status'] = display.claimed_at === null ? 'unclaimed' : display.job_number ? 'assigned' : 'unassigned';

  let dashboard: TvState['dashboard'] = null;
  let jobStatus: TvState['job_status'] = null;
  if (status === 'assigned' && display.job_number) {
    jobStatus = 'ok';
    try {
      dashboard = await buildDashboard(
        db,
        display.job_number,
        {
          grouped: display.group_operators,
          show_std_day: display.show_std_day,
          shift_length_hours: display.shift_length_hours,
        },
        now,
        settings,
      );
    } catch (err) {
      // A job that is not ingested yet (or an engine error) must not take the TV offline.
      dashboard = null;
      if (err instanceof ApiError && err.statusCode === 404) {
        jobStatus = 'not_found';
      } else {
        jobStatus = 'error';
        opts.log?.warn({ err, job_number: display.job_number }, 'could not build the dashboard for this display');
      }
    }
  }

  return {
    status,
    device_token: row.device_token,
    pairing_code: display.pairing_code,
    display,
    dashboard,
    job_status: jobStatus,
    sync: {
      status: sync.status,
      delayed: sync.delayed,
      delayed_since: sync.delayed_since,
      last_success_at: sync.last_success_at,
    },
    server_time: now,
    plant_timezone: settings.plant_timezone,
    admin_url: adminUrl,
  };
}
