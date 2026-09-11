/** Engine settings (spec 10.6 / 11): eligibility, idle, break handling and the colour bands. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsPatch } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { PageHeader, Panel, Spinner } from '../../ui';
import { AdminOnly, ApiError, Flash, useFlash } from './components/common';
import { SettingsForm, type SettingsFieldDef } from './components/SettingsForm';

const ENGINE_SETTINGS: SettingsFieldDef[] = [
  {
    key: 'eligibility_minutes',
    label: 'Eligibility minutes',
    kind: 'number',
    min: 0,
    max: 60,
    hint: 'An operator must work at least this long in an hour to be scored rather than counted as a visitor.',
  },
  {
    key: 'neutral_minutes',
    label: 'Neutral minutes',
    kind: 'number',
    min: 0,
    max: 60,
    hint: 'Below this an hour is shown grey instead of coloured.',
  },
  {
    key: 'idle_timeout_minutes',
    label: 'Idle timeout (minutes)',
    kind: 'number',
    min: 1,
    max: 480,
    hint: 'Gap after which an operator stops accruing charged time. Should exceed the longest break.',
  },
  {
    key: 'count_work_during_breaks',
    label: 'Count work performed during breaks',
    kind: 'boolean',
    hint: 'Off: break minutes are removed from charged time even if scans continue.',
    wide: true,
  },
  {
    key: 'floor_idle_flag_minutes',
    label: 'Floor idle flag (minutes)',
    kind: 'number',
    min: 1,
    hint: 'The floor view flags an operator after this long without a scan.',
  },
  {
    key: 'retention_days_raw_events',
    label: 'Raw event retention (days)',
    kind: 'int-nullable',
    min: 1,
    hint: 'Blank = keep raw events forever.',
  },
  {
    key: 'color_red_below',
    label: 'Red below (%)',
    kind: 'percent',
    min: 0,
    max: 2,
    advanced: true,
    hint: 'Pace under this is red.',
  },
  {
    key: 'color_yellow_below',
    label: 'Yellow below (%)',
    kind: 'percent',
    min: 0,
    max: 2,
    advanced: true,
    hint: 'Pace under this (and at or above red) is yellow; above it is green.',
  },
  {
    key: 'color_blue_above',
    label: 'Blue above (%)',
    kind: 'percent',
    min: 0,
    max: 3,
    advanced: true,
    hint: 'Pace over this is blue (well ahead of standard).',
  },
];

export function EnginePage() {
  return (
    <AdminOnly title="Engine settings">
      <EnginePageInner />
    </AdminOnly>
  );
}

function EnginePageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();

  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => ds.settings() });

  const saveM = useMutation({
    mutationFn: (patch: SettingsPatch) => ds.updateSettings(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      flash.show('Engine settings saved. Hour cells are recomputed on the next refresh.');
    },
  });

  return (
    <>
      <PageHeader title="Engine settings" subtitle="How charged time, eligibility and cell colours are decided." />
      <Flash message={flash.message} />

      <Panel title="Engine">
        {settingsQ.isLoading && <Spinner />}
        {settingsQ.isError && <ApiError error={settingsQ.error} />}
        {settingsQ.data && (
          <SettingsForm
            settings={settingsQ.data.settings}
            fields={ENGINE_SETTINGS}
            onSave={(patch) => saveM.mutate(patch)}
            saving={saveM.isPending}
            error={saveM.error}
          />
        )}
      </Panel>
    </>
  );
}
