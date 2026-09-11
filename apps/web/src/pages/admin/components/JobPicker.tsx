/**
 * Free-text job search + pick (spec 8.6 / 10.1), styled as the drawer picker in
 * docs/design/admin-displays.html: a search input above a bordered result list whose
 * selected row is highlighted. "No job" is a valid choice.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../../data/DataSourceContext';
import { Input } from '../../../ui';
import { FieldBlock, useDebouncedValue } from './common';

export function JobPicker({
  value,
  onChange,
  label = 'Assigned job',
}: {
  value: string | null;
  onChange: (job: string | null) => void;
  label?: string;
}) {
  const ds = useDataSource();
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300);

  const jobsQ = useQuery({
    queryKey: ['jobs', dq || null, 'picker'],
    queryFn: () => ds.jobs(dq || undefined),
    staleTime: 30_000,
  });

  const jobs = jobsQ.data?.jobs ?? [];
  // Keep the selected job visible even when the search text filters it out.
  const selectedMissing = value != null && !jobs.some((j) => j.job_number === value);

  return (
    <FieldBlock
      label={label}
      hint={value ? `This TV shows ${value}.` : 'No job assigned — the TV shows "No job assigned".'}
    >
      <Input
        placeholder="Search jobs by number, product or name…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="jp-list">
        <button type="button" className={`jp-opt${value == null ? ' on' : ''}`} onClick={() => onChange(null)}>
          <b>No job</b>
          <span className="p">Leave this display unassigned</span>
        </button>
        {selectedMissing && (
          <button type="button" className="jp-opt on" onClick={() => onChange(value)}>
            <b>{value}</b>
            <span className="p">currently assigned</span>
          </button>
        )}
        {jobsQ.isLoading && <div className="jp-note">Searching…</div>}
        {jobsQ.isError && <div className="jp-note">Could not load jobs.</div>}
        {!jobsQ.isLoading &&
          jobs.slice(0, 50).map((j) => (
            <button
              type="button"
              key={j.job_number}
              className={`jp-opt${value === j.job_number ? ' on' : ''}`}
              onClick={() => onChange(j.job_number)}
            >
              <b>{j.job_number}</b>
              <span className="p">
                {j.product_number}
                {j.product_name ? ` · ${j.product_name}` : ''}
              </span>
              <small>{j.active ? 'active' : 'inactive'}</small>
            </button>
          ))}
        {!jobsQ.isLoading && !jobsQ.isError && jobs.length === 0 && <div className="jp-note">No matching jobs.</div>}
      </div>
    </FieldBlock>
  );
}
