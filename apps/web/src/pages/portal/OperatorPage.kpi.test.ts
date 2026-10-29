import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_ENGINE_SETTINGS, type HourCell, type ShiftInstance } from '@fld/shared';
import { buildOperatorDetail, buildShiftView, colorForPace, hourColumns } from '@fld/engine';
import type { DataSource } from '../../data/DataSource';
import { DataSourceProvider } from '../../data/DataSourceContext';
import { AuthProvider } from '../../auth/AuthContext';
import { formatPct } from '../../lib/format';
import { OperatorPage } from './OperatorPage';

const TZ = 'America/New_York';
const settings = { ...DEFAULT_ENGINE_SETTINGS, plant_timezone: TZ };
const HOUR = 3_600_000;

const SHIFT: ShiftInstance = {
  shift_id: 1,
  name: 'Day',
  date: '2025-06-10',
  start_utc: Date.parse('2025-06-10T07:00-04:00'),
  end_utc: Date.parse('2025-06-10T19:00-04:00'),
};
const NOW = Date.parse('2025-06-10T20:00-04:00');

function cell(hourIso: string, job: string, op: string, std: number, units: number): HourCell {
  const target = (std * 60) / 60;
  const pace = units / target;
  return {
    hour_start_utc: Date.parse(hourIso),
    job_number: job,
    product_number: 'Z1',
    operation: op,
    operator_id: 'OP1',
    units,
    work_minutes: 60,
    window_minutes: 60,
    break_minutes: 0,
    charged_minutes: 60,
    eligible: true,
    provisional: false,
    std_hr: std,
    target_units: target,
    pace,
    color: colorForPace(pace, settings),
  };
}

// One operator, one shift, no visitors, no standard changes: an hour on a fast operation
// (Label, StdHr 60) at half pace, and an hour on a slow one (Hand solder, StdHr 6) at 150%.
const cells: HourCell[] = [
  cell('2025-06-10T08:00-04:00', 'JA', 'Label', 60, 30),
  cell('2025-06-10T09:00-04:00', 'JB', 'Hand solder', 6, 9),
];

const shiftView = buildShiftView({
  shift: SHIFT,
  cells,
  work_orders: [],
  routes: {},
  active_job_numbers: ['JA', 'JB'],
  operator_names: { OP1: 'Alice' },
  derived_qty_complete: {},
  filters: {},
  settings,
  now: NOW,
});

const detail = buildOperatorDetail({
  operator_id: 'OP1',
  operator_name: 'Alice',
  cells,
  columns: hourColumns(SHIFT.end_utc - 12 * HOUR, SHIFT.end_utc, TZ),
  assignment: null,
  pins: [],
  product_names: {},
  settings,
  now: NOW,
  range: { from_utc: SHIFT.start_utc, to_utc: SHIFT.end_utc },
});

/** Render /operators/OP1 for the Day shift with the operator detail already in the query cache. */
function renderOperatorPage(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['health'], { plant_timezone: TZ });
  qc.setQueryData(['operatorDetail', 'OP1', { date: SHIFT.date, shift_id: SHIFT.shift_id }], detail);
  const ds = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as unknown as DataSource;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(DataSourceProvider, {
        value: ds,
        children: createElement(
          AuthProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/operators/OP1?mode=shift&date=${SHIFT.date}&shift_id=${SHIFT.shift_id}`] },
            createElement(Routes, null, createElement(Route, { path: '/operators/:id', element: createElement(OperatorPage) })),
          ),
        ),
      }),
    ),
  );
}

describe('operator page KPI vs shift view for the same operator and shift', () => {
  const byOperator = shiftView.rollups.by_operator.find((r) => r.operator_id === 'OP1')!;

  it('shift view: earned 0.5 h + 1.5 h over 2 charged hours = 100% (precondition)', () => {
    expect(byOperator.efficiency).toBeCloseTo(1, 6);
    expect(byOperator.color).toBe('green');
  });

  it('operator page headline figure matches the shift view (CALCULATIONS.md section 10: earned hours, not summed units)', () => {
    const html = renderOperatorPage();
    const kpi = /<div class="kpi(?: kpi-(\w+))?"><div class="kpi-label">Pace<\/div><div class="kpi-value">([^<]*)<\/div>/.exec(html);
    expect(kpi, 'Pace KPI tile rendered').not.toBeNull();
    const [, accent, value] = kpi!;
    expect(value).toBe(formatPct(byOperator.efficiency));
    expect(accent).toBe(byOperator.color);
  });
});
