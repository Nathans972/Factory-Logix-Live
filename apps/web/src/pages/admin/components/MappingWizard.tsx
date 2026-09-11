/**
 * Four-step FactoryLogix field mapping wizard (spec 4.8 / 10.7).
 * Used by `/admin/mapping` and embedded in the first-run setup wizard (10.10).
 *
 * The draft is a plain `MappingConfig`; nothing is written until "Save mapping".
 * Layout follows docs/DESIGN.md: `Stepper` pills, one `Card` per dataset, a sticky footer bar.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DATASET_SPECS,
  EXAMPLE_MAPPING,
  edmTypeToKind,
  type DatasetMapping,
  type DatasetName,
  type DatasetSpec,
  type FieldType,
  type MappingConfig,
  type MappingPreviewResult,
  type ODataEntityField,
  type ODataEntitySet,
  type ODataMetadata,
} from '@fld/shared';
import { useDataSource } from '../../../data/DataSourceContext';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  KpiTile,
  Note,
  Select,
  Spinner,
  type Column,
} from '../../../ui';
import { formatDateTime, formatNum } from '../../../lib/format';
import { usePlantTz } from '../../../lib/usePlantTz';
import { ApiError, FieldBlock, Flash, StepPills, useFlash } from './common';

const STEPS = ['Entity sets', 'Fields', 'Watermarks', 'Test and preview'];
const OPTIONAL_DATASETS: DatasetName[] = ['defects', 'operators', 'routes', 'standards'];

// ---------- draft helpers ----------

type DatasetRecord = Record<DatasetName, DatasetMapping | null>;

function getDataset(m: MappingConfig, name: DatasetName): DatasetMapping | null {
  return (m as DatasetRecord)[name];
}

function setDataset(m: MappingConfig, name: DatasetName, v: DatasetMapping | null): MappingConfig {
  const next = { ...m } as DatasetRecord;
  next[name] = v;
  return next as unknown as MappingConfig;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Saved mapping if there is one, otherwise the illustrative example with optional datasets off. */
export function initMappingDraft(saved: MappingConfig | null | undefined): MappingConfig {
  if (saved) return clone(saved);
  let draft = clone(EXAMPLE_MAPPING);
  for (const name of OPTIONAL_DATASETS) draft = setDataset(draft, name, null);
  return draft;
}

function fieldKind(f: ODataEntityField): FieldType | 'other' {
  return f.kind ?? edmTypeToKind(f.edm_type);
}

/** Source fields acceptable for a target of the given type (spec 10.7 step 2). */
export function fieldsOfType(es: ODataEntitySet | undefined, type: FieldType): ODataEntityField[] {
  if (!es) return [];
  return es.fields.filter((f) => {
    const k = fieldKind(f);
    if (type === 'timestamp') return k === 'timestamp';
    if (type === 'number') return k === 'number';
    if (type === 'boolean') return k === 'boolean';
    return k === 'string' || k === 'other';
  });
}

/** Watermarks must be monotonic: timestamps or numbers (spec 4.6). */
function watermarkCandidates(es: ODataEntitySet | undefined): ODataEntityField[] {
  if (!es) return [];
  return es.fields.filter((f) => fieldKind(f) === 'timestamp' || fieldKind(f) === 'number');
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildDatasetMapping(
  spec: DatasetSpec,
  es: ODataEntitySet | undefined,
  entitySet: string,
  prev: DatasetMapping | null,
): DatasetMapping {
  if (!es) {
    return prev
      ? { ...prev, entity_set: entitySet }
      : { entity_set: entitySet, watermark_field: null, key: [], fields: {} };
  }
  const names = new Set(es.fields.map((f) => f.name));
  const fields: Record<string, string | null> = {};
  for (const tf of spec.fields) {
    const prevVal = prev?.fields[tf.name] ?? null;
    if (prevVal && names.has(prevVal)) {
      fields[tf.name] = prevVal;
      continue;
    }
    const match = fieldsOfType(es, tf.type).find((f) => normalizeName(f.name) === normalizeName(tf.name));
    fields[tf.name] = match?.name ?? null;
  }
  return {
    entity_set: entitySet,
    watermark_field: prev?.watermark_field && names.has(prev.watermark_field) ? prev.watermark_field : null,
    key: (prev?.key ?? []).filter((k) => names.has(k)),
    fields,
  };
}

/** Mirrors `mappingConfigSchema` so "Save" is only enabled when the server would accept it. */
export function validateMappingDraft(m: MappingConfig): string[] {
  const issues: string[] = [];
  for (const spec of DATASET_SPECS) {
    const dsm = getDataset(m, spec.name);
    if (!dsm) {
      if (spec.required) issues.push(`${spec.label}: required — pick an entity set in step 1.`);
      continue;
    }
    if (!dsm.entity_set) issues.push(`${spec.label}: pick an entity set.`);
    if (dsm.key.length === 0) issues.push(`${spec.label}: pick at least one natural key field (step 2).`);
    for (const f of spec.fields) {
      if (f.required && !dsm.fields[f.name]) issues.push(`${spec.label}: "${f.name}" is required (step 2).`);
    }
  }
  return issues;
}

function cellText(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------- component ----------

export function MappingWizard({
  onSaved,
  embedded,
  formId,
}: {
  onSaved?: () => void;
  embedded?: boolean;
  /** when set the wizard renders as a <form> with this id and hides its own Save button */
  formId?: string;
}) {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();

  const mappingQ = useQuery({ queryKey: ['mapping'], queryFn: () => ds.mapping() });

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MappingConfig | null>(null);
  const [metadata, setMetadata] = useState<ODataMetadata | null>(null);
  const [previews, setPreviews] = useState<Partial<Record<DatasetName, MappingPreviewResult>>>({});
  const [previewErrors, setPreviewErrors] = useState<Partial<Record<DatasetName, unknown>>>({});

  useEffect(() => {
    const loaded = mappingQ.data;
    if (!loaded) return;
    setDraft((d) => d ?? initMappingDraft(loaded.mapping));
    setMetadata((m) => m ?? loaded.metadata);
  }, [mappingQ.data]);

  const refreshM = useMutation({
    mutationFn: () => ds.mappingMetadata(),
    onSuccess: (md) => {
      setMetadata(md);
      flash.show(`Loaded ${md.entity_sets.length} entity sets from $metadata.`);
    },
  });

  const previewM = useMutation({
    mutationFn: (dataset: DatasetName) => ds.mappingPreview({ mapping: draft as MappingConfig, dataset }),
    onSuccess: (res, dataset) => {
      setPreviews((p) => ({ ...p, [dataset]: res }));
      setPreviewErrors((p) => ({ ...p, [dataset]: undefined }));
    },
    onError: (err, dataset) => setPreviewErrors((p) => ({ ...p, [dataset]: err })),
  });

  const saveM = useMutation({
    mutationFn: () => ds.updateMapping(draft as MappingConfig),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mapping'] });
      void qc.invalidateQueries({ queryKey: ['setupStatus'] });
      flash.show('Mapping saved. The collector restarts with the new mapping.');
      onSaved?.();
    },
  });

  const entitySets = metadata?.entity_sets ?? [];
  const issues = useMemo(() => (draft ? validateMappingDraft(draft) : ['Loading…']), [draft]);

  if (mappingQ.isLoading && !draft) return <Spinner />;
  if (mappingQ.isError && !draft) return <ApiError error={mappingQ.error} />;
  if (!draft) return <Spinner />;

  const esFor = (dsm: DatasetMapping | null): ODataEntitySet | undefined =>
    dsm ? entitySets.find((e) => e.name === dsm.entity_set) : undefined;

  const usedSpecs = DATASET_SPECS.filter((s) => getDataset(draft, s.name) != null);

  const onPickEntitySet = (spec: DatasetSpec, name: string) => {
    setDraft((d) => {
      if (!d) return d;
      if (!name) return setDataset(d, spec.name, null);
      const es = entitySets.find((e) => e.name === name);
      return setDataset(d, spec.name, buildDatasetMapping(spec, es, name, getDataset(d, spec.name)));
    });
    setPreviews((p) => ({ ...p, [spec.name]: undefined }));
  };

  const patchDataset = (name: DatasetName, patch: Partial<DatasetMapping>) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = getDataset(d, name);
      if (!cur) return d;
      return setDataset(d, name, { ...cur, ...patch });
    });

  const setTargetField = (name: DatasetName, target: string, source: string | null) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = getDataset(d, name);
      if (!cur) return d;
      return setDataset(d, name, { ...cur, fields: { ...cur.fields, [target]: source } });
    });

  const datasetTitle = (spec: DatasetSpec) => (
    <>
      {spec.label}
      {spec.required && (
        <span className="req" title="Required dataset">
          *
        </span>
      )}
    </>
  );

  const metaLine = metadata
    ? `${entitySets.length} entity sets · OData ${metadata.version ?? 'version unknown'} · fetched ${formatDateTime(metadata.fetched_at, tz)}`
    : 'No $metadata loaded yet';

  const save = () => {
    if (issues.length === 0) saveM.mutate();
  };

  const body = (
    <>
      <StepPills steps={STEPS.map((label, i) => ({ label, done: i < step }))} current={step} onSelect={setStep} />
      <Flash message={flash.message} />
      {refreshM.isError && <ApiError error={refreshM.error} />}

      {/* ---------- Step 1: entity sets ---------- */}
      {step === 0 && (
        <>
          <Card>
            <CardHeader
              title="Step 1 · Pick the entity set for each dataset"
              subtitle={metaLine}
              actions={
                <Button
                  size="sm"
                  type="button"
                  loading={refreshM.isPending}
                  onClick={() => refreshM.mutate()}
                >
                  Refresh from server
                </Button>
              }
            />
            {!metadata && (
              <div className="card-body">
                <Note tone="warn" title="No $metadata loaded">
                  Use “Refresh from server” to read the live entity sets from FactoryLogix.
                </Note>
              </div>
            )}
          </Card>

          {DATASET_SPECS.map((spec) => {
            const dsm = getDataset(draft, spec.name);
            const value = dsm?.entity_set ?? '';
            const known = entitySets.some((e) => e.name === value);
            return (
              <Card key={spec.name}>
                <CardHeader
                  title={datasetTitle(spec)}
                  subtitle={spec.description}
                  badges={
                    <span className={`badge ${dsm ? 'badge-info' : 'badge-neutral'}`}>{dsm ? 'In use' : 'Not used'}</span>
                  }
                />
                <div className="card-body">
                  <div className="map-grid">
                    <Field
                      label="Entity set"
                      hint={
                        spec.required ? 'Required — the collector cannot run without it.' : 'Optional — may be left unused.'
                      }
                    >
                      <Select value={value} onChange={(e) => onPickEntitySet(spec, e.currentTarget.value)}>
                        <option value="">{spec.required ? '— pick an entity set —' : '— not used —'}</option>
                        {value && !known && <option value={value}>{value} (not in $metadata)</option>}
                        {entitySets.map((e) => (
                          <option key={e.name} value={e.name}>
                            {e.name} ({e.fields.length} fields)
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </Card>
            );
          })}
        </>
      )}

      {/* ---------- Step 2: fields ---------- */}
      {step === 1 && (
        <>
          <div className="mb">
            <Note tone="info" title="Step 2 · Map the source fields">
              Dropdowns only offer fields of a compatible type: timestamp targets list date/time fields, number targets
              list numeric fields, and so on. Fields marked <span className="req">*</span> are required.
            </Note>
          </div>
          {usedSpecs.length === 0 && <Note tone="warn">No datasets selected — go back to step 1.</Note>}
          {usedSpecs.map((spec) => {
            const dsm = getDataset(draft, spec.name) as DatasetMapping;
            const es = esFor(dsm);
            return (
              <Card key={spec.name}>
                <CardHeader title={datasetTitle(spec)} subtitle={dsm.entity_set} />
                <div className="card-body">
                  {!es && (
                    <Note tone="warn">
                      “{dsm.entity_set}” is not in the loaded $metadata — refresh it in step 1 to type-check fields.
                    </Note>
                  )}
                  <div className="map-grid">
                    {spec.fields.map((tf) => {
                      const cur = dsm.fields[tf.name] ?? '';
                      const opts = fieldsOfType(es, tf.type);
                      const known = opts.some((o) => o.name === cur);
                      return (
                        <Field
                          key={tf.name}
                          label={
                            <>
                              {tf.name} {tf.required && <span className="req">*</span>}{' '}
                              <span className="muted">({tf.type})</span>
                            </>
                          }
                          hint={tf.description}
                          error={tf.required && !cur ? 'Required' : undefined}
                        >
                          <Select
                            value={cur}
                            onChange={(e) => setTargetField(spec.name, tf.name, e.currentTarget.value || null)}
                          >
                            <option value="">{tf.required ? '— pick a field —' : '— not available —'}</option>
                            {cur && !known && <option value={cur}>{cur} (not in $metadata)</option>}
                            {opts.map((f) => (
                              <option key={f.name} value={f.name}>
                                {f.name} · {f.edm_type}
                                {f.nullable ? ' (nullable)' : ''}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      );
                    })}
                  </div>

                  <FieldBlock
                    label={
                      <>
                        Natural key <span className="req">*</span>
                      </>
                    }
                    hint="Source fields that uniquely identify a row — used for upserts. Ctrl/Cmd-click to pick several."
                    error={dsm.key.length === 0 ? 'Pick at least one field' : undefined}
                  >
                    <Select
                      multiple
                      className="input multi"
                      size={6}
                      value={dsm.key}
                      onChange={(e) =>
                        patchDataset(spec.name, {
                          key: Array.from(e.currentTarget.selectedOptions).map((o) => o.value),
                        })
                      }
                    >
                      {dsm.key
                        .filter((k) => !(es?.fields ?? []).some((f) => f.name === k))
                        .map((k) => (
                          <option key={k} value={k}>
                            {k} (not in $metadata)
                          </option>
                        ))}
                      {(es?.fields ?? []).map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name} · {f.edm_type}
                        </option>
                      ))}
                    </Select>
                  </FieldBlock>
                </div>
              </Card>
            );
          })}
        </>
      )}

      {/* ---------- Step 3: watermarks ---------- */}
      {step === 2 && (
        <>
          <div className="mb">
            <Note tone="info" title="Step 3 · Watermark per dataset">
              The watermark is the monotonic field the collector pages by. Without one it falls back to time-window
              mode, which re-reads a rolling window on every poll.
            </Note>
          </div>
          {usedSpecs.map((spec) => {
            const dsm = getDataset(draft, spec.name) as DatasetMapping;
            const es = esFor(dsm);
            const opts = watermarkCandidates(es);
            const cur = dsm.watermark_field ?? '';
            const known = opts.some((o) => o.name === cur);
            return (
              <Card key={spec.name}>
                <CardHeader
                  title={datasetTitle(spec)}
                  subtitle={dsm.entity_set}
                  badges={
                    <span className={`badge ${cur ? 'badge-info' : 'badge-neutral'}`}>
                      {cur ? 'Incremental' : 'Time window'}
                    </span>
                  }
                />
                <div className="card-body">
                  <div className="map-grid">
                    <Field
                      label="Watermark field"
                      hint={
                        cur
                          ? 'Incremental mode: only rows newer than the stored watermark are fetched.'
                          : 'Time-window mode: a rolling window is re-read on every poll.'
                      }
                    >
                      <Select
                        value={cur}
                        onChange={(e) => patchDataset(spec.name, { watermark_field: e.currentTarget.value || null })}
                      >
                        <option value="">none — time-window mode</option>
                        {cur && !known && <option value={cur}>{cur} (not in $metadata)</option>}
                        {opts.map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name} · {f.edm_type}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </Card>
            );
          })}
        </>
      )}

      {/* ---------- Step 4: test & preview ---------- */}
      {step === 3 && (
        <>
          <div className="mb">
            <Note tone="info" title="Step 4 · Test and preview">
              Each test runs the mapped query for the last hour with <code>$top=50</code> against the live server.
            </Note>
          </div>
          {usedSpecs.map((spec) => {
            const dsm = getDataset(draft, spec.name) as DatasetMapping;
            const res = previews[spec.name];
            const err = previewErrors[spec.name];
            const testing = previewM.isPending && previewM.variables === spec.name;
            return (
              <Card key={spec.name}>
                <CardHeader
                  title={datasetTitle(spec)}
                  subtitle={dsm.entity_set}
                  badges={
                    res ? (
                      <span className={`badge ${res.ok ? 'badge-ok' : 'badge-off'}`}>
                        {res.ok ? `${res.rows.length} rows` : 'failed'}
                      </span>
                    ) : undefined
                  }
                  actions={
                    <Button size="sm" type="button" loading={testing} onClick={() => previewM.mutate(spec.name)}>
                      Test
                    </Button>
                  }
                />
                <div className="card-body">
                  {err != null && <ApiError error={err} />}
                  {!res && err == null && <p className="muted">Not tested yet.</p>}
                  {res && <PreviewResult result={res} mapping={dsm} />}
                </div>
              </Card>
            );
          })}
        </>
      )}

      {saveM.isError && <ApiError error={saveM.error} />}
      {issues.length > 0 && step === STEPS.length - 1 && (
        <Note tone="warn" title="Not ready to save yet">
          <ul className="issues">
            {issues.slice(0, 12).map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Note>
      )}

      <div className="sticky-save">
        <Button type="button" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          Back
        </Button>
        <Button
          type="button"
          disabled={step === STEPS.length - 1}
          onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
        >
          Next
        </Button>
        <span className="spacer" />
        {issues.length > 0 && (
          <span className="msg">
            {issues.length} thing{issues.length === 1 ? '' : 's'} still to map
          </span>
        )}
        {!formId && (
          <Button
            type="button"
            variant="primary"
            loading={saveM.isPending}
            disabled={issues.length > 0}
            onClick={save}
            title={issues.length > 0 ? 'Required fields are still missing' : undefined}
          >
            Save mapping
          </Button>
        )}
        {embedded && formId && <span className="msg">Saving completes the mapping step of setup.</span>}
      </div>
    </>
  );

  if (!formId) return <div>{body}</div>;
  return (
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {body}
    </form>
  );
}

// ---------- preview rendering ----------

function PreviewResult({ result, mapping }: { result: MappingPreviewResult; mapping: DatasetMapping }) {
  const rows = result.rows.slice(0, 50);
  const mapped = Array.from(
    new Set([...mapping.key, ...Object.values(mapping.fields).filter((v): v is string => !!v)]),
  );
  const present = mapped.filter((c) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, c)));
  const colNames = present.length > 0 ? present : Object.keys(rows[0] ?? {});
  const columns: Column<Record<string, unknown>>[] = colNames.map((name) => ({
    key: name,
    header: name,
    sortable: false,
    render: (r) => <span title={cellText(r[name])}>{cellText(r[name])}</span>,
    value: (r) => cellText(r[name]),
  }));

  const c = result.checks;
  const skewBad = c.timestamp_skew_minutes != null && Math.abs(c.timestamp_skew_minutes) > 30;

  return (
    <div className="stack">
      {!result.ok && <Note tone="error" title="The query failed">{result.error ?? 'Unknown error.'}</Note>}
      {result.query && <div className="query-line">{result.query}</div>}

      <div className="checks-grid">
        <KpiTile label="Distinct operators" value={c.distinct_operators ?? '—'} />
        <KpiTile label="Distinct jobs" value={c.distinct_jobs ?? '—'} />
        <KpiTile label="Start present" value={c.start_present_pct == null ? '—' : `${formatNum(c.start_present_pct, 0)}%`} />
        <KpiTile
          label="Complete present"
          value={c.complete_present_pct == null ? '—' : `${formatNum(c.complete_present_pct, 0)}%`}
        />
        <KpiTile
          label="Timestamp skew"
          value={c.timestamp_skew_minutes == null ? '—' : `${formatNum(c.timestamp_skew_minutes, 0)} min`}
          accent={skewBad ? 'amber' : 'none'}
          hint={skewBad ? 'more than 30 min from the plant clock' : undefined}
        />
      </div>

      {skewBad && (
        <Note tone="warn" title="Clock skew">
          The newest sampled timestamp is {formatNum(c.timestamp_skew_minutes, 0)} minutes from the plant clock. Check
          the timestamp mode on the FactoryLogix page (offset present / UTC / plant-local).
        </Note>
      )}

      {c.warnings.length > 0 && (
        <Note tone="warn" title={`${c.warnings.length} warning${c.warnings.length === 1 ? '' : 's'}`}>
          <ul className="issues">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Note>
      )}

      {c.sample_durations_minutes.length > 0 && (
        <p className="muted small">
          Sample durations (minutes):{' '}
          {c.sample_durations_minutes
            .slice(0, 12)
            .map((d) => formatNum(d, 1))
            .join(', ')}
        </p>
      )}

      {rows.length > 0 && (
        <div className="preview-scroll">
          <DataTable columns={columns} rows={rows} rowKey={(_r, i) => i} dense emptyMessage="No rows" />
        </div>
      )}
    </div>
  );
}
