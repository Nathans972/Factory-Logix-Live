/**
 * TV display page (spec 8). Unauthenticated by design; full-screen, no scrolling, updates in
 * place. The states of spec 8.2 are selected by `tvScreen` (tvLogic.ts).
 */
import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { TvBanners } from './TvBanners';
import { TvDashboard } from './TvDashboard';
import { TV_STYLE_VARS, tvScreen, type TvMessageLine } from './tvLogic';
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
    const screen = tvScreen(view);
    if (screen.kind === 'message') return <TvMessage lines={screen.lines} />;
    return (
      <TvDashboard
        dashboard={screen.dashboard}
        showGauge={state?.display?.show_gauge ?? true}
        tz={view.tz}
        updatedAt={view.updatedAt}
      />
    );
  }
}

/** Full-screen centered message used by the pairing / unassigned / waiting / unavailable states. */
function TvMessage({ lines }: { lines: TvMessageLine[] }) {
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
