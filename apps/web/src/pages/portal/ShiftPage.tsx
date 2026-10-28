/** Shift view at /shift (spec 9.2, docs/DESIGN.md "Pages"); Home links here and forwards old `/?date=…` links. */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ShiftViewQuery } from '../../data/DataSource';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatHours, formatInt, formatPct, formatTime } from '../../lib/format';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBox,
  Input,
  KpiRow,
  KpiTile,
  PageHeader,
  Segmented,
  Spinner,
  Tabs,
  cellAccent,
} from '../../ui';
import { FilterBar, type ShiftFilters } from './components/FilterBar';
import { ROLLUP_LABEL, RollupTable, exportRollups, type RollupKind } from './components/RollupTable';
import { ShiftJobPanel } from './components/ShiftJobPanel';

const FILTER_KEYS = ['job', 'product', 'operation', 'operator'] as const;

/** "Thu, Sep 11" in plant-local time. */
function formatShiftDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
}

/** "Day" → "Day shift"; a name that already says "shift" is left alone. */
function shiftLabel(name: string): string {
  return /shift/i.test(name) ? name : `${name} shift`;
}

export function ShiftPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<RollupKind>('job');

  const picker = useQuery({ queryKey: ['shiftPicker'], queryFn: () => ds.shiftPicker(), staleTime: 60_000 });
  const fallbackShift = picker.data?.current ?? picker.data?.most_recent ?? null;

  const dateParam = params.get('date');
  const shiftParam = params.get('shift_id');
  const date = dateParam ?? fallbackShift?.date ?? '';
  const shiftId = shiftParam ? Number(shiftParam) : (fallbackShift?.shift_id ?? null);

  const filters: ShiftFilters = {
    job: params.get('job') ?? '',
    product: params.get('product') ?? '',
    operation: params.get('operation') ?? '',
    operator: params.get('operator') ?? '',
  };
  const [initialFilters] = useState(filters);

  const query: ShiftViewQuery = {
    date: date || null,
    shift_id: shiftId,
    job: filters.job || null,
    product: filters.product || null,
    operation: filters.operation || null,
    operator: filters.operator || null,
  };

  const view = useQuery({
    queryKey: ['shiftView', query],
    queryFn: () => ds.shiftView(query),
    enabled: !picker.isLoading,
    placeholderData: keepPreviousData,
  });

  // Live only while the selected shift is in progress; past shifts are static (spec 9.2).
  useLiveRefetch(view.data?.in_progress ? ['data_updated'] : []);

  const appliedRef = useRef(FILTER_KEYS.map((k) => filters[k]).join('|~|'));

  const applyFilters = useCallback(
    (f: ShiftFilters) => {
      const signature = FILTER_KEYS.map((k) => f[k]).join('|~|');
      if (signature === appliedRef.current) return;
      appliedRef.current = signature;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of FILTER_KEYS) {
            if (f[k]) next.set(k, f[k]);
            else next.delete(k);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const pickShift = (d: string, sid: number | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (d) next.set('date', d);
      else next.delete('date');
      if (sid == null) next.delete('shift_id');
      else next.set('shift_id', String(sid));
      return next;
    });
  };

  const v = view.data;
  const shifts = picker.data?.shifts ?? [];

  const breakdownRows = useMemo(() => {
    if (!v) return [];
    if (tab === 'operation') return v.rollups.by_operation;
    if (tab === 'operator') return v.rollups.by_operator;
    return v.rollups.by_job;
  }, [v, tab]);

  const subtitle = v ? (
    <>
      {shiftLabel(v.shift.name)} · {formatShiftDay(v.shift.start_utc, tz)} · {formatTime(v.shift.start_utc, tz)} –{' '}
      {formatTime(v.shift.end_utc, tz)} ·{' '}
      {v.in_progress ? (
        <b className="shift-state live">In progress</b>
      ) : (
        <b className="shift-state ended">Ended {formatTime(v.shift.end_utc, tz)}</b>
      )}
    </>
  ) : (
    'Loading shift…'
  );

  const products = v ? new Set(v.jobs.map((j) => j.product_number)).size : 0;
  const visitorUnits = v?.rollups.overall.visitor_units ?? 0;
  // counted in charged hours but left out of efficiency (spec 7.11)
  const noStdHours = v?.summary.charged_hours_without_std ?? 0;

  return (
    <>
      <PageHeader
        title="Shift view"
        subtitle={subtitle}
        actions={
          <>
            {shifts.length > 0 && (
              <Segmented
                value={shiftId == null ? '' : String(shiftId)}
                onChange={(id) => pickShift(date, id === '' ? null : Number(id))}
                options={shifts.map((s) => ({ value: String(s.id), label: s.name }))}
              />
            )}
            <Input
              type="date"
              className="shift-date"
              aria-label="Shift date"
              value={date}
              onChange={(e) => pickShift(e.target.value, shiftId)}
            />
            <Button
              onClick={() => v && exportRollups(`shift-${v.shift.date}-by-${tab}`, tab, breakdownRows)}
              disabled={!v}
              title="Export the breakdown table shown below"
            >
              Export CSV
            </Button>
          </>
        }
      />

      <FilterBar initial={initialFilters} onChange={applyFilters} />

      {picker.isError && <ErrorBox error={picker.error} />}
      {view.isError && <ErrorBox error={view.error} />}
      {!v && !view.isError && <Spinner />}

      {v && (
        <>
          <KpiRow>
            <KpiTile
              label="Shift efficiency"
              value={formatPct(v.summary.efficiency)}
              accent={cellAccent(v.summary.color)}
              hint={`${formatHours(v.summary.total_earned_hours, 1)} earned / ${formatHours(v.summary.total_charged_hours - noStdHours, 1)} charged${noStdHours > 0 ? ' with a StdHr' : ''}`}
            />
            <KpiTile
              label="Units completed"
              value={formatInt(v.summary.total_units)}
              hint={`${v.rollups.by_operation.length} operation${v.rollups.by_operation.length === 1 ? '' : 's'}`}
            />
            <KpiTile
              label="Charged hours"
              value={formatHours(v.summary.total_charged_hours, 1)}
              hint={`${v.summary.eligible_operators} eligible operator${v.summary.eligible_operators === 1 ? '' : 's'}`}
            />
            <KpiTile label="Active jobs" value={v.summary.active_jobs} hint={`${products} product${products === 1 ? '' : 's'}`} />
            <KpiTile
              label="Visitor units"
              value={formatInt(visitorUnits)}
              hint={visitorUnits > 0 ? 'Excluded from efficiency' : 'No visitor scans'}
            />
            <KpiTile
              label="Rows without standard"
              value={v.summary.rows_without_std}
              accent={v.summary.rows_without_std > 0 ? 'amber' : 'none'}
              hint={v.summary.rows_without_std > 0 ? `${formatHours(noStdHours, 1)} excluded from efficiency` : 'Every operation has a StdHr'}
            />
          </KpiRow>

          {v.jobs.length === 0 ? (
            <Card>
              <EmptyState title="No active jobs in this shift" hint="Nothing was scanned in this window, or the filters exclude every job." />
            </Card>
          ) : (
            v.jobs.map((section) => <ShiftJobPanel key={section.job_number} section={section} />)
          )}

          <Card>
            <CardHeader
              title="Breakdown"
              badges={
                <span className="card-tabs">
                  <Tabs
                    value={tab}
                    onChange={setTab}
                    tabs={[
                      { value: 'job', label: 'By job' },
                      { value: 'operation', label: 'By operation' },
                      { value: 'operator', label: 'By operator' },
                    ]}
                  />
                </span>
              }
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => exportRollups(`shift-${v.shift.date}-by-${tab}`, tab, breakdownRows)}
                  title={`Export the ${ROLLUP_LABEL[tab].toLowerCase()} breakdown as CSV`}
                >
                  Export CSV
                </Button>
              }
            />
            <div className="card-body">
              <RollupTable rows={breakdownRows} kind={tab} />
            </div>
          </Card>
        </>
      )}
    </>
  );
}
