/**
 * TV display page (spec 8). Unauthenticated by design; full-screen, no scrolling, updates in
 * place. The five states of spec 8.2 are selected in `content()` below.
 */
import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { TvBanners } from './TvBanners';
import { TvDashboard } from './TvDashboard';
import { TV_STYLE_VARS } from './tvLogic';
import { useTvState } from './useTvState';
import './tv.css';

const ROOT_STYLE = TV_STYLE_VARS as unknown as CSSProperties;

export function TvPage() {
  const view = useTvState();
  const state = view.state;

  // The TV never scrolls (spec 8.3); restore the portal's body styles on unmount.
  useEffect(() => {
    const { overflow, background } = document.body.style;
    document.body.style.overflow = 'hidden';
    document.body.style.background = TV_STYLE_VARS['--tv-bg'];
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.background = background;
    };
  }, []);

  return (
    <div className="tv-root tv-page" style={ROOT_STYLE} data-hour-tick={view.hourTick}>
      <TvBanners
        offlineSince={view.offlineSince}
        delayedSince={view.delayedSince}
        delayed={view.delayed}
        tz={view.tz}
      />
      <div className="tv-page-body">{content()}</div>
    </div>
  );

  function content() {
    // No response yet at all.
    if (state == null) {
      if (view.loading) return <TvMessage lines={[{ text: 'Connecting…', kind: 'title' }]} />;
      return (
        <TvMessage
          lines={[
            { text: 'Dashboard unavailable', kind: 'title' },
            { text: `Device ${view.token.slice(0, 8)}`, kind: 'sub' },
          ]}
        />
      );
    }

    // Unclaimed: pairing screen (spec 8.1).
    if (state.status === 'unclaimed') {
      return (
        <TvMessage
          lines={[
            { text: 'This TV is', kind: 'sub' },
            { text: state.pairing_code, kind: 'code' },
            { text: 'Claim it in the admin portal.', kind: 'title' },
            { text: state.admin_url, kind: 'sub' },
          ]}
        />
      );
    }

    // Claimed but no job assigned.
    if (state.status === 'unassigned' || state.dashboard == null) {
      return (
        <TvMessage
          lines={[
            { text: 'No job assigned', kind: 'title' },
            { text: state.display?.name ?? 'Unnamed display', kind: 'sub' },
            { text: `Code ${state.display?.pairing_code ?? state.pairing_code}`, kind: 'sub' },
          ]}
        />
      );
    }

    // Assigned: the dashboard. `view.dashboard` is the last successfully fetched one, so it
    // survives a backend outage (the banner explains the staleness).
    const dashboard = view.dashboard ?? state.dashboard;
    return (
      <TvDashboard
        dashboard={dashboard}
        showGauge={state.display?.show_gauge ?? true}
        tz={view.tz}
        updatedAt={view.updatedAt}
      />
    );
  }
}

type MessageLine = { text: string; kind: 'title' | 'sub' | 'code' };

/** Full-screen centered message used by the pairing / unassigned / unavailable states. */
function TvMessage({ lines }: { lines: MessageLine[] }) {
  return (
    <div className="tv-message">
      {lines.map((l, i) => (
        <div key={`${l.kind}-${i}`} className={`tv-message-${l.kind}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
