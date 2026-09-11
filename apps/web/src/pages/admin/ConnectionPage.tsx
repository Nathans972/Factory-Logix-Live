/**
 * FactoryLogix connection + collector settings (spec 10.4, 5.5, 11).
 * The credentials live in `fl_connection`; everything else is a row of `settings`.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsPatch } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { Button, PageHeader, Panel, Spinner } from '../../ui';
import {
  AdminOnly,
  ApiError,
  BackfillBar,
  ConfirmModal,
  Flash,
  TIMEZONE_DATALIST_ID,
  TimeZoneDatalist,
  isValidTimeZone,
  useFlash,
} from './components/common';
import { ConnectionForm } from './components/ConnectionForm';
import { SettingsForm, type SettingsFieldDef } from './components/SettingsForm';

const TIMESTAMP_MODES = [
  { value: 'offset_present', label: 'Offset present', hint: 'Timestamps carry a UTC offset and are parsed as sent.' },
  { value: 'utc', label: 'UTC, no offset', hint: 'Naive timestamps are read as UTC.' },
  {
    value: 'local_no_offset',
    label: 'Plant-local, no offset',
    hint: 'Naive timestamps are read as plant-local; the repeated hour on fall-back night is resolved by row order.',
  },
];

const CONNECTION_SETTINGS: SettingsFieldDef[] = [
  {
    key: 'fl_timestamp_mode',
    label: 'Timestamp mode',
    kind: 'select',
    options: TIMESTAMP_MODES,
    wide: true,
  },
  {
    key: 'plant_timezone',
    label: 'Plant time zone',
    kind: 'text',
    list: TIMEZONE_DATALIST_ID,
    hint: 'IANA name, e.g. America/New_York. Every hour boundary, shift and break is evaluated in this zone.',
    validate: (v) => (isValidTimeZone(v) ? null : 'Not a valid IANA time zone'),
    wide: true,
  },
  { key: 'poll_interval_seconds', label: 'Poll interval (seconds)', kind: 'int', min: 30, max: 600, hint: '60–180 recommended.' },
  { key: 'poll_page_size', label: 'Page size ($top)', kind: 'int', min: 50, max: 5000 },
  { key: 'poll_overlap_minutes', label: 'Poll overlap (minutes)', kind: 'int', min: 0, max: 240, hint: 'Re-read this far behind the watermark.' },
  { key: 'late_data_hours', label: 'Late data depth (hours)', kind: 'int', min: 0, max: 168, hint: 'Hourly re-pull depth for edits that arrive late.' },
  { key: 'odata_timeout_seconds', label: 'OData timeout (seconds)', kind: 'int', min: 5, max: 300 },
  { key: 'breaker_failure_threshold', label: 'Breaker failure threshold', kind: 'int', min: 1, max: 20, hint: 'Consecutive failures before the circuit opens.' },
  { key: 'breaker_max_backoff_minutes', label: 'Breaker max backoff (minutes)', kind: 'int', min: 1, max: 120 },
  { key: 'backfill_days', label: 'Backfill days', kind: 'int', min: 0, max: 3650 },
  { key: 'backfill_pause_seconds', label: 'Backfill pause (seconds)', kind: 'int', min: 0, max: 600, hint: 'Pause between backfill pages to spare the server.' },
  { key: 'backfill_window', sub: 'start', label: 'Backfill window start', kind: 'time', hint: 'Plant local.' },
  { key: 'backfill_window', sub: 'end', label: 'Backfill window end', kind: 'time', hint: 'Plant local; may be past midnight.' },
];

export function ConnectionPage() {
  return (
    <AdminOnly title="FactoryLogix connection">
      <ConnectionPageInner />
    </AdminOnly>
  );
}

function ConnectionPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();
  const [confirmBackfill, setConfirmBackfill] = useState(false);

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => ds.settings() });
  const healthQ = useQuery({ queryKey: ['syncHealth'], queryFn: () => ds.syncHealth(), refetchInterval: 15_000 });

  const saveM = useMutation({
    mutationFn: (patch: SettingsPatch) => ds.updateSettings(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Settings saved.');
    },
  });

  const backfillM = useMutation({
    mutationFn: () => ds.runBackfill(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['syncHealth'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      setConfirmBackfill(false);
      flash.show('Backfill requested.');
    },
  });

  return (
    <>
      <PageHeader title="FactoryLogix connection" subtitle="Credentials, polling behaviour and the historical backfill." />
      <Flash message={flash.message} />
      <TimeZoneDatalist />

      <Panel title="Server">
        <ConnectionForm />
      </Panel>

      <Panel title="Collector settings">
        {settingsQ.isLoading && <Spinner />}
        {settingsQ.isError && <ApiError error={settingsQ.error} />}
        {settingsQ.data && (
          <SettingsForm
            settings={settingsQ.data.settings}
            fields={CONNECTION_SETTINGS}
            onSave={(patch) => saveM.mutate(patch)}
            saving={saveM.isPending}
            error={saveM.error}
          />
        )}
      </Panel>

      <Panel
        title="Backfill"
        actions={
          <Button variant="primary" onClick={() => setConfirmBackfill(true)}>
            Run backfill now
          </Button>
        }
      >
        <p className="hint-line">
          The backfill walks history one day at a time inside the backfill window. Running it now ignores the window and
          starts immediately, which puts load on the FactoryLogix server.
        </p>
        {healthQ.isError && <ApiError error={healthQ.error} />}
        {healthQ.isLoading ? <Spinner /> : <BackfillBar backfill={healthQ.data?.backfill ?? null} tz={tz} />}
      </Panel>

      <ConfirmModal
        open={confirmBackfill}
        title="Run backfill now"
        confirmLabel="Run now"
        busy={backfillM.isPending}
        error={backfillM.error}
        onClose={() => setConfirmBackfill(false)}
        onConfirm={() => backfillM.mutate()}
        body={
          <p>
            Start the historical backfill immediately, outside the configured off-shift window? Live polling continues
            while it runs.
          </p>
        }
      />
    </>
  );
}
