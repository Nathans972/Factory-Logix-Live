/**
 * TV displays (manager+): one card per paired TV with its online state and the job it shows,
 * and a "Change job" drawer using the shared JobPicker. Only the job changes here
 * (PUT /api/displays/:id/job); pairing, options and deleting stay in Settings → Displays (admin).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Display, JobListItem } from '@fld/shared';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { relativeMinutes } from '../../lib/format';
import { Button, Drawer, EmptyState, Note, PageHeader, Spinner } from '../../ui';
import { ApiError, Flash, ManagerOnly, OnlineBadge, useFlash } from '../admin/components/common';
import { JobPicker } from '../admin/components/JobPicker';

export function TvJobsPage() {
  return (
    <ManagerOnly title="TV displays">
      <TvJobsPageInner />
    </ManagerOnly>
  );
}

function displayName(d: Display): string {
  return d.name ?? `TV ${d.pairing_code}`;
}

function TvJobsPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const { user } = useAuth();
  const flash = useFlash();
  const isAdmin = hasRole(user, 'admin');

  const displaysQ = useQuery({ queryKey: ['tvDisplays'], queryFn: () => ds.tvDisplays(), refetchInterval: 15_000 });
  const jobsQ = useQuery({ queryKey: ['jobs', null, 'tvDisplays'], queryFn: () => ds.jobs(), staleTime: 60_000 });
  useLiveRefetch(['display_updated'], [['tvDisplays']]);

  const [editing, setEditing] = useState<Display | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const setJobM = useMutation({
    mutationFn: (v: { id: number; job: string | null }) => ds.setDisplayJob(v.id, { job_number: v.job }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['tvDisplays'] });
      void qc.invalidateQueries({ queryKey: ['displays'] });
      setEditing(null);
      flash.show(d.job_number ? `${displayName(d)} now shows ${d.job_number}.` : `${displayName(d)} is now unassigned.`);
    },
  });

  const jobsByNumber = useMemo(() => {
    const m = new Map<string, JobListItem>();
    for (const j of jobsQ.data?.jobs ?? []) m.set(j.job_number, j);
    return m;
  }, [jobsQ.data]);

  // Paired TVs only, by name; unpaired ones are an admin task and only counted.
  const all = displaysQ.data ?? [];
  const tvs = all
    .filter((d) => d.claimed_at != null)
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
  const waiting = all.length - tvs.length;

  const open = (d: Display) => {
    setPicked(d.job_number);
    setJobM.reset();
    setEditing(d);
  };

  const now = Date.now();

  return (
    <>
      <PageHeader
        title="TV displays"
        subtitle="Choose which job each TV on the floor shows. The TV switches as soon as you save."
        actions={
          isAdmin ? (
            <Link className="btn btn-secondary btn-md" to="/admin/displays">
              Pair or edit TVs
            </Link>
          ) : null
        }
      />

      <Flash message={flash.message} />

      {waiting > 0 && (
        <div className="mb">
          <Note tone="info">
            {waiting === 1 ? '1 new TV is' : `${waiting} new TVs are`} waiting to be paired.{' '}
            {isAdmin ? (
              <>
                Pair it in <Link to="/admin/displays">Settings → Displays</Link>.
              </>
            ) : (
              'An admin pairs new TVs in Settings.'
            )}
          </Note>
        </div>
      )}

      {displaysQ.isLoading ? (
        <Spinner />
      ) : displaysQ.isError ? (
        <ApiError error={displaysQ.error} title="Could not load the TVs" />
      ) : tvs.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No TVs are paired yet"
            hint={isAdmin ? 'Open /tv on a TV, then pair its code in Settings → Displays.' : 'An admin pairs TVs in Settings.'}
          />
        </div>
      ) : (
        <div className="tv-grid">
          {tvs.map((d) => {
            const job = d.job_number ? jobsByNumber.get(d.job_number) : undefined;
            return (
              <section key={d.id} className="tv-card">
                <header className="tv-card-head">
                  <h2>{displayName(d)}</h2>
                  <OnlineBadge online={d.online} />
                </header>
                <div className="tv-card-label">Showing</div>
                {d.job_number ? (
                  <div className="tv-card-job">
                    <Link to={`/jobs/${encodeURIComponent(d.job_number)}`}>{d.job_number}</Link>
                    {job && (
                      <small>
                        {job.product_number}
                        {job.product_name ? ` · ${job.product_name}` : ''}
                      </small>
                    )}
                  </div>
                ) : (
                  <div className="tv-card-job none">No job assigned</div>
                )}
                <div className="tv-card-meta">
                  {d.group_operators ? 'Grouped' : 'Per operator'} · seen {relativeMinutes(d.last_seen_at, now)}
                </div>
                <Button variant="primary" size="sm" onClick={() => open(d)}>
                  Change job
                </Button>
              </section>
            );
          })}
        </div>
      )}

      <Drawer
        open={editing != null}
        title={editing ? `Change job · ${displayName(editing)}` : ''}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={setJobM.isPending}
              disabled={editing == null || picked === editing.job_number}
              onClick={() => editing && setJobM.mutate({ id: editing.id, job: picked })}
            >
              Save
            </Button>
          </>
        }
      >
        {setJobM.isError && <ApiError error={setJobM.error} title="Could not change the job" />}
        <JobPicker value={picked} onChange={setPicked} label="Job on this TV" />
      </Drawer>
    </>
  );
}
