/**
 * Live refresh plumbing (spec 8.4, WEB_NOTES "Conventions").
 *
 * `useLiveRefetch(types, onEvent)` subscribes to the DataSource event stream and reacts to
 * the given event types, and to `resync` (some may have been missed) when `types` is not empty.
 * `onEvent` may be:
 *   - a query key (or list of query keys) to invalidate, e.g. `['shiftView']`
 *   - a callback, for pages that need custom handling
 *   - omitted, in which case every active query is invalidated
 *
 * The subscription is created once per DataSource: passing inline arrays/lambdas is safe.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { SseEvent } from '@fld/shared';
import type { LiveEvent } from '../data/DataSource';
import { useDataSource } from '../data/DataSourceContext';

export type LiveTarget = QueryKey | QueryKey[] | ((e: LiveEvent) => void) | undefined;

function isQueryKeyList(v: unknown): v is QueryKey[] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

export function useLiveRefetch(types: SseEvent['type'][], onEvent?: LiveTarget): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const typesRef = useRef(types);
  const targetRef = useRef(onEvent);
  typesRef.current = types;
  targetRef.current = onEvent;

  useEffect(() => {
    const unsubscribe = ds.subscribe((e) => {
      const listening = typesRef.current;
      if (e.type === 'resync' ? listening.length === 0 : !listening.includes(e.type)) return;
      const target = targetRef.current;
      if (typeof target === 'function') {
        target(e);
        return;
      }
      if (target === undefined) {
        void queryClient.invalidateQueries();
        return;
      }
      const keys: QueryKey[] = isQueryKeyList(target) ? target : [target as QueryKey];
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    });
    return unsubscribe;
  }, [ds, queryClient]);
}

/** Raw event subscription without any query invalidation. */
export function useLiveEvent(types: SseEvent['type'][], handler: (e: SseEvent) => void): void {
  const ds = useDataSource();
  const typesRef = useRef(types);
  const handlerRef = useRef(handler);
  typesRef.current = types;
  handlerRef.current = handler;

  useEffect(() => {
    return ds.subscribe((e) => {
      if (e.type !== 'resync' && typesRef.current.includes(e.type)) handlerRef.current(e);
    });
  }, [ds]);
}
