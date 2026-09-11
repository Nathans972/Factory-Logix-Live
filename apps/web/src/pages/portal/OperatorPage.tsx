/** Operator detail: 12-hour strips, range table and manager pins (spec 9.4). */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperatorRangeRow, PinMode } from '@fld/shared';
import type { OperatorDetailQuery } from '../../data/DataSource';
import { useDataSource } from '../../data/DataSourceContext';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime, formatHours, formatMinutes, formatTime } from '../../lib/format';
import {
  Button,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  PaceChip,
  Panel,
  Select,
  Spinner,
  type Column,
} from '../../ui';
import { CellStrip, CellStripLabels } from './components/CellStrip';
import { ShiftPicker } from './components/ShiftPicker';

type RangeMode = '12h' | 'shift' | 'custom';

function msFromLocalInput(v: string): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
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

  const columns: Column<OperatorRangeRow>[] = [
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job_number,
      render: (r) => <Link to={`/jobs/${encodeURIComponent(r.job_number)}`}>{r.job_number}</Link>,
    },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <span className="stack">
          <Link to={`/products/${encodeURIComponent(r.product_number)}`}>{r.product_number}</Link>
          <span className="sub">{r.product_name ?? ''}</span>
        </span>
      ),
    },
    { key: 'operation', header: 'Operation', render: (r) => r.operation },
    { key: 'std', header: 'StdHr', align: 'right', value: (r) => r.std_hr, render: (r) => (r.std_hr == null ? <span className="tag">no std</span> : r.std_hr.toFixed(1)) },
    { key: 'window', header: 'Window', align: 'right', value: (r) => Math.round(r.window_minutes), render: (r) => formatMinutes(r.window_minutes) },
    { key: 'charged', header: 'Charged', align: 'right', value: (r) => Math.round(r.charged_minutes), render: (r) => formatMinutes(r.charged_minutes) },
    { key: 'units', header: 'Units', align: 'right', render: (r) => r.units },
    { key: 'target', header: 'Target', align: 'right', value: (r) => Math.round(r.target_units), render: (r) => Math.round(r.target_units) },
    { key: 'pace', header: 'Pace', align: 'right', value: (r) => r.pace, render: (r) => <PaceChip pace={r.pace} color={r.color} /> },
    {
      key: 'hours',
      header: 'Eligible / visitor h',
      align: 'right',
      value: (r) => r.eligible_hours,
      render: (r) => `${formatHours(r.eligible_hours, 1)} / ${formatHours(r.visitor_hours, 1)}`,
    },
    {
      key: 'pinned',
      header: 'Pin',
      value: (r) => r.pinned ?? '',
      render: (r) => (
        <span className="actions">
          {r.pinned && <span className="tag">{r.pinned === 'force_eligible' ? 'eligible' : 'visitor'}</span>}
          {isManager && (
            <Button size="sm" variant="ghost" onClick={() => openPin(r)}>
              Pin…
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={d?.operator_name ?? id}
        subtitle={
          d ? (
            <span>
              {id}
              {d.assignment && d.assignment.job_number ? (
                <>
                  {' · on '}
                  <Link to={`/jobs/${encodeURIComponent(d.assignment.job_number)}`}>{d.assignment.job_number}</Link>
                  {d.assignment.operation ? ` · ${d.assignment.operation}` : ''}
                  {d.assignment.assigned_since ? ` · since ${formatTime(d.assignment.assigned_since, tz)}` : ''}
                  {d.assignment.last_scan_at ? ` · last scan ${formatTime(d.assignment.last_scan_at, tz, true)}` : ''}
                </>
              ) : (
                ' · not currently assigned'
              )}
            </span>
          ) : (
            'Loading…'
          )
        }
      />

      <Panel title="Range">
        <div className="picker-row">
          <Field label="Range">
            <Select value={mode} onChange={(e) => setParam({ mode: e.target.value })}>
              <option value="12h">Last 12 hours</option>
              <option value="shift">Shift</option>
              <option value="custom">Custom</option>
            </Select>
          </Field>
          {mode === 'shift' && (
            <ShiftPicker
              date={date}
              shiftId={shiftId}
              shifts={picker.data?.shifts ?? []}
              onChange={(dt, sid) => setParam({ date: dt, shift_id: sid == null ? null : String(sid) })}
            />
          )}
          {mode === 'custom' && (
            <>
              <Field label="From">
                <Input type="datetime-local" value={from} onChange={(e) => setParam({ from: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="datetime-local" value={to} onChange={(e) => setParam({ to: e.target.value })} />
              </Field>
            </>
          )}
          {d && (
            <span className="sub">
              {formatDateTime(d.range.from_utc, tz)} – {formatDateTime(d.range.to_utc, tz)}
            </span>
          )}
        </div>
      </Panel>

      {detail.isError && <ErrorBox error={detail.error} />}
      {!d && !detail.isError && <Spinner />}

      {d && (
        <>
          <Panel title="Hourly cells">
            {d.strips.length === 0 ? (
              <Empty>No scans in this range.</Empty>
            ) : (
              d.strips.map((s) => (
                <div className="strip" key={`${s.job_number}|${s.operation}`}>
                  <div className="strip-meta">
                    <div className="t">
                      <Link to={`/jobs/${encodeURIComponent(s.job_number)}`}>{s.job_number}</Link> · {s.operation}
                    </div>
                    <div className="sub">
                      {s.product_number} · StdHr {s.std_hr == null ? '—' : s.std_hr.toFixed(1)} · {s.total_units} units
                    </div>
                  </div>
                  <div>
                    <CellStripLabels cells={s.cells} tz={tz} />
                    <CellStrip cells={s.cells} tz={tz} />
                  </div>
                </div>
              ))
            )}
          </Panel>

          <DataTable
            title="Jobs and operations in range"
            columns={columns}
            rows={d.rows}
            rowKey={(r) => `${r.job_number}|${r.operation}`}
            exportName={`operator-${id}-range`}
            defaultSort={{ key: 'charged', dir: 'desc' }}
            emptyMessage="No activity in this range"
            rowClassName={(r) => (r.visitor_hours > 0 && r.eligible_hours === 0 ? 'row-visitor' : undefined)}
          />

          {isManager && (
            <Panel title="Active pins">
              {pinError && <div className="inline-err mb">{pinError}</div>}
              {pins.isError && <ErrorBox error={pins.error} />}
              {pins.data && pins.data.pins.length === 0 && <Empty>No pins for this operator.</Empty>}
              {pins.data && pins.data.pins.length > 0 && (
                <ul className="pin-list">
                  {pins.data.pins.map((p) => (
                    <li key={p.id}>
                      <Link to={`/jobs/${encodeURIComponent(p.job_number)}`}>{p.job_number}</Link>
                      <span className="sub">{p.operation ?? 'any operation'}</span>
                      <span className="tag">{p.mode === 'force_eligible' ? 'force eligible' : 'force visitor'}</span>
                      <span className="sub">
                        {p.expires_at ? `expires ${formatDateTime(p.expires_at, tz)}` : 'no expiry'}
                        {p.created_by ? ` · by ${p.created_by}` : ''}
                      </span>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => void removePin(p.id)}>
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </>
      )}

      <Modal
        open={pinRow != null}
        title={`Pin ${d?.operator_name ?? id} on ${pinRow?.job_number ?? ''}`}
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
        {pinError && <div className="inline-err mb">{pinError}</div>}
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
