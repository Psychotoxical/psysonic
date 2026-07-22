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
import {
  deriveEffectiveLibraryBrowseServerIds,
  deriveLibraryBrowseScope,
} from '@/lib/library/libraryBrowseScope';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import {
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
  summarizeMusicFoldersByServer,
} from '@/lib/library/multiServerDebug';

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
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const musicFoldersByServer = useAuthStore(s => s.musicFoldersByServer);
  const libraryBrowseSelectionByServer = useAuthStore(s => s.libraryBrowseSelectionByServer);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const musicLibraryFilterByServer = useAuthStore(s => s.musicLibraryFilterByServer);
  const musicLibrarySelectionByServer = useAuthStore(s => s.musicLibrarySelectionByServer);
  const setLibraryBrowseSelectionForServer = useAuthStore(s => s.setLibraryBrowseSelectionForServer);
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
  const unavailableServerIds = useUnavailableServerIds();
  const effectiveLibraryBrowseServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId: serverId || null,
    libraryBrowseServerIds,
  }, unavailableServerIds), [libraryBrowseServerIds, serverId, servers, unavailableServerIds]);
  const playlistServerScopeKey = effectiveLibraryBrowseServerIds.join('\u0000');
  const libraryGroups = useMemo(() => {
    const selectedServers = new Set(effectiveLibraryBrowseServerIds);
    return servers
      .filter(server => selectedServers.has(server.id))
      .map(server => ({
        serverId: server.id,
        serverLabel: serverListDisplayLabel(server, servers),
        folders: musicFoldersByServer[server.id]
          ?? (server.id === serverId ? musicFolders : []),
        selectedLibraryIds: libraryBrowseSelectionByServer[server.id] ?? EMPTY_LIBRARY_IDS,
      }));
  }, [effectiveLibraryBrowseServerIds, servers, musicFoldersByServer, serverId, musicFolders, libraryBrowseSelectionByServer]);
  const selectableLibraryCount = libraryGroups.reduce((count, group) => count + group.folders.length, 0);
  const showLibraryPicker = !isCollapsed
    && isLoggedIn
    && !isServerOffline
    && (libraryGroups.length > 1 || selectableLibraryCount > 1);

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
  const newReleasesScope = useMemo(() => deriveLibraryBrowseScope({
    servers,
    activeServerId: serverId || null,
    libraryBrowseServerIds,
    musicFoldersByServer,
    libraryBrowseSelectionByServer,
  }, unavailableServerIds), [
    libraryBrowseSelectionByServer,
    libraryBrowseServerIds,
    musicFoldersByServer,
    serverId,
    servers,
    unavailableServerIds,
  ]);
  const newReleasesUnreadCount = useSidebarNewReleasesUnread({
    anchorServerId: newReleasesScope.anchorServerId,
    scopes: newReleasesScope.pairs,
    scopeFingerprint: newReleasesScope.fingerprint,
    isLoggedIn,
    pathname: location.pathname,
  });

  useEffect(() => {
    const visibilityBlockers = [
      ...(isCollapsed ? ['sidebar_collapsed'] : []),
      ...(!isLoggedIn ? ['not_logged_in'] : []),
      ...(isServerOffline ? ['offline_mode'] : []),
      ...(libraryGroups.length <= 1 && selectableLibraryCount <= 1
        ? ['single_group_with_at_most_one_folder']
        : []),
    ];
    emitMultiServerDebug('sidebar_library_snapshot', {
      pathname: location.pathname,
      activeServerId: serverId,
      isCollapsed,
      isLoggedIn,
      isServerOffline,
      configuredServerIds: libraryBrowseServerIds,
      effectiveServerIds: effectiveLibraryBrowseServerIds,
      unavailableServerIds: [...unavailableServerIds],
      libraryBrowseScopeVersion,
      servers: summarizeMultiServerProfiles(servers),
      foldersByServer: summarizeMusicFoldersByServer(musicFoldersByServer),
      activeMusicFolders: musicFolders.map(folder => ({ id: folder.id, name: folder.name })),
      selectionByServer: libraryBrowseSelectionByServer,
      libraryGroups,
      selectableLibraryCount,
      showLibraryPicker,
      visibilityBlockers,
      newReleasesScope,
      newReleasesUnreadCount,
    });
  }, [
    effectiveLibraryBrowseServerIds,
    isCollapsed,
    isLoggedIn,
    isServerOffline,
    libraryBrowseScopeVersion,
    libraryBrowseSelectionByServer,
    libraryBrowseServerIds,
    libraryGroups,
    location.pathname,
    musicFolders,
    musicFoldersByServer,
    newReleasesScope,
    newReleasesUnreadCount,
    selectableLibraryCount,
    serverId,
    servers,
    showLibraryPicker,
    unavailableServerIds,
  ]);
  const { perfProbeOpen, setPerfProbeOpen } = useSidebarPerfProbe();
  const perfFlags = usePerfProbeFlags();




  const onLibrarySelectionChange = (selectedServerId: string, libraryIds: string[]) => {
    if (isServerOffline) {
      emitMultiServerDebug('sidebar_library_selection_skip', {
        selectedServerId,
        libraryIds,
        reason: 'offline_mode',
      });
      return;
    }
    emitMultiServerDebug('sidebar_library_selection_change', {
      selectedServerId,
      previousLibraryIds: libraryBrowseSelectionByServer[selectedServerId] ?? [],
      libraryIds,
    });
    setLibraryBrowseSelectionForServer(selectedServerId, libraryIds);
  };

  useEffect(() => {
    if (isServerOffline) setLibraryDropdownOpen(false);
  }, [isServerOffline, setLibraryDropdownOpen]);

  // Fetch playlists when expanded
  useEffect(() => {
    if (!playlistsExpanded || !isLoggedIn) return;
    fetchPlaylists();
  }, [playlistsExpanded, isLoggedIn, fetchPlaylists, playlistServerScopeKey]);

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
            libraryBrowseScopeVersion,
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
          libraryGroups={libraryGroups}
          libraryDropdownOpen={libraryDropdownOpen}
          setLibraryDropdownOpen={setLibraryDropdownOpen}
          dropdownRect={dropdownRect}
          libraryTriggerRef={libraryTriggerRef}
          onLibrarySelectionChange={onLibrarySelectionChange}
          visibleLibraryConfigs={visibleLibraryConfigs}
          visibleSystemConfigs={visibleSystemConfigs}
          playlistsExpanded={playlistsExpanded}
          setPlaylistsExpanded={setPlaylistsExpanded}
          playlists={playlists}
          playlistsLoading={playlistsLoading}
          multiServerPlaylistScope={effectiveLibraryBrowseServerIds.length > 1}
          playlistFolderServerId={effectiveLibraryBrowseServerIds.length === 1
            ? effectiveLibraryBrowseServerIds[0] ?? null
            : null}
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
