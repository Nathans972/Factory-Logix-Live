/**
 * Home (`/`), the signed-in landing page, laid out like the company portal: a greeting card with
 * one line of plant status, then one tile per production page this user can open.
 *
 * Shift view used to live at `/`; old links that carry shift-view parameters
 * (`/?date=…&shift_id=…&job=…`) are sent on to `/shift` with the same query.
 */
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatInt, formatPct } from '../../lib/format';
import { Icon } from '../../components/shell/icons';
import { PRODUCTION_NAV, visibleNav } from '../../components/shell/nav';

const SHIFT_VIEW_PARAMS = ['date', 'shift_id', 'job', 'product', 'operation', 'operator'];

/** "morning" / "afternoon" / "evening" for the plant's local hour. */
function partOfDay(tz: string, now = Date.now()): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

function plural(n: number, word: string): string {
  return `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`;
}

function PlantStatus() {
  const ds = useDataSource();
  const view = useQuery({ queryKey: ['shiftView', 'home'], queryFn: () => ds.shiftView({}), refetchInterval: 60_000 });
  useLiveRefetch(view.data?.in_progress ? ['data_updated'] : [], [['shiftView', 'home']]);

  const v = view.data;
  if (view.isError) return <>Plant status is not available right now.</>;
  if (!v) return <>Checking the floor…</>;

  const shift = /shift/i.test(v.shift.name) ? v.shift.name : `${v.shift.name} shift`;
  const eff = v.summary.efficiency ?? v.rollups.overall.efficiency;
  return (
    <>
      {shift} {v.in_progress ? 'in progress' : 'ended'} · {plural(v.summary.active_jobs, 'active job')} ·{' '}
      {plural(v.summary.total_units, 'unit')} · {formatPct(eff)} efficiency
    </>
  );
}

export function HomePage() {
  const { search } = useLocation();
  const { user } = useAuth();
  const tz = usePlantTz();

  const params = new URLSearchParams(search);
  if (SHIFT_VIEW_PARAMS.some((k) => params.has(k))) return <Navigate to={`/shift${search}`} replace />;

  const tiles = visibleNav(PRODUCTION_NAV, user);

  return (
    <div className="home">
      <section className="home-hero">
        <h1>
          Good {partOfDay(tz)}, {user?.username ?? 'there'}
        </h1>
        <p className="home-status">
          <PlantStatus />
        </p>
      </section>

      <section className="home-section">
        <h2 className="home-section-title">
          <Icon name="factory" />
          Production
        </h2>
        <div className="home-tiles">
          {tiles.map((t) => (
            <Link key={t.to} to={t.to} className="home-tile">
              <span className="home-tile-top">
                <span className="home-tile-icon">
                  <Icon name={t.icon} size={18} />
                </span>
                <span className="home-tile-chip">Production</span>
              </span>
              <span className="home-tile-title">{t.label}</span>
              <span className="home-tile-desc">{t.description}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
