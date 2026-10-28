import { describe, expect, it } from 'vitest';
import type { HourCell, TvDashboard } from '@fld/shared';
import { buildJobDetail, listShiftInstances } from '../src/index.js';
import { HOUR, TZ, engineSettings, hourCell, ms, shiftDef } from './helpers.js';

/**
 * buildJobDetail runs once per Job page request (and again on every data_updated event while the
 * page is open). Its shift history must cost about one pass over the job's cells, not one pass
 * per shift instance: a job that has run for a year has more than a thousand shift instances.
 */
describe('buildJobDetail on a long-running job', () => {
  it('reads each hour cell a bounded number of times however many shift instances there are', () => {
    const first = ms('2026-09-01T00:00:00Z');
    const pairsPerHour = 30; // operator/operation pairs active in every hour
    const cells: HourCell[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      cells.push(
        hourCell({
          hour: first + Math.floor(i / pairsPerHour) * HOUR,
          op: `Op${i % 10}`,
          operator: `E${i % pairsPerHour}`,
          units: 5,
        }),
      );
    }
    const last = cells[cells.length - 1]!.hour_start_utc + HOUR;
    const shifts = [
      shiftDef({ id: 1, name: 'Day', start_local: '06:00', end_local: '14:00' }),
      shiftDef({ id: 2, name: 'Evening', start_local: '14:00', end_local: '22:00' }),
      shiftDef({ id: 3, name: 'Night', start_local: '22:00', end_local: '06:00' }),
    ];
    const instances = listShiftInstances(shifts, first, last, TZ);
    expect(instances.length).toBeGreaterThan(80);

    let reads = 0;
    const counted = new Proxy(cells, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          const c = prop.charCodeAt(0);
          if (c >= 48 && c <= 57) reads += 1; // an element read, not `length` or a method
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const detail = buildJobDetail({
      dashboard_separate: {} as TvDashboard,
      dashboard_grouped: {} as TvDashboard,
      all_cells: counted,
      shift_instances: instances,
      operator_names: {},
      displays_showing: [],
      settings: engineSettings(),
      now: last,
    });

    expect(detail.shift_history.length).toBeGreaterThan(80);
    // One pass for the operator totals plus a sweep for the shifts is a handful of reads per cell.
    // Filtering every cell once per shift instance is about 84 reads per cell here, and grows with
    // the length of the job (about 1,100 per cell after a year).
    expect(reads).toBeLessThan(10 * cells.length);
  });
});
