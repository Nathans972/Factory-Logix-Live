import { IS_MOCK } from '../data';

/** Persistent "DEMO: simulated data" badge on every page in mock mode (spec 12.2). */
export function DemoBadge() {
  if (!IS_MOCK) return null;
  return (
    <div className="demo-badge" title="This is a public demo running an in-browser simulator. No real customer data.">
      DEMO: simulated data
    </div>
  );
}
