import { useLocation } from 'react-router-dom';
import { IS_MOCK } from '../data';
import { DEMO_REPO_URL, tvDemoHref } from '../lib/demo';

/**
 * Persistent "DEMO: simulated data" badge on every page in mock mode (spec 12.2), plus
 * two links for reviewers (source on GitHub, TV display demo). The links are hidden on
 * `/tv` so the display page keeps its clean, kiosk-style bottom edge.
 */
export function DemoBadge() {
  const { pathname } = useLocation();
  if (!IS_MOCK) return null;
  const onTv = pathname === '/tv' || pathname.startsWith('/tv/');
  return (
    <div className="demo-bar">
      <div className="demo-badge" title="This is a public demo running an in-browser simulator. No real customer data.">
        DEMO: simulated data
      </div>
      {!onTv && (
        <div className="demo-bar-links">
          <a className="btn btn-sm" href={DEMO_REPO_URL} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
          <a className="btn btn-primary btn-sm" href={tvDemoHref()} target="_blank" rel="noreferrer">
            View TV display demo
          </a>
        </div>
      )}
    </div>
  );
}
