import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useOfflineJobStore } from '@/features/offline';
import { clearOfflinePinTasks } from '@/features/offline';
import { useDeviceSyncJobStore } from '@/features/deviceSync';
import { useAuthStore } from '@/store/authStore';
import { useSidebarStore } from '@/features/sidebar/store/sidebarStore';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeft, PanelLeftClose, Trash2 } from 'lucide-react';
import PsysonicLogo from '@/ui/PsysonicLogo';
import PSmallLogo from '@/ui/PSmallLogo';
import { usePlaylistStore } from '@/features/playlist';
import OverlayScrollArea from '@/ui/OverlayScrollArea';
import {
  getLibraryItemsForReorder,
  getSystemItemsForReorder,
} from '@/features/sidebar/utils/sidebarNavReorder';
import { useLuckyMixAvailable } from '@/features/randomMix';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { useSidebarNewReleasesUnread } from '@/features/sidebar/hooks/useSidebarNewReleasesUnread';
import { useSidebarNavDnd } from '@/features/sidebar/hooks/useSidebarNavDnd';
import { useSidebarLibraryDropdown } from '@/features/sidebar/hooks/useSidebarLibraryDropdown';
import { useSidebarScrollVisible } from '@/features/sidebar/hooks/useSidebarScrollVisible';
import { isOfflineSidebarNavAllowed } from '@/features/offline';
import { useReactiveOfflineBrowseContext } from '@/features/sidebar/hooks/useReactiveOfflineBrowseContext';
import { offlineBrowseNavFlags } from '@/features/offline';
import { useSidebarPerfProbe } from '@/features/sidebar/hooks/useSidebarPerfProbe';
import SidebarPerfProbeModal from '@/features/sidebar/components/SidebarPerfProbeModal';
import SidebarNavBody from '@/features/sidebar/components/SidebarNavBody';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { libraryScopeCacheKeyForServer } from '@/lib/api/subsonicClient';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { buildBrowseScopeExcludedSources } from '@/lib/library/libraryBrowseScope';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';

const EMPTY_LIBRARY_IDS: string[] = [];


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
  const pinQueue = useOfflineJobStore(s => s.pinQueue);
  const cancelAllDownloadsStore = useOfflineJobStore(s => s.cancelAllDownloads);
  const activeJobs = offlineJobs.filter(j => j.status === 'queued' || j.status === 'downloading');
  const activePin = pinQueue.find(p => p.status === 'downloading')
    ?? pinQueue.find(p => p.status === 'queued');
  const queuedPinCount = pinQueue.filter(p => p.status === 'queued').length;
  const cancelAllDownloads = () => {
    clearOfflinePinTasks();
    cancelAllDownloadsStore();
  };
  const syncJobStatus = useDeviceSyncJobStore(s => s.status);
  const syncJobDone   = useDeviceSyncJobStore(s => s.done);
  const syncJobSkip   = useDeviceSyncJobStore(s => s.skipped);
  const syncJobFail   = useDeviceSyncJobStore(s => s.failed);
  const syncJobTotal  = useDeviceSyncJobStore(s => s.total);
  const isSyncing     = syncJobStatus === 'running';
  const offlineCtx = useReactiveOfflineBrowseContext();
  const offlineNav = offlineBrowseNavFlags(offlineCtx.capabilities);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const musicFolders = useAuthStore(s => s.musicFolders);
  const servers = useAuthStore(s => s.servers);
  const musicLibraryServerIds = useAuthStore(s => s.musicLibraryServerIds);
  const musicFoldersByServer = useAuthStore(s => s.musicFoldersByServer);
  const musicLibraryFilterByServer = useAuthStore(s => s.musicLibraryFilterByServer);
  const musicLibrarySelectionByServer = useAuthStore(s => s.musicLibrarySelectionByServer);
  const setMusicLibrarySelection = useAuthStore(s => s.setMusicLibrarySelection);
  const setMusicLibraryServerSelected = useAuthStore(s => s.setMusicLibraryServerSelected);
  const setMusicLibrarySelectionForServer = useAuthStore(s => s.setMusicLibrarySelectionForServer);
  const setServers = useAuthStore(s => s.setServers);
  const statusByServer = useLibraryIndexStore(s => s.statusByServer);
  const connectionByServer = useLibraryIndexStore(s => s.connectionByServer);
  const hotCacheEnabled = useAuthStore(s => s.hotCacheEnabled);
  const setHotCacheEnabled = useAuthStore(s => s.setHotCacheEnabled);
  const normalizationEngine = useAuthStore(s => s.normalizationEngine);
  const setNormalizationEngine = useAuthStore(s => s.setNormalizationEngine);
  const loggingMode = useAuthStore(s => s.loggingMode);
  const setLoggingMode = useAuthStore(s => s.setLoggingMode);
  const hasOfflineContent = offlineCtx.capabilities.manualPins;
  const isServerOffline = offlineCtx.active;
  const sidebarItems = useSidebarStore(s => s.items);
  const setSidebarItems = useSidebarStore(s => s.setItems);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const nowPlayingAtTop = useAuthStore(s => s.nowPlayingAtTop);
  const luckyMixBase = useLuckyMixAvailable();
  // Sidebar surfaces Lucky Mix as its own entry only in "separate" nav mode —
  // in hub mode it lives inside the Build-a-Mix landing page instead.
  const luckyMixAvailable = luckyMixBase && randomNavMode === 'separate';
  const { libraryDropdownOpen, setLibraryDropdownOpen, dropdownRect, libraryTriggerRef } =
    useSidebarLibraryDropdown();
  const [playlistsExpanded, setPlaylistsExpanded] = useState(false);
  const playlistsRaw = usePlaylistStore(s => s.playlists);
  const playlistsLoading = usePlaylistStore(s => s.playlistsLoading);
  const fetchPlaylists = usePlaylistStore(s => s.fetchPlaylists);
  // Sort playlists alphabetically by name
  const playlists = useMemo(() => {
    return [...playlistsRaw].sort((a, b) => a.name.localeCompare(b.name));
  }, [playlistsRaw]);
  const [sidebarViewportEl, setSidebarViewportEl] = useState<HTMLDivElement | null>(null);
  const isSidebarScrolling = useSidebarScrollVisible(sidebarViewportEl);
  const showLibraryPicker = !isCollapsed && isLoggedIn && (
    servers.length > 1 || (musicFolders.length > 1 && !isServerOffline)
  );

  const libraryScopeKey = serverId ? libraryScopeCacheKeyForServer(serverId) : 'all';
  const selectedLibraryIds = useMemo(() => {
    if (!serverId) return EMPTY_LIBRARY_IDS;
    const resolved = resolveServerIdForIndexKey(serverId);
    const selection = musicLibrarySelectionByServer[resolved];
    if (selection !== undefined) return selection;
    const legacy = musicLibraryFilterByServer[resolved];
    if (legacy === undefined || legacy === 'all') return EMPTY_LIBRARY_IDS;
    return [legacy];
  }, [serverId, musicLibrarySelectionByServer, musicLibraryFilterByServer]);
  const selectionSummary = useMemo(() => {
    if (selectedLibraryIds.length === 0) return null;
    if (selectedLibraryIds.length === 1) {
      return musicFolders.find(f => f.id === selectedLibraryIds[0])?.name ?? null;
    }
    return t('sidebar.librarySelectionCount', { count: selectedLibraryIds.length });
  }, [selectedLibraryIds, musicFolders, t]);
  const libraryServers = useMemo(() => {
    const excluded = new Map(buildBrowseScopeExcludedSources({
      servers,
      musicLibraryServerIds,
      musicLibrarySelectionByServer,
      musicLibraryFilterByServer,
    }, { statusByServer, connectionByServer }).map(source => [source.serverId, source.reasons]));
    const selectedSet = new Set(musicLibraryServerIds);
    return servers.map(server => {
      const storedSelection = musicLibrarySelectionByServer[server.id];
      const legacy = musicLibraryFilterByServer[server.id];
      const selectedIds = storedSelection !== undefined
        ? storedSelection
        : legacy === undefined || legacy === 'all'
          ? EMPTY_LIBRARY_IDS
          : [legacy];
      const indexKey = serverIndexKeyFromUrl(server.url) || server.id;
      return {
        id: server.id,
        label: serverListDisplayLabel(server, servers),
        selected: selectedSet.has(server.id),
        folders: musicFoldersByServer[server.id]
          ?? (server.id === serverId ? musicFolders : []),
        selectedLibraryIds: selectedIds,
        status: statusByServer[indexKey] ?? null,
        connection: connectionByServer[indexKey] ?? 'unknown',
        excludedReasons: excluded.get(server.id) ?? [],
      };
    });
  }, [
    servers,
    musicLibraryServerIds,
    musicLibrarySelectionByServer,
    musicLibraryFilterByServer,
    musicFoldersByServer,
    musicFolders,
    serverId,
    statusByServer,
    connectionByServer,
  ]);

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
        if (isServerOffline && !isOfflineSidebarNavAllowed(
          c.id,
          offlineNav.favoritesOfflineBrowse,
          offlineNav.localLibraryBrowse,
          offlineNav.playerStatsBrowse,
          offlineNav.playlistsOfflineBrowse,
        )) {
          return false;
        }
        return true;
      }),
    [libraryItemsForReorder, luckyMixAvailable, isServerOffline, offlineNav],
  );
  const visibleSystemConfigs = useMemo(
    () => systemItemsForReorder.filter(c => {
      if (!c.visible) return false;
      if (isServerOffline && !isOfflineSidebarNavAllowed(
        c.id,
        offlineNav.favoritesOfflineBrowse,
        offlineNav.localLibraryBrowse,
        offlineNav.playerStatsBrowse,
        offlineNav.playlistsOfflineBrowse,
      )) {
        return false;
      }
      return true;
    }),
    [systemItemsForReorder, isServerOffline, offlineNav],
  );

  const sidebarItemsRef = useRef(sidebarItems);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  sidebarItemsRef.current = sidebarItems;
  const {
    navDnd,
    navDndTrashHint,
    suppressNavClickRef,
    handleNavRowPointerDown,
    navDndRowClass,
  } = useSidebarNavDnd({
    isCollapsed,
    sidebarItemsRef,
    setSidebarItems,
  });
  const newReleasesUnreadCount = useSidebarNewReleasesUnread({
    serverId,
    libraryScopeKey,
    isLoggedIn,
    pathname: location.pathname,
  });
  const { perfProbeOpen, setPerfProbeOpen } = useSidebarPerfProbe();
  const perfFlags = usePerfProbeFlags();




  const onLibrarySelectionChange = (libraryIds: string[]) => {
    if (isServerOffline) return;
    setMusicLibrarySelection(libraryIds);
  };
  const onLibraryServersReorder = (serverIds: string[]) => {
    const byId = new Map(servers.map(server => [server.id, server]));
    const next = serverIds.flatMap(id => {
      const server = byId.get(id);
      return server ? [server] : [];
    });
    if (next.length === servers.length) setServers(next);
  };

  useEffect(() => {
    if (isServerOffline && servers.length <= 1) setLibraryDropdownOpen(false);
  }, [isServerOffline, servers.length, setLibraryDropdownOpen]);

  // Fetch playlists when expanded
  useEffect(() => {
    if (!playlistsExpanded || !isLoggedIn) return;
    fetchPlaylists();
  }, [playlistsExpanded, isLoggedIn, fetchPlaylists]);

  return (
    <>
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
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
            libraryScopeKey,
            selectedLibraryIds.length,
            hasOfflineContent,
            activeJobs.length,
            isSyncing,
            syncJobTotal,
            sidebarItems.length,
          ]}
        >
        <SidebarNavBody
          isCollapsed={isCollapsed}
          showLibraryPicker={showLibraryPicker}
          selectedLibraryIds={selectedLibraryIds}
          selectionSummary={selectionSummary}
          libraryDropdownOpen={libraryDropdownOpen}
          setLibraryDropdownOpen={setLibraryDropdownOpen}
          dropdownRect={dropdownRect}
          libraryTriggerRef={libraryTriggerRef}
          musicFolders={musicFolders}
          onLibrarySelectionChange={onLibrarySelectionChange}
          libraryServers={libraryServers}
          onLibraryServerSelectionChange={setMusicLibraryServerSelected}
          onServerLibrarySelectionChange={setMusicLibrarySelectionForServer}
          onLibraryServersReorder={onLibraryServersReorder}
          visibleLibraryConfigs={visibleLibraryConfigs}
          visibleSystemConfigs={visibleSystemConfigs}
          playlistsExpanded={playlistsExpanded}
          setPlaylistsExpanded={setPlaylistsExpanded}
          playlists={playlists}
          playlistsLoading={playlistsLoading}
          newReleasesUnreadCount={newReleasesUnreadCount}
          navDnd={navDnd}
          navDndRowClass={navDndRowClass}
          handleNavRowPointerDown={handleNavRowPointerDown}
          isPlaying={isPlaying}
          hasNowPlayingTrack={!!currentTrack}
          nowPlayingAtTop={nowPlayingAtTop}
          hasOfflineContent={hasOfflineContent}
          activeJobsCount={activeJobs.length}
          activePinName={activePin?.albumName ?? null}
          queuedPinCount={queuedPinCount}
          cancelAllDownloads={cancelAllDownloads}
          isSyncing={isSyncing}
          syncJobDone={syncJobDone}
          syncJobSkip={syncJobSkip}
          syncJobFail={syncJobFail}
          syncJobTotal={syncJobTotal}
        />
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
    <SidebarPerfProbeModal
      open={perfProbeOpen}
      onClose={() => setPerfProbeOpen(false)}
      perfFlags={perfFlags}
      hotCacheEnabled={hotCacheEnabled}
      setHotCacheEnabled={setHotCacheEnabled}
      normalizationEngine={normalizationEngine}
      setNormalizationEngine={setNormalizationEngine}
      loggingMode={loggingMode}
      setLoggingMode={setLoggingMode}
    />
    </>
  );
}
