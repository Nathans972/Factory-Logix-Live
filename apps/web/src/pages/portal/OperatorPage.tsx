/**
 * Operator detail (spec 9.4): breadcrumb → name + current assignment → range picker → KPI row →
 * hourly strips, the range table (with manager pins) and the active pins card.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CellColor, OperatorRangeRow, PinMode } from '@fld/shared';
import type { OperatorDetailQuery } from '../../data/DataSource';
import { useDataSource } from '../../data/DataSourceContext';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { downloadCsv } from '../../lib/csv';
import { formatDateTime, formatInt, formatMinutes, formatNum, formatPct, formatTime } from '../../lib/format';
import {
  Breadcrumbs,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  KpiRow,
  KpiTile,
  Modal,
  Note,
  PaceChip,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  StatusBadge,
  cellAccent,
  type Column,
} from '../../ui';
import { CellStrip } from './components/CellStrip';
import { formatStd } from '../tv/tvLogic';

type RangeMode = '12h' | 'shift' | 'custom';

const RANGE_OPTIONS: { value: RangeMode; label: string }[] = [
  { value: '12h', label: 'Last 12 hours' },
  { value: 'shift', label: 'Shift' },
  { value: 'custom', label: 'Custom' },
];

function msFromLocalInput(v: string): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Pace bands from docs/DESIGN.md, used for the aggregate KPI tile only. */
function paceColor(pace: number | null): CellColor {
  if (pace == null || !Number.isFinite(pace)) return 'neutral';
  if (pace < 0.7) return 'red';
  if (pace < 0.9) return 'yellow';
  if (pace <= 1.05) return 'green';
  return 'blue';
}

export function OperatorPage() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const { user } = useAuth();
  const isManager = hasRole(user, 'manager');
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();

  const mode = (params.get('mode') as RangeMode | null) ?? '12h';
  const date = params.get('date') ?? '';
  const shiftIdParam = params.get('shift_id');
  const shiftId = shiftIdParam ? Number(shiftIdParam) : null;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const setParam = (patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, val] of Object.entries(patch)) {
        if (val == null || val === '') next.delete(k);
        else next.set(k, val);
      }
      return next;
    });
  };

  const picker = useQuery({ queryKey: ['shiftPicker'], queryFn: () => ds.shiftPicker(), staleTime: 60_000, enabled: mode === 'shift' });

  const range: OperatorDetailQuery =
    mode === 'shift'
      ? { date: date || null, shift_id: shiftId }
      : mode === 'custom'
        ? { from: msFromLocalInput(from), to: msFromLocalInput(to) }
        : {};

  const detail = useQuery({
    queryKey: ['operatorDetail', id, range],
    queryFn: () => ds.operatorDetail(id, range),
    placeholderData: keepPreviousData,
  });

  const pins = useQuery({
    queryKey: ['pins', { operator_id: id }],
    queryFn: () => ds.pins({ operator_id: id }),
    enabled: isManager,
  });

  const [pinRow, setPinRow] = useState<OperatorRangeRow | null>(null);
  const [pinMode, setPinMode] = useState<PinMode>('force_eligible');
  const [pinWholeJob, setPinWholeJob] = useState(false);
  const [pinExpires, setPinExpires] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPin = (row: OperatorRangeRow) => {
    setPinRow(row);
    setPinMode(row.pinned ?? 'force_eligible');
    setPinWholeJob(false);
    setPinExpires('');
    setPinError(null);
  };

  const refreshPins = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['pins', { operator_id: id }] }),
      qc.invalidateQueries({ queryKey: ['operatorDetail', id] }),
    ]);
  };

  const savePin = async () => {
    if (!pinRow) return;
    setBusy(true);
    setPinError(null);
    try {
      await ds.createPin({
        operator_id: id,
        job_number: pinRow.job_number,
        operation: pinWholeJob ? null : pinRow.operation,
        mode: pinMode,
        expires_at: msFromLocalInput(pinExpires) ?? null,
      });
      await refreshPins();
      setPinRow(null);
    } catch (e) {
      setPinError(e instanceof Error ? e.message : 'Could not create the pin');
    } finally {
      setBusy(false);
    }
  };

  const removePin = async (pinId: number) => {
    setBusy(true);
    try {
      await ds.deletePin(pinId);
      await refreshPins();
    } catch (e) {
      setPinError(e instanceof Error ? e.message : 'Could not delete the pin');
    } finally {
      setBusy(false);
    }
  };

  const d = detail.data;
  const rows = d?.rows ?? [];
  const units = rows.reduce((s, r) => s + r.units, 0);
  const visitorUnits = rows.reduce((s, r) => s + r.visitor_units, 0);
  const chargedMinutes = rows.reduce((s, r) => s + r.charged_minutes, 0);
  const targetUnits = rows.reduce((s, r) => s + r.target_units, 0);
  const pace = targetUnits > 0 ? units / targetUnits : null;
  const eligibleHours = rows.reduce((s, r) => s + r.eligible_hours, 0);
  const visitorHours = rows.reduce((s, r) => s + r.visitor_hours, 0);

  const columns: Column<OperatorRangeRow>[] = [
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job_number,
      render: (r) => (
        <Link className="link" to={'/jobs/' + encodeURIComponent(r.job_number)}>
          {r.job_number}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <span className="stack">
          <Link className="link" to={'/products/' + encodeURIComponent(r.product_number)}>
            {r.product_number}
          </Link>
          <small>{r.product_name ?? ''}</small>
        </span>
      ),
    },
    { key: 'operation', header: 'Operation', render: (r) => r.operation },
    {
      key: 'std',
      header: 'StdHr',
      align: 'right',
      value: (r) => r.std_hr,
      render: (r) => (r.std_hr == null ? <StatusBadge tone="warn">no std</StatusBadge> : formatStd(r.std_hr)),
    },
    { key: 'window', header: 'Window', align: 'right', value: (r) => Math.round(r.window_minutes), render: (r) => formatMinutes(r.window_minutes) },
    { key: 'charged', header: 'Charged', align: 'right', value: (r) => Math.round(r.charged_minutes), render: (r) => formatMinutes(r.charged_minutes) },
    {
      key: 'units',
      header: 'Units',
      align: 'right',
      value: (r) => r.units,
      render: (r) => (
        <>
          {formatInt(r.units)}
          {r.visitor_units > 0 && <span className="num-note"> (+{formatInt(r.visitor_units)} visitor)</span>}
        </>
      ),
    },
    { key: 'target', header: 'Target', align: 'right', value: (r) => Math.round(r.target_units), render: (r) => formatInt(r.target_units) },
    { key: 'pace', header: 'Pace', align: 'right', value: (r) => r.pace, render: (r) => <PaceChip pace={r.pace} color={r.color} /> },
    {
      key: 'hours',
      header: 'Eligible / visitor h',
      align: 'right',
      value: (r) => r.eligible_hours,
      render: (r) => formatNum(r.eligible_hours, 1) + ' / ' + formatNum(r.visitor_hours, 1),
    },
    {
      key: 'pinned',
      header: 'Pin',
      sortable: false,
      value: (r) => r.pinned ?? '',
      render: (r) => (
        <span className="actions">
          {r.pinned && <StatusBadge tone="info">{r.pinned === 'force_eligible' ? 'eligible' : 'visitor'}</StatusBadge>}
          {isManager && (
            <Button size="sm" variant="ghost" onClick={() => openPin(r)}>
              Pin…
            </Button>
          )}
        </span>
      ),
    },
  ];

  const exportRange = () =>
    downloadCsv(
      'operator-' + id + '-range',
      [
        { header: 'Job', value: (r: OperatorRangeRow) => r.job_number },
        { header: 'Product', value: (r: OperatorRangeRow) => r.product_number },
        { header: 'Operation', value: (r: OperatorRangeRow) => r.operation },
        { header: 'StdHr', value: (r: OperatorRangeRow) => r.std_hr },
        { header: 'Window minutes', value: (r: OperatorRangeRow) => Math.round(r.window_minutes) },
        { header: 'Charged minutes', value: (r: OperatorRangeRow) => Math.round(r.charged_minutes) },
        { header: 'Units', value: (r: OperatorRangeRow) => r.units },
        { header: 'Visitor units', value: (r: OperatorRangeRow) => r.visitor_units },
        { header: 'Target', value: (r: OperatorRangeRow) => Math.round(r.target_units) },
        { header: 'Pace', value: (r: OperatorRangeRow) => (r.pace == null ? '' : Math.round(r.pace * 100) + '%') },
        { header: 'Eligible h', value: (r: OperatorRangeRow) => r.eligible_hours.toFixed(2) },
        { header: 'Visitor h', value: (r: OperatorRangeRow) => r.visitor_hours.toFixed(2) },
      ],
      rows,
    );

  const assignment = d?.assignment ?? null;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Operators', to: '/operators' }, { label: id }]} />

      <PageHeader
        title={
          <>
            {d?.operator_name ?? id}
            <span className="badge badge-neutral">{id}</span>
          </>
        }
        subtitle={
          d ? (
            assignment && assignment.job_number ? (
              <>
                {'on '}
                <Link className="link" to={'/jobs/' + encodeURIComponent(assignment.job_number)}>
                  {assignment.job_number}
                </Link>
                {assignment.operation ? ' · ' + assignment.operation : ''}
                {assignment.assigned_since ? ' · since ' + formatTime(assignment.assigned_since, tz) : ''}
                {assignment.last_scan_at ? ' · last scan ' + formatTime(assignment.last_scan_at, tz) : ''}
              </>
            ) : (
              'Not currently assigned'
            )
          ) : (
            'Loading…'
          )
        }
        actions={
          <>
            <div className="range-controls">
              <Segmented value={mode} onChange={(v) => setParam({ mode: v === '12h' ? null : v })} options={RANGE_OPTIONS} />
              {mode === 'shift' && (
                <>
                  <Input type="date" aria-label="Date" value={date} onChange={(e) => setParam({ date: e.target.value })} />
                  <Select
                    aria-label="Shift"
                    value={shiftId == null ? '' : String(shiftId)}
                    onChange={(e) => setParam({ shift_id: e.target.value })}
                  >
                    <option value="">(current)</option>
                    {(picker.data?.shifts ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.start_local}–{s.end_local})
                      </option>
                    ))}
                  </Select>
                </>
              )}
              {mode === 'custom' && (
                <>
                  <Input type="datetime-local" aria-label="From" value={from} onChange={(e) => setParam({ from: e.target.value })} />
                  <Input type="datetime-local" aria-label="To" value={to} onChange={(e) => setParam({ to: e.target.value })} />
                </>
              )}
            </div>
            <Button disabled={rows.length === 0} onClick={exportRange}>
              Export CSV
            </Button>
          </>
        }
      />

      {detail.isError && <ErrorBox error={detail.error} />}
      {!d && !detail.isError && <Spinner />}

      {d && (
        <>
          <KpiRow>
            <KpiTile
              label="Units in range"
              value={formatInt(units)}
              hint={formatInt(targetUnits) + ' at standard' + (visitorUnits > 0 ? ' · +' + formatInt(visitorUnits) + ' visitor' : '')}
            />
            <KpiTile label="Charged hours" value={formatNum(chargedMinutes / 60, 1)} hint="eligible time against a standard" />
            <KpiTile label="Pace" value={formatPct(pace)} accent={cellAccent(paceColor(pace))} hint={rows.length + ' job/operation rows'} />
            <KpiTile
              label="Eligible / visitor hours"
              value={formatNum(eligibleHours, 1) + ' / ' + formatNum(visitorHours, 1)}
              hint="visitor time is never judged"
            />
          </KpiRow>

          <Card>
            <CardHeader
              title="Hourly cells"
              subtitle={formatDateTime(d.range.from_utc, tz) + ' – ' + formatDateTime(d.range.to_utc, tz)}
            />
            {d.strips.length === 0 ? (
              <EmptyState title="No scans in this range" hint="Pick another shift or widen the custom range." />
            ) : (
              <div className="card-body">
                {d.strips.map((s) => (
                  <div className="strip" key={s.job_number + '|' + s.operation}>
                    <div className="strip-meta">
                      <div className="t">
                        <Link className="link" to={'/jobs/' + encodeURIComponent(s.job_number)}>
                          {s.job_number}
                        </Link>{' '}
                        · {s.operation}
                      </div>
                      <small>
                        {s.product_number} · StdHr {formatStd(s.std_hr)} · {formatInt(s.total_units)} units
                      </small>
                    </div>
                    <CellStrip cells={s.cells} tz={tz} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <DataTable
            title="Jobs and operations in range"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.job_number + '|' + r.operation}
            exportName={'operator-' + id + '-range'}
            defaultSort={{ key: 'charged', dir: 'desc' }}
            emptyMessage="No activity in this range"
            rowClassName={(r) => (r.visitor_hours > 0 && r.eligible_hours === 0 ? 'row-visitor' : undefined)}
          />

          {isManager && (
            <Card>
              <CardHeader title="Active pins" subtitle="Pins override eligibility for this operator" />
              {pinError && (
                <div className="card-body">
                  <Note tone="error">{pinError}</Note>
                </div>
              )}
              {pins.isError && (
                <div className="card-body">
                  <ErrorBox error={pins.error} />
                </div>
              )}
              {pins.data && pins.data.pins.length === 0 && <EmptyState title="No pins for this operator" hint="Pin a row below to force eligible or visitor." />}
              {pins.data?.pins.map((p) => (
                <div className="list-item" key={p.id}>
                  <StatusBadge tone={p.mode === 'force_eligible' ? 'ok' : 'neutral'}>
                    {p.mode === 'force_eligible' ? 'force eligible' : 'force visitor'}
                  </StatusBadge>
                  <div className="list-main">
                    <b>
                      <Link className="link" to={'/jobs/' + encodeURIComponent(p.job_number)}>
                        {p.job_number}
                      </Link>
                    </b>
                    <small>
                      {(p.operation ?? 'any operation') +
                        ' · ' +
                        (p.expires_at ? 'expires ' + formatDateTime(p.expires_at, tz) : 'no expiry') +
                        (p.created_by ? ' · by ' + p.created_by : '')}
                    </small>
                  </div>
                  <div className="right-actions">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void removePin(p.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      <Modal
        open={pinRow != null}
        title={'Pin ' + (d?.operator_name ?? id) + ' on ' + (pinRow?.job_number ?? '')}
        onClose={() => setPinRow(null)}
        footer={
          <>
            <Button onClick={() => setPinRow(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void savePin()}>
              Create pin
            </Button>
          </>
        }
      >
        {pinError && <Note tone="error">{pinError}</Note>}
        <Field label="Mode">
          <Select value={pinMode} onChange={(e) => setPinMode(e.target.value as PinMode)}>
            <option value="force_eligible">Force eligible (count against standard)</option>
            <option value="force_visitor">Force visitor (never judged)</option>
          </Select>
        </Field>
        <Field label="Scope">
          <Select value={pinWholeJob ? 'job' : 'operation'} onChange={(e) => setPinWholeJob(e.target.value === 'job')}>
            <option value="operation">{pinRow?.operation ?? 'This operation'} only</option>
            <option value="job">Any operation on this job</option>
          </Select>
        </Field>
        <Field label="Expires (optional)" hint="Leave blank for a pin that never expires.">
          <Input type="datetime-local" value={pinExpires} onChange={(e) => setPinExpires(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
