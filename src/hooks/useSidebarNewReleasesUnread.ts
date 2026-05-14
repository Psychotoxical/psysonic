import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAlbumList } from '../api/subsonicLibrary';
import {
  NEW_RELEASES_RESET_DELAY_MS,
  NEW_RELEASES_SEEN_MAX_IDS,
  NEW_RELEASES_UNREAD_POLL_MS,
  NEW_RELEASES_UNREAD_SAMPLE_SIZE,
  NEW_RELEASES_UNREAD_STORAGE_PREFIX,
  mergeSeenNewReleaseIdsCap,
} from '../utils/componentHelpers/sidebarHelpers';

interface Args {
  serverId: string;
  filterId: string;
  isLoggedIn: boolean;
  pathname: string;
}

export function useSidebarNewReleasesUnread({ serverId, filterId, isLoggedIn, pathname }: Args): number {
  const [newReleasesUnreadCount, setNewReleasesUnreadCount] = useState(0);
  const newReleasesRefreshSeqRef = useRef(0);
  const newReleasesPageEnteredAtRef = useRef<number | null>(null);
  const newReleasesResetTimerRef = useRef<number | null>(null);

  const newReleasesSeenStorageKey = useMemo(
    () => `${NEW_RELEASES_UNREAD_STORAGE_PREFIX}:${serverId || 'no-server'}:${filterId || 'all'}`,
    [serverId, filterId],
  );
  const newReleasesSeenAllScopeStorageKey = useMemo(
    () => `${NEW_RELEASES_UNREAD_STORAGE_PREFIX}:${serverId || 'no-server'}:all`,
    [serverId],
  );

  const readSeenNewReleaseIdsByKey = useCallback((key: string): string[] => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  }, []);

  const readSeenNewReleaseIds = useCallback(
    () => readSeenNewReleaseIdsByKey(newReleasesSeenStorageKey),
    [newReleasesSeenStorageKey, readSeenNewReleaseIdsByKey],
  );

  const writeSeenNewReleaseIdsByKey = useCallback((key: string, ids: string[]) => {
    const normalized = Array.from(new Set(ids.filter(Boolean))).slice(0, NEW_RELEASES_SEEN_MAX_IDS);
    localStorage.setItem(key, JSON.stringify(normalized));
  }, []);

  const writeSeenNewReleaseIds = useCallback(
    (ids: string[]) => writeSeenNewReleaseIdsByKey(newReleasesSeenStorageKey, ids),
    [newReleasesSeenStorageKey, writeSeenNewReleaseIdsByKey],
  );

  const refreshNewReleasesUnread = useCallback(async (markAsSeen = false) => {
    const seq = ++newReleasesRefreshSeqRef.current;
    const isCurrent = () => seq === newReleasesRefreshSeqRef.current;

    if (!isLoggedIn || !serverId) {
      if (isCurrent()) setNewReleasesUnreadCount(0);
      return;
    }

    try {
      const newest = await getAlbumList('newest', NEW_RELEASES_UNREAD_SAMPLE_SIZE, 0);
      const newestIds = newest.map(a => a.id).filter(Boolean);
      let seenIds = readSeenNewReleaseIds();

      // For a concrete library scope, bootstrap from the server-wide "all libraries"
      // baseline when available, so switching scope doesn't hide existing unread.
      if (seenIds.length === 0 && filterId !== 'all') {
        const allScopeSeen = readSeenNewReleaseIdsByKey(newReleasesSeenAllScopeStorageKey);
        if (allScopeSeen.length > 0) {
          seenIds = allScopeSeen;
          writeSeenNewReleaseIdsByKey(newReleasesSeenStorageKey, allScopeSeen);
        }
      }

      if (seenIds.length === 0) {
        // First bootstrap for this server/scope: baseline is "already seen".
        writeSeenNewReleaseIds(newestIds);
        if (isCurrent()) setNewReleasesUnreadCount(0);
        return;
      }

      if (markAsSeen) {
        // Prepend the live newest sample so a full `seenIds` list + slice(500)
        // cannot silently discard freshly "read" albums (fixes badge coming back).
        writeSeenNewReleaseIds(mergeSeenNewReleaseIdsCap(seenIds, newestIds, NEW_RELEASES_SEEN_MAX_IDS));
        // Keep server-wide baseline in sync so scope fallback never resurrects
        // already-viewed items after opening the New Releases page.
        const allScopeSeen = readSeenNewReleaseIdsByKey(newReleasesSeenAllScopeStorageKey);
        writeSeenNewReleaseIdsByKey(
          newReleasesSeenAllScopeStorageKey,
          mergeSeenNewReleaseIdsCap(allScopeSeen, newestIds, NEW_RELEASES_SEEN_MAX_IDS),
        );
        if (isCurrent()) setNewReleasesUnreadCount(0);
        return;
      }

      const seenSet = new Set(seenIds);
      const unread = newestIds.reduce((count, id) => count + (seenSet.has(id) ? 0 : 1), 0);

      if (isCurrent()) setNewReleasesUnreadCount(unread);
    } catch {
      // Keep previous value on transient network/API errors.
    }
  }, [
    filterId,
    isLoggedIn,
    newReleasesSeenAllScopeStorageKey,
    newReleasesSeenStorageKey,
    readSeenNewReleaseIds,
    readSeenNewReleaseIdsByKey,
    serverId,
    writeSeenNewReleaseIds,
    writeSeenNewReleaseIdsByKey,
  ]);

  useEffect(() => {
    const onNewReleasesPage = pathname.startsWith('/new-releases');
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
      void refreshNewReleasesUnread(shouldMarkAsSeen);
      if (!shouldMarkAsSeen) {
        const remaining = NEW_RELEASES_RESET_DELAY_MS - elapsed;
        newReleasesResetTimerRef.current = window.setTimeout(() => {
          newReleasesResetTimerRef.current = null;
          void refreshNewReleasesUnread(true);
        }, remaining);
      }
    } else {
      newReleasesPageEnteredAtRef.current = null;
      void refreshNewReleasesUnread(false);
    }

    const timer = window.setInterval(() => {
      const activeOnNewReleases = pathname.startsWith('/new-releases');
      const enteredAt = newReleasesPageEnteredAtRef.current;
      const delayedSeenReached =
        activeOnNewReleases &&
        enteredAt != null &&
        Date.now() - enteredAt >= NEW_RELEASES_RESET_DELAY_MS;
      void refreshNewReleasesUnread(delayedSeenReached);
    }, NEW_RELEASES_UNREAD_POLL_MS);
    return () => {
      window.clearInterval(timer);
      if (newReleasesResetTimerRef.current != null) {
        window.clearTimeout(newReleasesResetTimerRef.current);
        newReleasesResetTimerRef.current = null;
      }
    };
  }, [pathname, refreshNewReleasesUnread]);

  return newReleasesUnreadCount;
}
