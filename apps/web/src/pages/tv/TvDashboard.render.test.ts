import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TvDashboard as TvDashboardData } from '@fld/shared';
import { TvDashboard } from './TvDashboard';

const cols = Array.from({ length: 12 }, (_, i) => ({ hour_start_utc: 1000 + i * 3600000, label: String(10 + i) }));
const colors = ['blank', 'neutral', 'red', 'yellow', 'green', 'blue', 'visitor'] as const;
const d: TvDashboardData = {
  job: { job_number: 'WO-26-00187', product_number: 'PB-2200', product_name: 'Controller Board', qty_released: 500, qty_complete: 123, progress: 0.246 },
  grouped: false,
  show_std_day: true,
  columns: cols,
  rows: [
    {
      operation: 'Selective Solder - Top', operation_seq: 1, operator_id: 'JRivera', operator_name: 'J Rivera', operators: ['JRivera'],
      std_hr: 30, prior: 30, shift: 118, std_day: 360, visitor_row: false,
      cells: cols.map((c, i) => ({ hour_start_utc: c.hour_start_utc, units: i, color: colors[i % colors.length], pace: 0.9, charged_minutes: 60, eligible: true, visitor: colors[i % colors.length] === 'visitor', provisional: i === 11 })),
    },
    {
      operation: 'Pack', operation_seq: 2, operator_id: 'VISIT', operator_name: null, operators: ['VISIT'],
      std_hr: null, prior: 0, shift: 6, std_day: null, visitor_row: true,
      cells: cols.map((c) => ({ hour_start_utc: c.hour_start_utc, units: 0, color: 'visitor' as const, pace: null, charged_minutes: 2, eligible: false, visitor: true, provisional: false })),
    },
  ],
  defect_rows: [{ operation: 'AOI', operation_seq: 3, prior: 1, cells: cols.map((_, i) => (i === 3 ? 2 : 0)), shift_qty: 2 }],
  generated_at: Date.now(),
};

describe('TvDashboard smoke', () => {
  it('renders separate mode', () => {
    const html = renderToStaticMarkup(createElement(TvDashboard, { dashboard: d, showGauge: true, tz: 'America/New_York', updatedAt: Date.now() }));
    expect(html).toContain('WO-26-00187');
    expect(html).toContain('Qty Complete');
    expect(html).toContain('>Operator<');
    expect(html).toContain('>JRivera<'); // user name, not the display name
    expect(html).not.toContain('J Rivera');
    expect(html).toContain('StdDay');
    expect(html).toContain('tv-c-red');
    expect(html).toContain('tv-provisional');
    expect(html).toContain('>V<');
    expect(html).toContain('24.60%');
    expect(html).toContain('—'); // std_hr null
  });
  it('renders grouped + compact with "Multiple Operators" and no gauge', () => {
    const rows = d.rows.map((r, i) => (i === 0 ? { ...r, operator_id: null, operator_name: null, operators: ['JRivera', 'LNguyen'] } : r));
    const html = renderToStaticMarkup(createElement(TvDashboard, { dashboard: { ...d, grouped: true, show_std_day: false, rows }, showGauge: false, tz: 'UTC', updatedAt: null, compact: true }));
    expect(html).toContain('>Operator<');
    expect(html).toContain('Multiple Operators');
    expect(html).toContain('>VISIT<'); // single-operator grouped row keeps its name
    expect(html).not.toContain('StdDay');
    expect(html).not.toContain('tv-gauge');
    expect(html).toContain('tv-compact');
    expect(html).toContain('updated —');
  });
});
