import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { QueryClient, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { refreshServerCache } from "@/lib/api";
import {
  ConnectionStatus,
  deriveConnectionStatus,
  getConnectionSnapshot,
  hasUnsavedChanges,
  subscribeConnection,
} from "@/lib/connection";

/** Matches the backend's cache TTL: refreshing more often only re-reads its cache */
const AUTO_REFRESH_MIN_INTERVAL_MS = 30 * 1000;

/**
 * Raw connection state (pending writes, last error, last update, session expiry).
 */
export function useConnectionState() {
  return useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
}

/**
 * Tracks navigator.onLine through the online/offline events.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine
  );
}

/**
 * Current time, updated every `intervalMs` (for "Updated 2 min ago" labels).
 */
export function useNow(intervalMs = 30 * 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The connection status shown in the sidebar, derived from queries in flight, pending writes,
 * the last request outcome and the browser's online state.
 */
export function useConnectionStatus(isRefreshing = false): ConnectionStatus {
  const connection = useConnectionState();
  const online = useOnline();
  const fetching = useIsFetching();
  const now = useNow();
  return deriveConnectionStatus({
    online,
    sessionExpired: connection.sessionExpired,
    isFetching: isRefreshing || fetching > 0,
    isSaving: connection.pendingWrites > 0,
    lastError: connection.lastError,
    lastUpdatedAt: connection.lastUpdatedAt,
    now,
  });
}

/**
 * Refetches every active query except notes with unsaved edits in an open editor.
 */
export function invalidateAllExceptUnsaved(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => !(query.queryKey[0] === "note" && hasUnsavedChanges(query.queryKey[1])),
  });
}

let lastRefreshAt = 0;

/**
 * Manual refresh: the backend reloads from Joplin Server, then all queries refetch.
 */
export function useRefresh() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshServerCache();
      lastRefreshAt = Date.now();
      await invalidateAllExceptUnsaved(queryClient);
      return true;
    } catch {
      // The status shows the error
      return false;
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient]);
  return { refresh, isRefreshing };
}

/**
 * Refetches when the user comes back to the tab or the connection returns, at most once per
 * backend cache TTL, so changes from other devices show up without a reload.
 */
export function useAutoRefresh(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const maybeRefresh = (force = false) => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      if (getConnectionSnapshot().sessionExpired) return;
      if (!force && Date.now() - lastRefreshAt < AUTO_REFRESH_MIN_INTERVAL_MS) return;
      lastRefreshAt = Date.now();
      void invalidateAllExceptUnsaved(queryClient);
    };
    const onVisible = () => maybeRefresh();
    const onFocus = () => maybeRefresh();
    const onOnline = () => maybeRefresh(true);
    lastRefreshAt = Date.now();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [queryClient]);
}
