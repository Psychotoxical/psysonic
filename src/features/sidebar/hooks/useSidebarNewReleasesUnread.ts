import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import { loadLocalNewReleases } from '@/lib/library/newReleasesLocal';
import {
  describeMultiServerError,
  emitMultiServerDebug,
} from '@/lib/library/multiServerDebug';
import {
  NEW_RELEASES_RESET_DELAY_MS,
  NEW_RELEASES_SEEN_MAX_IDS,
  NEW_RELEASES_UNREAD_POLL_MS,
  NEW_RELEASES_UNREAD_SAMPLE_SIZE,
  mergeSeenNewReleaseIdsCap,
  newReleasesSeenStorageKey as buildNewReleasesSeenStorageKey,
} from '@/features/sidebar/utils/sidebarHelpers';

// Coalesce burst refreshes (mount + scope/page-mode change + StrictMode) into one.
const NEW_RELEASES_UNREAD_DEBOUNCE_MS = 400;
const NEW_RELEASES_UNREAD_BACKGROUND_DELAY_MS = 5_000;

interface Args {
  anchorServerId: string | null;
  scopes: LibraryScopePair[];
  scopeFingerprint: string;
  isLoggedIn: boolean;
  pathname: string;
}

export function useSidebarNewReleasesUnread({
  anchorServerId,
  scopes,
  scopeFingerprint,
  isLoggedIn,
  pathname,
}: Args): number {
  const [newReleasesUnreadCount, setNewReleasesUnreadCount] = useState(0);
  const newReleasesRefreshSeqRef = useRef(0);
  const newReleasesPageEnteredAtRef = useRef<number | null>(null);
  const newReleasesResetTimerRef = useRef<number | null>(null);
  const onNewReleasesPage = pathname.startsWith('/new-releases');
  const onNewReleasesPageRef = useRef(onNewReleasesPage);
  const scopesRef = useRef(scopes);
  useEffect(() => {
    onNewReleasesPageRef.current = onNewReleasesPage;
  }, [onNewReleasesPage]);
  useEffect(() => {
    scopesRef.current = scopes;
  }, [scopes]);

  const scopedSeenStorageKey = useMemo(
    () => buildNewReleasesSeenStorageKey(scopeFingerprint),
    [scopeFingerprint],
  );

  const readSeenNewReleaseIds = useCallback((): string[] => {
    try {
      const raw = localStorage.getItem(scopedSeenStorageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  }, [scopedSeenStorageKey]);

  const writeSeenNewReleaseIds = useCallback((ids: string[]) => {
    const normalized = Array.from(new Set(ids.filter(Boolean))).slice(0, NEW_RELEASES_SEEN_MAX_IDS);
    localStorage.setItem(scopedSeenStorageKey, JSON.stringify(normalized));
  }, [scopedSeenStorageKey]);

  const refreshNewReleasesUnread = useCallback(async (seq: number, markAsSeen = false) => {
    const isCurrent = () => seq === newReleasesRefreshSeqRef.current;
    const activeScopes = scopesRef.current;

    if (!isLoggedIn || !anchorServerId || activeScopes.length === 0) {
      emitMultiServerDebug('new_releases_unread_skip', {
        seq,
        markAsSeen,
        reason: !isLoggedIn
          ? 'not_logged_in'
          : !anchorServerId
            ? 'missing_anchor_server'
            : 'empty_scope_pairs',
        anchorServerId,
        scopes: activeScopes,
        scopeFingerprint,
        onNewReleasesPage: onNewReleasesPageRef.current,
      });
      if (isCurrent()) setNewReleasesUnreadCount(0);
      return;
    }

    const startedAt = performance.now();
    emitMultiServerDebug('new_releases_unread_start', {
      seq,
      markAsSeen,
      anchorServerId,
      scopes: activeScopes,
      scopeFingerprint,
      onNewReleasesPage: onNewReleasesPageRef.current,
      storageKey: scopedSeenStorageKey,
    });
    try {
      const newest = await loadLocalNewReleases(
        anchorServerId,
        activeScopes,
        NEW_RELEASES_UNREAD_SAMPLE_SIZE,
        0,
        [],
        // Badge only reads album ids; skip the ~3s genre-count aggregation that
        // otherwise monopolizes the single mainstage read connection on every
        // poll and starves the Home New/Latest rails.
        false,
      );
      if (!isCurrent()) {
        emitMultiServerDebug('new_releases_unread_stale', {
          seq,
          durationMs: Math.round(performance.now() - startedAt),
          newestCount: newest.albums.length,
          currentSeq: newReleasesRefreshSeqRef.current,
        });
        return;
      }
      const newestIds = newest.albums.map(a => a.id).filter(Boolean);
      const seenIds = readSeenNewReleaseIds();

      if (seenIds.length === 0) {
        // First bootstrap for this server/scope: baseline is "already seen".
        writeSeenNewReleaseIds(newestIds);
        if (isCurrent()) setNewReleasesUnreadCount(0);
        emitMultiServerDebug('new_releases_unread_done', {
          seq,
          action: 'bootstrap_seen_baseline',
          durationMs: Math.round(performance.now() - startedAt),
          newestCount: newestIds.length,
          seenCountBefore: 0,
          unreadCount: 0,
          sampleNewestIds: newestIds.slice(0, 10),
        });
        return;
      }

      if (markAsSeen) {
        // Prepend the live newest sample so a full `seenIds` list + slice(500)
        // cannot silently discard freshly "read" albums (fixes badge coming back).
        writeSeenNewReleaseIds(mergeSeenNewReleaseIdsCap(seenIds, newestIds, NEW_RELEASES_SEEN_MAX_IDS));
        if (isCurrent()) setNewReleasesUnreadCount(0);
        emitMultiServerDebug('new_releases_unread_done', {
          seq,
          action: 'mark_as_seen',
          durationMs: Math.round(performance.now() - startedAt),
          newestCount: newestIds.length,
          seenCountBefore: seenIds.length,
          unreadCount: 0,
          sampleNewestIds: newestIds.slice(0, 10),
        });
        return;
      }

      const seenSet = new Set(seenIds);
      const unread = newestIds.reduce((count, id) => count + (seenSet.has(id) ? 0 : 1), 0);

      if (isCurrent()) setNewReleasesUnreadCount(unread);
      emitMultiServerDebug('new_releases_unread_done', {
        seq,
        action: 'count_unread',
        durationMs: Math.round(performance.now() - startedAt),
        newestCount: newestIds.length,
        seenCountBefore: seenIds.length,
        unreadCount: unread,
        sampleNewestIds: newestIds.slice(0, 10),
      });
    } catch (error) {
      // Keep previous value on transient network/API errors.
      emitMultiServerDebug('new_releases_unread_error', {
        seq,
        durationMs: Math.round(performance.now() - startedAt),
        anchorServerId,
        scopes: activeScopes,
        scopeFingerprint,
        error: describeMultiServerError(error),
      });
    }
  }, [
    anchorServerId,
    isLoggedIn,
    readSeenNewReleaseIds,
    scopeFingerprint,
    scopedSeenStorageKey,
    writeSeenNewReleaseIds,
  ]);

  // Mount + page-mode/scope changes + StrictMode + poll can each fire a refresh
  // within a few ms. Every fire runs a mainstage read that serializes on the one
  // mainstage connection, so a burst needlessly delays the Home rails behind it.
  // Coalesce bursts into a single trailing run, OR-ing the mark-as-seen intent.
  const refreshDebounceRef = useRef<number | null>(null);
  const pendingMarkAsSeenRef = useRef(false);
  const scheduleRefreshNewReleasesUnread = useCallback((
    markAsSeen = false,
    delayMs = NEW_RELEASES_UNREAD_DEBOUNCE_MS,
  ) => {
    const seq = ++newReleasesRefreshSeqRef.current;
    pendingMarkAsSeenRef.current = pendingMarkAsSeenRef.current || markAsSeen;
    if (refreshDebounceRef.current != null) {
      window.clearTimeout(refreshDebounceRef.current);
    }
    emitMultiServerDebug('new_releases_unread_schedule', {
      seq,
      markAsSeen,
      pendingMarkAsSeen: pendingMarkAsSeenRef.current,
      onNewReleasesPage: onNewReleasesPageRef.current,
      anchorServerId,
      scopes: scopesRef.current,
      scopeFingerprint,
    });
    refreshDebounceRef.current = window.setTimeout(() => {
      refreshDebounceRef.current = null;
      const mark = pendingMarkAsSeenRef.current;
      pendingMarkAsSeenRef.current = false;
      if (document.documentElement.hasAttribute('data-benchmark-running')) {
        emitMultiServerDebug('new_releases_unread_skip', {
          seq,
          markAsSeen: mark,
          reason: 'benchmark_running',
          anchorServerId,
          scopeFingerprint,
        });
        return;
      }
      void refreshNewReleasesUnread(seq, mark);
    }, delayMs);
  }, [anchorServerId, refreshNewReleasesUnread, scopeFingerprint]);

  useEffect(() => {
    scheduleRefreshNewReleasesUnread(false, NEW_RELEASES_UNREAD_BACKGROUND_DELAY_MS);
    const timer = window.setInterval(() => {
      const enteredAt = newReleasesPageEnteredAtRef.current;
      const delayedSeenReached =
        onNewReleasesPageRef.current &&
        enteredAt != null &&
        Date.now() - enteredAt >= NEW_RELEASES_RESET_DELAY_MS;
      scheduleRefreshNewReleasesUnread(delayedSeenReached);
    }, NEW_RELEASES_UNREAD_POLL_MS);
    return () => {
      window.clearInterval(timer);
      if (refreshDebounceRef.current != null) {
        window.clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
      pendingMarkAsSeenRef.current = false;
      newReleasesRefreshSeqRef.current += 1;
    };
  }, [scheduleRefreshNewReleasesUnread]);

  useEffect(() => {
    if (newReleasesResetTimerRef.current != null) {
      window.clearTimeout(newReleasesResetTimerRef.current);
      newReleasesResetTimerRef.current = null;
    }

    if (onNewReleasesPage) {
      if (newReleasesPageEnteredAtRef.current == null) {
        newReleasesPageEnteredAtRef.current = Date.now();
      }
      const elapsed = Date.now() - newReleasesPageEnteredAtRef.current;
      const shouldMarkAsSeen = elapsed >= NEW_RELEASES_RESET_DELAY_MS;
      if (shouldMarkAsSeen) {
        scheduleRefreshNewReleasesUnread(true);
      } else {
        const remaining = NEW_RELEASES_RESET_DELAY_MS - elapsed;
        newReleasesResetTimerRef.current = window.setTimeout(() => {
          newReleasesResetTimerRef.current = null;
          scheduleRefreshNewReleasesUnread(true);
        }, remaining);
      }
    } else {
      newReleasesPageEnteredAtRef.current = null;
    }
    return () => {
      if (newReleasesResetTimerRef.current != null) {
        window.clearTimeout(newReleasesResetTimerRef.current);
        newReleasesResetTimerRef.current = null;
      }
    };
  }, [onNewReleasesPage, scheduleRefreshNewReleasesUnread]);

  return newReleasesUnreadCount;
}
