import { IS_MOCK } from '../data';

/** Public source repository, linked from the demo bar (mock mode only). */
export const DEMO_REPO_URL = 'https://github.com/Nathans972/Factory-Logix-Live';

/** `/tv` under the current base path, with the mock demo token so reviewers land on a claimed display. */
export function tvDemoHref(): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return base + '/tv' + (IS_MOCK ? '?demo=1' : '');
}
