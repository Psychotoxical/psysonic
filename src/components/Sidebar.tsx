import React, { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { useAuthStore } from '../store/authStore';
import { useSidebarStore, type SidebarItemConfig } from '../store/sidebarStore';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Settings,
  PanelLeftClose, PanelLeft, AudioLines, HardDriveDownload, HardDriveUpload,
  ChevronDown, Check, Music2, X, ChevronRight, PlayCircle, Sparkles, Trash2,
} from 'lucide-react';
import PsysonicLogo from './PsysonicLogo';
import PSmallLogo from './PSmallLogo';
import WhatsNewBanner from './WhatsNewBanner';
import { getAlbumList, getPlaylists } from '../api/subsonic';
import { usePlaylistStore } from '../store/playlistStore';
import { ALL_NAV_ITEMS } from '../config/navItems';
import OverlayScrollArea from './OverlayScrollArea';
import {
  applySidebarDropReorder,
  getLibraryItemsForReorder,
  getSystemItemsForReorder,
  isSidebarNavItemUserHideable,
  type SidebarNavDropTarget,
} from '../utils/sidebarNavReorder';
import { useLuckyMixAvailable } from '../hooks/useLuckyMixAvailable';
import { resetPerfProbeFlags, setPerfProbeFlag, usePerfProbeFlags } from '../utils/perfFlags';
import { setPerfProbeTelemetryActive } from '../utils/perfTelemetry';

const SIDEBAR_NAV_LONG_PRESS_MS = 1000;
const SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX = 10;
const SMART_PREFIX = 'psy-smart-';
const NEW_RELEASES_UNREAD_STORAGE_PREFIX = 'psy_new_releases_unread_seen_v1';
const NEW_RELEASES_UNREAD_SAMPLE_SIZE = 80;
const NEW_RELEASES_UNREAD_POLL_MS = 2 * 60 * 1000;
const NEW_RELEASES_RESET_DELAY_MS = 5_000;
/** Max album ids persisted per server/scope; cap must not drop the latest "newest" batch when marking read. */
const NEW_RELEASES_SEEN_MAX_IDS = 500;

/** Merge previous seen IDs with the current `getAlbumList(newest)` sample: newest batch is kept in full first, then older seen until `maxIds` (localStorage budget). */
function mergeSeenNewReleaseIdsCap(prevSeen: string[], newestBatch: string[], maxIds: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of newestBatch) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of prevSeen) {
    if (out.length >= maxIds) break;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

function isPointerOutsideAsideSidebar(clientX: number, clientY: number): boolean {
  const aside = document.querySelector('aside.sidebar');
  if (!aside) return false;
  const r = aside.getBoundingClientRect();
  return clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
}


export default function Sidebar({
  isCollapsed = false,
  toggleCollapse,
}: {
  isCollapsed?: boolean;
  toggleCollapse?: () => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const isPlaying   = usePlayerStore(s => s.isPlaying);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const offlineJobs = useOfflineJobStore(s => s.jobs);
  const cancelAllDownloads = useOfflineJobStore(s => s.cancelAllDownloads);
  const activeJobs = offlineJobs.filter(j => j.status === 'queued' || j.status === 'downloading');
  const syncJobStatus = useDeviceSyncJobStore(s => s.status);
  const syncJobDone   = useDeviceSyncJobStore(s => s.done);
  const syncJobSkip   = useDeviceSyncJobStore(s => s.skipped);
  const syncJobFail   = useDeviceSyncJobStore(s => s.failed);
  const syncJobTotal  = useDeviceSyncJobStore(s => s.total);
  const isSyncing     = syncJobStatus === 'running';
  const offlineAlbums = useOfflineStore(s => s.albums);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const musicFolders = useAuthStore(s => s.musicFolders);
  const musicLibraryFilterByServer = useAuthStore(s => s.musicLibraryFilterByServer);
  const setMusicLibraryFilter = useAuthStore(s => s.setMusicLibraryFilter);
  const hotCacheEnabled = useAuthStore(s => s.hotCacheEnabled);
  const setHotCacheEnabled = useAuthStore(s => s.setHotCacheEnabled);
  const normalizationEngine = useAuthStore(s => s.normalizationEngine);
  const setNormalizationEngine = useAuthStore(s => s.setNormalizationEngine);
  const loggingMode = useAuthStore(s => s.loggingMode);
  const setLoggingMode = useAuthStore(s => s.setLoggingMode);
  const hasOfflineContent = Object.values(offlineAlbums).some(a => a.serverId === serverId);
  const sidebarItems = useSidebarStore(s => s.items);
  const setSidebarItems = useSidebarStore(s => s.setItems);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const luckyMixBase = useLuckyMixAvailable();
  // Sidebar surfaces Lucky Mix as its own entry only in "separate" nav mode —
  // in hub mode it lives inside the Build-a-Mix landing page instead.
  const luckyMixAvailable = luckyMixBase && randomNavMode === 'separate';
  const [libraryDropdownOpen, setLibraryDropdownOpen] = useState(false);
  const [playlistsExpanded, setPlaylistsExpanded] = useState(false);
  const playlistsRaw = usePlaylistStore(s => s.playlists);
  const playlistsLoading = usePlaylistStore(s => s.playlistsLoading);
  const fetchPlaylists = usePlaylistStore(s => s.fetchPlaylists);
  // Sort playlists alphabetically by name
  const playlists = useMemo(() => {
    return [...playlistsRaw].sort((a, b) => a.name.localeCompare(b.name));
  }, [playlistsRaw]);
  const [dropdownRect, setDropdownRect] = useState({ top: 0, left: 0, width: 0 });
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const [sidebarViewportEl, setSidebarViewportEl] = useState<HTMLDivElement | null>(null);
  const [isSidebarScrolling, setIsSidebarScrolling] = useState(false);
  const showLibraryPicker = !isCollapsed && isLoggedIn && musicFolders.length > 1;

  const filterId = serverId ? (musicLibraryFilterByServer[serverId] ?? 'all') : 'all';
  const selectedFolderName =
    filterId === 'all' ? null : musicFolders.find(f => f.id === filterId)?.name ?? null;
  const libraryTriggerPlain = filterId === 'all';

  const libraryItemsForReorder = useMemo(
    () => getLibraryItemsForReorder(sidebarItems, randomNavMode),
    [sidebarItems, randomNavMode],
  );
  const systemItemsForReorder = useMemo(
    () => getSystemItemsForReorder(sidebarItems),
    [sidebarItems],
  );
  const visibleLibraryConfigs = useMemo(
    () =>
      libraryItemsForReorder.filter(c => {
        if (!c.visible) return false;
        if (c.id === 'luckyMix' && !luckyMixAvailable) return false;
        return true;
      }),
    [libraryItemsForReorder, luckyMixAvailable],
  );
  const visibleSystemConfigs = useMemo(
    () => systemItemsForReorder.filter(c => c.visible),
    [systemItemsForReorder],
  );

  const [navDnd, setNavDnd] = useState<{
    section: 'library' | 'system';
    fromIdx: number;
  } | null>(null);
  const [navDropTarget, setNavDropTarget] = useState<SidebarNavDropTarget | null>(null);
  const navDropTargetRef = useRef<SidebarNavDropTarget | null>(null);
  navDropTargetRef.current = navDropTarget;
  const sidebarItemsRef = useRef(sidebarItems);
  sidebarItemsRef.current = sidebarItems;
  const randomNavModeRef = useRef(randomNavMode);
  randomNavModeRef.current = randomNavMode;
  /** DOM timers are numeric; avoid NodeJS `Timeout` typing from `setTimeout`. */
  const longPressTimersRef = useRef<Map<number, number>>(new Map());
  const suppressNavClickRef = useRef(false);
  const lastPointerDuringNavDndRef = useRef({ x: 0, y: 0 });
  const [navDndTrashHint, setNavDndTrashHint] = useState<{ x: number; y: number } | null>(null);
  const [newReleasesUnreadCount, setNewReleasesUnreadCount] = useState(0);
  const newReleasesRefreshSeqRef = useRef(0);
  const newReleasesPageEnteredAtRef = useRef<number | null>(null);
  const newReleasesResetTimerRef = useRef<number | null>(null);
  const [perfProbeOpen, setPerfProbeOpen] = useState(false);
  const perfFlags = usePerfProbeFlags();
  const [perfCpu, setPerfCpu] = useState<{ app: number; webkit: number; supported: boolean } | null>(null);
  const [perfDiagRates, setPerfDiagRates] = useState<{ progress: number; waveform: number; home: number } | null>(null);

  useEffect(() => {
    setPerfProbeTelemetryActive(perfProbeOpen);
    return () => setPerfProbeTelemetryActive(false);
  }, [perfProbeOpen]);

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
      let unread = newestIds.reduce((count, id) => count + (seenSet.has(id) ? 0 : 1), 0);

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
    if (!navDnd) return;

    const updateDropFromPoint = (clientX: number, clientY: number) => {
      if (isPointerOutsideAsideSidebar(clientX, clientY)) {
        navDropTargetRef.current = null;
        setNavDropTarget(null);
        return;
      }
      const rows = document.querySelectorAll<HTMLElement>('.sidebar [data-sidebar-nav-dnd-row]');
      let target: SidebarNavDropTarget | null = null;
      for (const row of rows) {
        const section = row.dataset.sidebarSection as 'library' | 'system' | undefined;
        if (section !== navDnd.section) continue;
        const rect = row.getBoundingClientRect();
        const idx = Number(row.dataset.sidebarIdx);
        if (Number.isNaN(idx)) continue;
        if (clientY < rect.top + rect.height / 2) {
          target = { idx, before: true, section };
          break;
        }
        target = { idx, before: false, section };
      }
      navDropTargetRef.current = target;
      setNavDropTarget(target);
    };

    const endDrag = (apply: boolean) => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
      setNavDndTrashHint(null);

      const currentDnd = navDnd;
      const drop = navDropTargetRef.current;
      setNavDnd(null);
      setNavDropTarget(null);
      navDropTargetRef.current = null;

      if (!apply || !currentDnd) return;

      const { x, y } = lastPointerDuringNavDndRef.current;
      if (isPointerOutsideAsideSidebar(x, y)) {
        const sectionItems =
          currentDnd.section === 'library'
            ? getLibraryItemsForReorder(sidebarItemsRef.current, randomNavModeRef.current)
            : getSystemItemsForReorder(sidebarItemsRef.current);
        const id = sectionItems[currentDnd.fromIdx]?.id;
        if (id && isSidebarNavItemUserHideable(id)) {
          const nextItems: SidebarItemConfig[] = sidebarItemsRef.current.map(i =>
            i.id === id ? { ...i, visible: false } : i,
          );
          setSidebarItems(nextItems);
          suppressNavClickRef.current = true;
        }
        return;
      }

      const next = applySidebarDropReorder(
        sidebarItemsRef.current,
        currentDnd.section,
        currentDnd.fromIdx,
        drop,
        randomNavModeRef.current,
      );
      if (next) {
        setSidebarItems(next);
        suppressNavClickRef.current = true;
      }
    };

    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      lastPointerDuringNavDndRef.current = { x: e.clientX, y: e.clientY };

      const outside = isPointerOutsideAsideSidebar(e.clientX, e.clientY);
      const sectionItems =
        navDnd.section === 'library'
          ? getLibraryItemsForReorder(sidebarItemsRef.current, randomNavModeRef.current)
          : getSystemItemsForReorder(sidebarItemsRef.current);
      const draggedId = sectionItems[navDnd.fromIdx]?.id;
      const canTrash = Boolean(draggedId && isSidebarNavItemUserHideable(draggedId));
      if (outside && canTrash) {
        setNavDndTrashHint({ x: e.clientX, y: e.clientY });
      } else {
        setNavDndTrashHint(null);
      }

      updateDropFromPoint(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      lastPointerDuringNavDndRef.current = { x: e.clientX, y: e.clientY };
      // Prevent synthetic click/navigation right after finishing a drag gesture.
      suppressNavClickRef.current = true;
      endDrag(true);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endDrag(false);
      }
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);

    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
      setNavDndTrashHint(null);
    };
  }, [navDnd, setSidebarItems]);

  const handleNavRowPointerDown = useCallback(
    (e: React.PointerEvent, section: 'library' | 'system', sectionIdx: number) => {
      if (isCollapsed || navDnd) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const pid = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;

      let cleaned = false;
      const cleanupEarly = () => {
        if (cleaned) return;
        cleaned = true;
        document.removeEventListener('pointermove', onEarlyMove);
        document.removeEventListener('pointerup', onEarlyUp, true);
        document.removeEventListener('pointercancel', onEarlyUp, true);
      };

      const onEarlyMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX) {
          const t = longPressTimersRef.current.get(pid);
          if (t != null) window.clearTimeout(t);
          longPressTimersRef.current.delete(pid);
          cleanupEarly();
        }
      };

      const onEarlyUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const t = longPressTimersRef.current.get(pid);
        if (t != null) window.clearTimeout(t);
        longPressTimersRef.current.delete(pid);
        cleanupEarly();
      };

      const timer = window.setTimeout(() => {
        longPressTimersRef.current.delete(pid);
        cleanupEarly();
        window.getSelection()?.removeAllRanges();
        lastPointerDuringNavDndRef.current = { x: sx, y: sy };
        setNavDnd({ section, fromIdx: sectionIdx });
        navDropTargetRef.current = { idx: sectionIdx, before: true, section };
        setNavDropTarget({ idx: sectionIdx, before: true, section });
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(pid);
        } catch {
          /* ignore */
        }
      }, SIDEBAR_NAV_LONG_PRESS_MS) as unknown as number;

      longPressTimersRef.current.set(pid, timer);
      document.addEventListener('pointermove', onEarlyMove);
      document.addEventListener('pointerup', onEarlyUp, true);
      document.addEventListener('pointercancel', onEarlyUp, true);
    },
    [isCollapsed, navDnd],
  );

  const navDndRowClass = useCallback(
    (section: 'library' | 'system', sectionIdx: number) => {
      const dragging = navDnd?.section === section && navDnd.fromIdx === sectionIdx;
      let drop = '';
      if (
        navDnd &&
        navDropTarget?.section === section &&
        navDropTarget.idx === sectionIdx &&
        !(navDnd.section === section && navDnd.fromIdx === sectionIdx)
      ) {
        drop = navDropTarget.before
          ? 'sidebar-nav-dnd-row--drop-before'
          : 'sidebar-nav-dnd-row--drop-after';
      }
      return `sidebar-nav-dnd-row${dragging ? ' sidebar-nav-dnd-row--dragging' : ''}${drop ? ` ${drop}` : ''}`.trim();
    },
    [navDnd, navDropTarget],
  );

  const updateDropdownPosition = useCallback(() => {
    const el = libraryTriggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDropdownRect({
      top: r.bottom + 4,
      left: r.left,
      width: r.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!libraryDropdownOpen) return;
    updateDropdownPosition();
    const onWin = () => updateDropdownPosition();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [libraryDropdownOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!libraryDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (libraryTriggerRef.current?.contains(t)) return;
      const panel = document.querySelector('.nav-library-dropdown-panel');
      if (panel?.contains(t)) return;
      setLibraryDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLibraryDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [libraryDropdownOpen]);

  const pickLibrary = (id: 'all' | string) => {
    setMusicLibraryFilter(id);
    setLibraryDropdownOpen(false);
  };

  // Fetch playlists when expanded
  useEffect(() => {
    if (!playlistsExpanded || !isLoggedIn) return;
    fetchPlaylists();
  }, [playlistsExpanded, isLoggedIn, fetchPlaylists]);

  useEffect(() => () => {
    longPressTimersRef.current.forEach(t => window.clearTimeout(t));
    longPressTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!sidebarViewportEl) return;
    let hideTimer: number | null = null;

    const onScroll = () => {
      setIsSidebarScrolling(true);
      if (hideTimer != null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        setIsSidebarScrolling(false);
        hideTimer = null;
      }, 180);
    };

    sidebarViewportEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sidebarViewportEl.removeEventListener('scroll', onScroll);
      if (hideTimer != null) window.clearTimeout(hideTimer);
    };
  }, [sidebarViewportEl]);

  useEffect(() => {
    const onNewReleasesPage = location.pathname.startsWith('/new-releases');
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
      const activeOnNewReleases = location.pathname.startsWith('/new-releases');
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
  }, [location.pathname, refreshNewReleasesUnread]);

  useEffect(() => {
    if (!perfProbeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPerfProbeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [perfProbeOpen]);

  useEffect(() => {
    if (!perfProbeOpen) return;
    type Snapshot = {
      supported: boolean;
      total_jiffies: number;
      app_jiffies: number;
      webkit_jiffies: number;
      logical_cpus: number;
    };
    let cancelled = false;
    let prev: Snapshot | null = null;
    let prevCounters: { progress: number; waveform: number; home: number } | null = null;
    let prevCountersAt = 0;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const snap = await invoke<Snapshot>('performance_cpu_snapshot');
        if (cancelled) return;
        if (!snap.supported) {
          setPerfCpu({ app: 0, webkit: 0, supported: false });
          return;
        }
        if (prev) {
          const totalDelta = snap.total_jiffies - prev.total_jiffies;
          const appDelta = snap.app_jiffies - prev.app_jiffies;
          const webkitDelta = snap.webkit_jiffies - prev.webkit_jiffies;
          if (totalDelta > 0) {
            const cpuScale = Math.max(1, snap.logical_cpus || 1) * 100;
            const appPct = Math.max(0, Math.min(1000, (appDelta / totalDelta) * cpuScale));
            const webkitPct = Math.max(0, Math.min(1000, (webkitDelta / totalDelta) * cpuScale));
            setPerfCpu({
              app: Number.isFinite(appPct) ? appPct : 0,
              webkit: Number.isFinite(webkitPct) ? webkitPct : 0,
              supported: true,
            });
          }
        }
        const now = Date.now();
        const root = globalThis as unknown as { __psyPerfCounters?: Record<string, number> };
        const counters = root.__psyPerfCounters ?? {};
        const nextCounters = {
          progress: counters.audioProgressEvents ?? 0,
          waveform: counters.waveformDraws ?? 0,
          home: counters.homeCommits ?? 0,
        };
        if (prevCounters && prevCountersAt > 0) {
          const dt = Math.max(0.25, (now - prevCountersAt) / 1000);
          setPerfDiagRates({
            progress: (nextCounters.progress - prevCounters.progress) / dt,
            waveform: (nextCounters.waveform - prevCounters.waveform) / dt,
            home: (nextCounters.home - prevCounters.home) / dt,
          });
        }
        prevCounters = nextCounters;
        prevCountersAt = now;
        prev = snap;
      } catch {
        if (!cancelled) setPerfCpu({ app: 0, webkit: 0, supported: false });
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [perfProbeOpen]);

  useEffect(() => {
    if (!perfProbeOpen) {
      setPerfCpu(null);
      setPerfDiagRates(null);
    }
  }, [perfProbeOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey)) return;
      if (e.key.toLowerCase() !== 'd') return;
      const target = e.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )) return;
      e.preventDefault();
      setPerfProbeOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
    <aside className={`sidebar animate-slide-in ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand" aria-hidden>
        {isCollapsed
          ? <PSmallLogo style={{ height: '32px', width: 'auto' }} />
          : <PsysonicLogo style={{ height: '28px', width: 'auto' }} />
        }
      </div>

      <button
        className="collapse-btn"
        onClick={toggleCollapse}
        style={{
          opacity: isSidebarScrolling ? 0 : 1,
          pointerEvents: isSidebarScrolling ? 'none' : 'auto',
        }}
        data-tooltip={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        data-tooltip-pos="right"
      >
        {isCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
      </button>

      <nav
        className="sidebar-nav"
        aria-label="Main navigation"
        onClickCapture={e => {
          if (suppressNavClickRef.current) {
            suppressNavClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <OverlayScrollArea
          className="sidebar-nav-scroll"
          viewportClassName="sidebar-nav-viewport"
          viewportRef={setSidebarViewportEl}
          railInset="panel"
          measureDeps={[
            isCollapsed,
            playlistsExpanded,
            playlists.length,
            isLoggedIn,
            randomNavMode,
            filterId,
            hasOfflineContent,
            activeJobs.length,
            isSyncing,
            syncJobTotal,
            sidebarItems.length,
          ]}
        >
        {!isCollapsed && (showLibraryPicker ? (
          <>
            <button
              ref={libraryTriggerRef}
              type="button"
              className={`nav-library-scope-trigger ${libraryTriggerPlain ? 'nav-library-scope-trigger--plain' : ''} ${libraryDropdownOpen ? 'nav-library-scope-trigger--open' : ''}`}
              onClick={() => {
                setLibraryDropdownOpen(o => !o);
              }}
              aria-label={t('sidebar.libraryScope')}
              aria-expanded={libraryDropdownOpen}
              aria-haspopup="listbox"
              data-tooltip={libraryDropdownOpen ? undefined : t('sidebar.libraryScope')}
              data-tooltip-pos="bottom"
            >
              {!libraryTriggerPlain ? (
                <Music2 size={16} className="nav-library-scope-icon" strokeWidth={2} aria-hidden />
              ) : null}
              <div className="nav-library-scope-text">
                <span className="nav-library-scope-title">{t('sidebar.library')}</span>
                {selectedFolderName ? (
                  <span className="nav-library-scope-subtitle" data-tooltip={selectedFolderName} data-tooltip-pos="right">
                    {selectedFolderName}
                  </span>
                ) : null}
              </div>
              <ChevronDown size={16} strokeWidth={2.25} className="nav-library-scope-chevron" aria-hidden />
            </button>
            {libraryDropdownOpen &&
              createPortal(
                <div
                  className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
                  role="listbox"
                  aria-label={t('sidebar.libraryScope')}
                  style={{
                    position: 'fixed',
                    top: dropdownRect.top,
                    left: dropdownRect.left,
                    width: dropdownRect.width,
                    minWidth: dropdownRect.width,
                    maxWidth: dropdownRect.width,
                    boxSizing: 'border-box',
                  }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={filterId === 'all'}
                    className={`nav-library-dropdown-item ${filterId === 'all' ? 'nav-library-dropdown-item--selected' : ''}`}
                    onClick={() => pickLibrary('all')}
                  >
                    <span className="nav-library-dropdown-item-label">{t('sidebar.allLibraries')}</span>
                    {filterId === 'all' ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
                  </button>
                  {musicFolders.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      role="option"
                      aria-selected={filterId === f.id}
                      className={`nav-library-dropdown-item ${filterId === f.id ? 'nav-library-dropdown-item--selected' : ''}`}
                      onClick={() => pickLibrary(f.id)}
                    >
                      <span className="nav-library-dropdown-item-label">{f.name}</span>
                      {filterId === f.id ? <Check size={16} className="nav-library-dropdown-check" strokeWidth={2.5} /> : <span className="nav-library-dropdown-check-spacer" />}
                    </button>
                  ))}
                </div>,
                document.body
              )}
          </>
        ) : (
          <span className="nav-section-label">{t('sidebar.library')}</span>
        ))}
        {visibleLibraryConfigs.map(cfg => {
          const item = ALL_NAV_ITEMS[cfg.id];
          if (!item) return null;
          const sectionIdx = libraryItemsForReorder.findIndex(x => x.id === cfg.id);
          const dndRow = !isCollapsed && sectionIdx >= 0;
          const rowClass = dndRow ? navDndRowClass('library', sectionIdx) : undefined;
          const dndProps = dndRow
            ? {
                'data-sidebar-nav-dnd-row': '',
                'data-sidebar-section': 'library' as const,
                'data-sidebar-idx': String(sectionIdx),
                onPointerDown: (e: React.PointerEvent) =>
                  handleNavRowPointerDown(e, 'library', sectionIdx),
              }
            : {};

          return item.to === '/playlists' && !isCollapsed ? (
            <div
              key={item.to}
              className={`sidebar-playlists-wrapper${rowClass ? ` ${rowClass}` : ''}`}
              {...dndProps}
              style={navDnd && dndRow ? { touchAction: 'none' } : undefined}
            >
              <div className="sidebar-playlists-header-row">
                <NavLink
                  to={item.to}
                  className={({ isActive }) => `nav-link sidebar-playlists-main-link ${isActive ? 'active' : ''}`}
                >
                  <item.icon size={18} />
                  <span>{t(item.labelKey)}</span>
                </NavLink>
                <button
                  className={`sidebar-playlists-toggle ${playlistsExpanded ? 'expanded' : ''}`}
                  onClick={() => setPlaylistsExpanded(!playlistsExpanded)}
                  aria-expanded={playlistsExpanded}
                  aria-label={playlistsExpanded ? t('sidebar.collapsePlaylists') : t('sidebar.expandPlaylists')}
                  data-tooltip={playlistsExpanded ? t('sidebar.collapsePlaylists') : t('sidebar.expandPlaylists')}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {playlistsExpanded && (
                <div className="sidebar-playlists-list">
                  {playlistsLoading ? (
                    <div className="sidebar-playlists-loading">
                      <div className="spinner" style={{ width: 14, height: 14 }} />
                    </div>
                  ) : playlists.length === 0 ? (
                    <div className="sidebar-playlists-empty">{t('playlists.empty')}</div>
                  ) : (
                    playlists.map((pl: { id: string; name: string }) => (
                      <NavLink
                        key={pl.id}
                        to={`/playlists/${pl.id}`}
                        className={({ isActive }) => `nav-link sidebar-playlist-item ${isActive ? 'active' : ''}`}
                      >
                        {isSmartPlaylistName(pl.name) ? <Sparkles size={12} /> : <PlayCircle size={12} />}
                        <span>{displayPlaylistName(pl.name)}</span>
                      </NavLink>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : isCollapsed ? (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
              data-tooltip-pos="bottom"
            >
              <item.icon size={isCollapsed ? 22 : 18} />
              {item.to === '/new-releases' && newReleasesUnreadCount > 0 && (
                <span className="sidebar-nav-unread-badge" aria-hidden>
                  {newReleasesUnreadCount > 99 ? '99+' : newReleasesUnreadCount}
                </span>
              )}
              {!isCollapsed && <span>{t(item.labelKey)}</span>}
            </NavLink>
          ) : (
            <div
              key={item.to}
              className={rowClass}
              {...dndProps}
              style={navDnd && dndRow ? { touchAction: 'none' } : undefined}
            >
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
                data-tooltip-pos="bottom"
              >
                <item.icon size={isCollapsed ? 22 : 18} />
                {!isCollapsed && <span>{t(item.labelKey)}</span>}
                {item.to === '/new-releases' && newReleasesUnreadCount > 0 && (
                  <span className="sidebar-nav-unread-badge" aria-hidden>
                    {newReleasesUnreadCount > 99 ? '99+' : newReleasesUnreadCount}
                  </span>
                )}
              </NavLink>
            </div>
          );
        })}

        {/* Spacer: everything from here onward sticks to the bottom of the sidebar. */}
        <div className="sidebar-bottom-spacer" />

        {/* What's New banner — only visible while the current release hasn't been seen. */}
        <WhatsNewBanner collapsed={isCollapsed} />

        {/* Now Playing — fixed, always visible */}
        <NavLink
          to="/now-playing"
          className={({ isActive }) => `nav-link nav-link-nowplaying ${isActive ? 'active' : ''}`}
          data-tooltip={isCollapsed ? t('sidebar.nowPlaying') : undefined}
          data-tooltip-pos="bottom"
        >
          <span className="nav-np-icon-wrap">
            <AudioLines size={isCollapsed ? 22 : 18} />
            {isPlaying && currentTrack && <span className="nav-np-dot" />}
          </span>
          {!isCollapsed && <span>{t('sidebar.nowPlaying')}</span>}
        </NavLink>

        {hasOfflineContent && (
          <NavLink
            to="/offline"
            className={({ isActive }) => `nav-link nav-link-offline ${isActive ? 'active' : ''}`}
            data-tooltip={isCollapsed ? t('sidebar.offlineLibrary') : undefined}
            data-tooltip-pos="bottom"
          >
            <HardDriveDownload size={isCollapsed ? 22 : 18} />
            {!isCollapsed && <span>{t('sidebar.offlineLibrary')}</span>}
          </NavLink>
        )}

        {visibleSystemConfigs.length > 0 && !isCollapsed && <span className="nav-section-label">{t('sidebar.system')}</span>}
        {visibleSystemConfigs.map(cfg => {
          const item = ALL_NAV_ITEMS[cfg.id];
          if (!item) return null;
          const sectionIdx = systemItemsForReorder.findIndex(x => x.id === cfg.id);
          const dndRow = !isCollapsed && sectionIdx >= 0;
          const rowClass = dndRow ? navDndRowClass('system', sectionIdx) : undefined;
          const dndProps = dndRow
            ? {
                'data-sidebar-nav-dnd-row': '',
                'data-sidebar-section': 'system' as const,
                'data-sidebar-idx': String(sectionIdx),
                onPointerDown: (e: React.PointerEvent) =>
                  handleNavRowPointerDown(e, 'system', sectionIdx),
              }
            : {};

          return isCollapsed ? (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
              data-tooltip-pos="bottom"
            >
              <item.icon size={isCollapsed ? 22 : 18} />
              {!isCollapsed && <span>{t(item.labelKey)}</span>}
            </NavLink>
          ) : (
            <div
              key={item.to}
              className={rowClass}
              {...dndProps}
              style={navDnd && dndRow ? { touchAction: 'none' } : undefined}
            >
              <NavLink
                to={item.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
                data-tooltip-pos="bottom"
              >
                <item.icon size={isCollapsed ? 22 : 18} />
                {!isCollapsed && <span>{t(item.labelKey)}</span>}
              </NavLink>
            </div>
          );
        })}
        <NavLink
          to="/settings"
          className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
          data-tooltip={isCollapsed ? t('sidebar.settings') : undefined}
          data-tooltip-pos="bottom"
        >
          <Settings size={isCollapsed ? 22 : 18} />
          {!isCollapsed && <span>{t('sidebar.settings')}</span>}
        </NavLink>

        {activeJobs.length > 0 && (
          <div
            className={`sidebar-offline-queue ${isCollapsed ? 'sidebar-offline-queue--collapsed' : ''}`}
            data-tooltip={isCollapsed ? t('sidebar.downloadingTracks', { n: activeJobs.length }) : undefined}
            data-tooltip-pos="right"
          >
            <HardDriveDownload size={isCollapsed ? 18 : 14} className="spin-slow" />
            {!isCollapsed && (
              <span>{t('sidebar.downloadingTracks', { n: activeJobs.length })}</span>
            )}
            <button
              className="sidebar-offline-cancel"
              onClick={cancelAllDownloads}
              data-tooltip={t('sidebar.cancelDownload')}
              data-tooltip-pos="right"
              aria-label={t('sidebar.cancelDownload')}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {isSyncing && (
          <div
            className={`sidebar-offline-queue sidebar-sync-queue ${isCollapsed ? 'sidebar-offline-queue--collapsed' : ''}`}
            data-tooltip={isCollapsed ? t('sidebar.syncingTracks', { done: syncJobDone + syncJobSkip + syncJobFail, total: syncJobTotal }) : undefined}
            data-tooltip-pos="right"
          >
            <HardDriveUpload size={isCollapsed ? 18 : 14} className="spin-slow" />
            {!isCollapsed && (
              <span>{t('sidebar.syncingTracks', { done: syncJobDone + syncJobSkip + syncJobFail, total: syncJobTotal })}</span>
            )}
          </div>
        )}
        </OverlayScrollArea>
      </nav>
    </aside>
    {navDndTrashHint != null &&
      createPortal(
        <div
          className="sidebar-nav-dnd-trash-hint"
          style={{
            position: 'fixed',
            left: navDndTrashHint.x + 14,
            top: navDndTrashHint.y + 14,
          }}
          aria-hidden
        >
          <Trash2 size={22} strokeWidth={2.25} />
        </div>,
        document.body,
      )}
    {perfProbeOpen &&
      createPortal(
        <div className="modal-overlay modal-overlay--perf-probe" onClick={() => setPerfProbeOpen(false)} role="dialog" aria-modal="true">
          <div
            className="modal-content sidebar-perf-modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <button className="modal-close" onClick={() => setPerfProbeOpen(false)}><X size={18} /></button>
            <h3 className="modal-title">Performance Probe</h3>
            <p className="sidebar-perf-modal__hint">
              Temporary runtime switches to estimate UI effect cost.
            </p>
            <label className="sidebar-perf-modal__item">
              <input
                type="checkbox"
                checked={perfFlags.showFpsOverlay}
                onChange={e => setPerfProbeFlag('showFpsOverlay', e.target.checked)}
              />
              <span>Show FPS overlay (requestAnimationFrame rate)</span>
            </label>
            <div className="sidebar-perf-modal__cpu">
              <div className="sidebar-perf-modal__cpu-title">Live CPU (approx)</div>
              {perfCpu == null ? (
                <div className="sidebar-perf-modal__cpu-row">Collecting samples…</div>
              ) : perfCpu.supported ? (
                <>
                  <div className="sidebar-perf-modal__cpu-row">psysonic: {perfCpu.app.toFixed(1)}%</div>
                  <div className="sidebar-perf-modal__cpu-row">WebKitWebProcess: {perfCpu.webkit.toFixed(1)}%</div>
                  {perfDiagRates && (
                    <>
                      <div className="sidebar-perf-modal__cpu-row">audio:progress rate: {perfDiagRates.progress.toFixed(1)}/s</div>
                      <div className="sidebar-perf-modal__cpu-row">waveform draws rate: {perfDiagRates.waveform.toFixed(1)}/s</div>
                      <div className="sidebar-perf-modal__cpu-row">Home commits rate: {perfDiagRates.home.toFixed(1)}/s</div>
                    </>
                  )}
                </>
              ) : (
                <div className="sidebar-perf-modal__cpu-row">Unavailable on this platform/build.</div>
              )}
            </div>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 1 — Global / Shell / Network</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableWaveformCanvas}
                  onChange={e => setPerfProbeFlag('disableWaveformCanvas', e.target.checked)}
                />
                <span>Disable only PlayerBar waveform (`WaveformSeek`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disablePlayerProgressUi}
                  onChange={e => setPerfProbeFlag('disablePlayerProgressUi', e.target.checked)}
                />
                <span>Disable player live progress UI updates (time + seek/progress bindings)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMarqueeScroll}
                  onChange={e => setPerfProbeFlag('disableMarqueeScroll', e.target.checked)}
                />
                <span>Disable marquee text scrolling</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableBackdropBlur}
                  onChange={e => setPerfProbeFlag('disableBackdropBlur', e.target.checked)}
                />
                <span>Disable backdrop blur effects</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableCssAnimations}
                  onChange={e => setPerfProbeFlag('disableCssAnimations', e.target.checked)}
                />
                <span>Disable CSS animations and transitions</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableOverlayScrollbars}
                  onChange={e => setPerfProbeFlag('disableOverlayScrollbars', e.target.checked)}
                />
                <span>Disable overlay scrollbar engine (JS + rail)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableTooltipPortal}
                  onChange={e => setPerfProbeFlag('disableTooltipPortal', e.target.checked)}
                />
                <span>Disable global tooltip portal/listeners</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableQueuePanelMount}
                  onChange={e => setPerfProbeFlag('disableQueuePanelMount', e.target.checked)}
                />
                <span>Disable QueuePanel mount (desktop right column)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableBackgroundPolling}
                  onChange={e => setPerfProbeFlag('disableBackgroundPolling', e.target.checked)}
                />
                <span>Disable background polling (connection + radio metadata)</span>
              </label>
              <div className="sidebar-perf-modal__subhead">Engine/network toggles</div>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={!hotCacheEnabled}
                  onChange={e => setHotCacheEnabled(!e.target.checked)}
                />
                <span>Disable hot-cache prefetch downloads</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={normalizationEngine === 'off'}
                  onChange={e => setNormalizationEngine(e.target.checked ? 'off' : 'loudness')}
                />
                <span>Disable normalization engine (set to Off)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={loggingMode === 'off'}
                  onChange={e => setLoggingMode(e.target.checked ? 'off' : 'normal')}
                />
                <span>Set runtime logging mode to Off</span>
              </label>
            </details>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 2 — Mainstage (Center Content)</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainRouteContentMount}
                  onChange={e => setPerfProbeFlag('disableMainRouteContentMount', e.target.checked)}
                />
                <span>Disable central route content mount</span>
              </label>
              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Shared mainstage layers (multiple pages)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageStickyHeader}
                    onChange={e => setPerfProbeFlag('disableMainstageStickyHeader', e.target.checked)}
                  />
                  <span>Disable sticky headers (Tracks + Albums)</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Home (`/`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHero}
                    onChange={e => setPerfProbeFlag('disableMainstageHero', e.target.checked)}
                  />
                  <span>Disable Home hero block</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHeroBackdrop}
                    onChange={e => setPerfProbeFlag('disableMainstageHeroBackdrop', e.target.checked)}
                  />
                  <span>Disable Hero backdrop/crossfade only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRails}
                    onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                  />
                  <span>Disable Home rows/rails (`AlbumRow` + `SongRail`)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeAlbumRows}
                    onChange={e => setPerfProbeFlag('disableHomeAlbumRows', e.target.checked)}
                  />
                  <span>Disable Home `AlbumRow` sections only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeSongRails}
                    onChange={e => setPerfProbeFlag('disableHomeSongRails', e.target.checked)}
                  />
                  <span>Disable Home `SongRail` sections only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailArtwork}
                    onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Home rows/rails</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeRailArtwork}
                    onChange={e => setPerfProbeFlag('disableHomeRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Home rows/rails only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeArtworkFx}
                    onChange={e => setPerfProbeFlag('disableHomeArtworkFx', e.target.checked)}
                  />
                  <span>Keep artwork, disable Home card visual effects (hover/overlay/shadows)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeArtworkClip}
                    onChange={e => setPerfProbeFlag('disableHomeArtworkClip', e.target.checked)}
                  />
                  <span>Diagnostic: flatten Home artwork clipping (no rounded corners/masks)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailInteractivity}
                    onChange={e => setPerfProbeFlag('disableMainstageRailInteractivity', e.target.checked)}
                  />
                  <span>Disable Home rail scroll/nav handlers</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageGridCards}
                    onChange={e => setPerfProbeFlag('disableMainstageGridCards', e.target.checked)}
                  />
                  <span>Disable Home discover artists chip-grid</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Tracks (`/tracks`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHero}
                    onChange={e => setPerfProbeFlag('disableMainstageHero', e.target.checked)}
                  />
                  <span>Disable Tracks hero block</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRails}
                    onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                  />
                  <span>Disable Tracks rails (Highly Rated + Random)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailArtwork}
                    onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Tracks rails</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailInteractivity}
                    onChange={e => setPerfProbeFlag('disableMainstageRailInteractivity', e.target.checked)}
                  />
                  <span>Disable Tracks rail scroll/nav handlers</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageVirtualLists}
                    onChange={e => setPerfProbeFlag('disableMainstageVirtualLists', e.target.checked)}
                  />
                  <span>Disable Tracks virtual browse list (`VirtualSongList`)</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Albums (`/albums`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageGridCards}
                    onChange={e => setPerfProbeFlag('disableMainstageGridCards', e.target.checked)}
                  />
                  <span>Disable Albums card grid (`AlbumCard` list)</span>
                </label>
              </details>
            </details>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 3 — Active diagnostics (quick access)</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disablePlayerProgressUi}
                  onChange={e => setPerfProbeFlag('disablePlayerProgressUi', e.target.checked)}
                />
                <span>Disable player live progress UI updates (time + seek/progress bindings)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableWaveformCanvas}
                  onChange={e => setPerfProbeFlag('disableWaveformCanvas', e.target.checked)}
                />
                <span>Disable only PlayerBar waveform (`WaveformSeek`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeRailArtwork}
                  onChange={e => setPerfProbeFlag('disableHomeRailArtwork', e.target.checked)}
                />
                <span>Disable artwork inside Home rows/rails only</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageRailArtwork}
                  onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                />
                <span>Disable artwork inside Home rows/rails</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageRails}
                  onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                />
                <span>Disable Home rows/rails (`AlbumRow` + `SongRail`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageHeroBackdrop}
                  onChange={e => setPerfProbeFlag('disableMainstageHeroBackdrop', e.target.checked)}
                />
                <span>Disable Hero backdrop/crossfade only</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeArtworkFx}
                  onChange={e => setPerfProbeFlag('disableHomeArtworkFx', e.target.checked)}
                />
                <span>Keep artwork, disable Home card visual effects (hover/overlay/shadows)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeArtworkClip}
                  onChange={e => setPerfProbeFlag('disableHomeArtworkClip', e.target.checked)}
                />
                <span>Diagnostic: flatten Home artwork clipping (no rounded corners/masks)</span>
              </label>
            </details>
            <div className="sidebar-perf-modal__actions">
              <button type="button" className="btn btn-ghost" onClick={() => resetPerfProbeFlags()}>
                Reset
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setPerfProbeOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
