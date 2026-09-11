/** Free-text job search + pick (spec 8.6 / 10.1). "No job" is a valid choice. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../../data/DataSourceContext';
import { Input, Spinner } from '../../../ui';
import { FieldBlock, useDebouncedValue } from './common';

export function JobPicker({ value, onChange }: { value: string | null; onChange: (job: string | null) => void }) {
  const ds = useDataSource();
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300);

  const jobsQ = useQuery({
    queryKey: ['jobs', dq || null, 'picker'],
    queryFn: () => ds.jobs(dq || undefined),
    staleTime: 30_000,
  });

  const jobs = jobsQ.data?.jobs ?? [];

  return (
    <FieldBlock
      label="Assigned job"
      wide
      hint={value ? `Assigned to ${value}.` : 'No job assigned — the TV will show "No job assigned".'}
    >
      <Input
        placeholder="Search jobs by number, product or name…"
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      <div className="picker-list">
        <button type="button" className={`opt${value == null ? ' on' : ''}`} onClick={() => onChange(null)}>
          No job
          <span className="sub">Leave this display unassigned</span>
        </button>
        {jobsQ.isLoading && <Spinner label="Searching…" />}
        {jobsQ.isError && <div className="opt muted">Could not load jobs.</div>}
        {!jobsQ.isLoading &&
          jobs.slice(0, 50).map((j) => (
            <button
              type="button"
              key={j.job_number}
              className={`opt${value === j.job_number ? ' on' : ''}`}
              onClick={() => onChange(j.job_number)}
            >
              {j.job_number}
              <span className="sub">
                {j.product_number}
                {j.product_name ? ` — ${j.product_name}` : ''}
                {j.active ? '' : ' · inactive'}
              </span>
            </button>
          ))}
        {!jobsQ.isLoading && !jobsQ.isError && jobs.length === 0 && <div className="opt muted">No matching jobs.</div>}
      </div>
    </FieldBlock>
  );
}
