/**
 * Public surface of the TV page. The portal job page (spec 9.5) embeds `TvDashboard` — it is a
 * pure presentational component and pulls in `tv.css`, which is scoped under `.tv-root`.
 */
export { TvDashboard } from './TvDashboard';
export type { TvDashboardProps } from './TvDashboard';
export { TvGauge } from './TvGauge';
export { TvClock } from './TvClock';
