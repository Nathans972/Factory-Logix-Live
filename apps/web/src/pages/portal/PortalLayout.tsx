/** Production shell (spec 9.1): the shared AppShell with the production rail (docs/DESIGN.md, principle 2). */
import { AppShell } from '../../components/shell/AppShell';

export function PortalLayout() {
  return <AppShell section="portal" />;
}
