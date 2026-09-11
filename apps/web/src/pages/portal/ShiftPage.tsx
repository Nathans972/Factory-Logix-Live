/** Shift view — the portal landing page (spec 9.2). */
import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ShiftViewQuery } from '../../data/DataSource';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDate, formatHours, formatPct, formatTime } from '../../lib/format';
import { Empty, ErrorBox, PageHeader, Panel, Spinner, Stat, Tabs } from '../../ui';
import { FilterBar, type ShiftFilters } from './components/FilterBar';
import { RollupTable } from './components/RollupTable';
import { ShiftJobPanel } from './components/ShiftJobPanel';
import { ShiftPicker } from './components/ShiftPicker';

type TabKey = 'job' | 'operation' | 'operator';

const FILTER_KEYS = ['job', 'product', 'operation', 'operator'] as const;

export function ShiftPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>('job');

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
  const subtitle = v
    ? `${v.shift.name} · ${formatDate(v.shift.start_utc, tz)} · ${formatTime(v.shift.start_utc, tz)} – ${formatTime(v.shift.end_utc, tz)}${v.in_progress ? ' · in progress' : ''}`
    : 'Loading shift…';

  return (
    <>
      <PageHeader title="Shift view" subtitle={subtitle} />

      <Panel title="Shift & filters">
        <div className="picker-row mb">
          <ShiftPicker date={date} shiftId={shiftId} shifts={picker.data?.shifts ?? []} onChange={pickShift} />
        </div>
        <FilterBar initial={initialFilters} onChange={applyFilters} />
      </Panel>

      {picker.isError && <ErrorBox error={picker.error} />}
      {view.isError && <ErrorBox error={view.error} />}
      {!v && !view.isError && <Spinner />}

      {v && (
        <>
          <div className="grid grid-6 mb">
            <Stat
              label="Efficiency"
              value={formatPct(v.summary.efficiency)}
              color={v.summary.color}
              hint={`${formatHours(v.summary.total_earned_hours)} earned`}
            />
            <Stat label="Units" value={v.summary.total_units} />
            <Stat label="Charged hours" value={formatHours(v.summary.total_charged_hours)} />
            <Stat label="Active jobs" value={v.summary.active_jobs} />
            <Stat label="Eligible operators" value={v.summary.eligible_operators} />
            <Stat
              label="Rows without std"
              value={v.summary.rows_without_std > 0 ? `⚑ ${v.summary.rows_without_std}` : '0'}
              hint={v.summary.rows_without_std > 0 ? 'excluded from efficiency' : undefined}
            />
          </div>

          {v.jobs.length === 0 ? (
            <Empty>No active jobs in this shift.</Empty>
          ) : (
            v.jobs.map((section) => <ShiftJobPanel key={section.job_number} section={section} />)
          )}

          <Panel title="Breakdown">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { value: 'job', label: 'By job' },
                { value: 'operation', label: 'By operation' },
                { value: 'operator', label: 'By operator' },
              ]}
            />
            {tab === 'job' && <RollupTable rows={v.rollups.by_job} label="Job" exportName={`shift-${v.shift.date}-by-job`} />}
            {tab === 'operation' && (
              <RollupTable rows={v.rollups.by_operation} label="Operation" exportName={`shift-${v.shift.date}-by-operation`} />
            )}
            {tab === 'operator' && (
              <RollupTable rows={v.rollups.by_operator} label="Operator" exportName={`shift-${v.shift.date}-by-operator`} />
            )}
          </Panel>
        </>
      )}
    </>
  );
}
