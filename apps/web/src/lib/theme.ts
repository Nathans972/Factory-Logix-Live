/**
 * Theme preference (docs/DESIGN.md — light is the default, dark is a token flip).
 *
 * The preference lives in `localStorage['fld_theme']` as 'light' | 'dark' | 'system'.
 * `initTheme()` runs from main.tsx before the first render so the page never flashes the
 * wrong palette; `useTheme()` reads and writes it from the user menu.
 *
 * The resolved value is written to `<html data-theme="light|dark">`; styles/tokens.css
 * flips every `--fl-*` token on `[data-theme="dark"]`.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'fld_theme';
const DEFAULT: ThemePreference = 'light';

const listeners = new Set<() => void>();
let preference: ThemePreference = DEFAULT;
let mediaQuery: MediaQueryList | null = null;

function isPreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isPreference(raw) ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? systemTheme() : pref;
}

function apply(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
}

function emit(): void {
  for (const l of listeners) l();
}

/** Called once from main.tsx before render. Safe to call more than once. */
export function initTheme(): void {
  preference = readStored();
  apply(preference);
  if (!mediaQuery && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (preference === 'system') {
        apply(preference);
        emit();
      }
    };
    if (typeof mediaQuery.addEventListener === 'function') mediaQuery.addEventListener('change', onChange);
    else mediaQuery.addListener(onChange);
  }
}

export function setThemePreference(pref: ThemePreference): void {
  preference = pref;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* private mode: keep it in memory only */
  }
  apply(pref);
  emit();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ThemeState {
  /** what the user picked */
  theme: ThemePreference;
  /** what is actually applied right now */
  resolved: ResolvedTheme;
  setTheme: (pref: ThemePreference) => void;
}

export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribe, getThemePreference, () => DEFAULT);
  const setTheme = useCallback((pref: ThemePreference) => setThemePreference(pref), []);
  return { theme, resolved: resolveTheme(theme), setTheme };
}
