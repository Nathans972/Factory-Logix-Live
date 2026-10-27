/**
 * Navigation map shared by the rails and the Home tiles (docs/DESIGN.md, principle 2).
 *
 * Production is what every signed-in user works in; TV displays needs manager. Settings is a
 * separate area behind the top-bar gear: admins see every page, managers only the ones they
 * can use (Standards, Sync health). The API and the pages still do the real gating.
 */
import type { Role, User } from '@fld/shared';
import { hasRole } from '../../auth/AuthContext';
import type { IconName } from './icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** one line for the Home tile */
  description: string;
  /** lowest role that sees the entry */
  minRole: Role;
}

export const PRODUCTION_NAV: NavItem[] = [
  { to: '/shift', label: 'Shift view', icon: 'shift', minRole: 'viewer', description: 'Efficiency, units and jobs for one shift' },
  { to: '/floor', label: 'Floor', icon: 'floor', minRole: 'viewer', description: 'Who is on pace, behind or idle right now' },
  { to: '/jobs', label: 'Jobs', icon: 'jobs', minRole: 'viewer', description: 'Every job with progress and its hourly grid' },
  { to: '/operators', label: 'Operators', icon: 'operators', minRole: 'viewer', description: 'Pace and history per operator' },
  { to: '/products', label: 'Products', icon: 'products', minRole: 'viewer', description: 'Routes and the standards behind them' },
  { to: '/displays', label: 'TV displays', icon: 'displays', minRole: 'manager', description: 'Change which job each TV shows' },
];

export const SETTINGS_NAV: NavItem[] = [
  { to: '/admin/displays', label: 'Displays', icon: 'displays', minRole: 'admin', description: 'Pair, edit and remove TVs' },
  { to: '/admin/shifts', label: 'Shifts', icon: 'shifts', minRole: 'admin', description: 'Shift times and days' },
  { to: '/admin/breaks', label: 'Breaks', icon: 'breaks', minRole: 'admin', description: 'Scheduled breaks' },
  { to: '/admin/connection', label: 'FactoryLogix', icon: 'connection', minRole: 'admin', description: 'Connection to FactoryLogix' },
  { to: '/admin/mapping', label: 'Mapping', icon: 'mapping', minRole: 'admin', description: 'Field mapping' },
  { to: '/admin/standards', label: 'Standards', icon: 'standards', minRole: 'manager', description: 'Standard adjustments' },
  { to: '/admin/engine', label: 'Engine', icon: 'engine', minRole: 'admin', description: 'Calculation settings' },
  { to: '/admin/users', label: 'Users', icon: 'users', minRole: 'admin', description: 'Accounts and roles' },
  { to: '/admin/sync', label: 'Sync health', icon: 'sync', minRole: 'manager', description: 'Collector status and backfill' },
  { to: '/admin/audit', label: 'Audit', icon: 'audit', minRole: 'admin', description: 'Who changed what' },
];

export function visibleNav(items: NavItem[], user: User | null | undefined): NavItem[] {
  return items.filter((i) => hasRole(user, i.minRole));
}

/** Where the top-bar gear goes: the first Settings page this user can open, or null for none. */
export function settingsHome(user: User | null | undefined): string | null {
  return visibleNav(SETTINGS_NAV, user)[0]?.to ?? null;
}
