import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { useAuthStore } from '../store/authStore';
import { useSidebarStore } from '../store/sidebarStore';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PanelLeft, PanelLeftClose, Trash2 } from 'lucide-react';
import PsysonicLogo from './PsysonicLogo';
import PSmallLogo from './PSmallLogo';
import { usePlaylistStore } from '../store/playlistStore';
import OverlayScrollArea from './OverlayScrollArea';
import {
  getLibraryItemsForReorder,
  getSystemItemsForReorder,
} from '../utils/componentHelpers/sidebarNavReorder';
import { useLuckyMixAvailable } from '../hooks/useLuckyMixAvailable';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { useSidebarNewReleasesUnread } from '../hooks/useSidebarNewReleasesUnread';
import { useSidebarNavDnd } from '../hooks/useSidebarNavDnd';
import { useSidebarLibraryDropdown } from '../hooks/useSidebarLibraryDropdown';
import { useSidebarScrollVisible } from '../hooks/useSidebarScrollVisible';
import { useSidebarPerfProbe } from '../hooks/useSidebarPerfProbe';
import SidebarPerfProbeModal from './sidebar/SidebarPerfProbeModal';
import SidebarNavBody from './sidebar/SidebarNavBody';


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
  const showLibraryPicker = !isCollapsed && isLoggedIn && musicFolders.length > 1;

  const filterId = serverId ? (musicLibraryFilterByServer[serverId] ?? 'all') : 'all';
  const selectedFolderName =
    filterId === 'all' ? null : musicFolders.find(f => f.id === filterId)?.name ?? null;

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

  const sidebarItemsRef = useRef(sidebarItems);
  sidebarItemsRef.current = sidebarItems;
  const randomNavModeRef = useRef(randomNavMode);
  randomNavModeRef.current = randomNavMode;

  const {
    navDnd,
    navDndTrashHint,
    suppressNavClickRef,
    handleNavRowPointerDown,
    navDndRowClass,
  } = useSidebarNavDnd({
    isCollapsed,
    sidebarItemsRef,
    randomNavModeRef,
    setSidebarItems,
  });
  const newReleasesUnreadCount = useSidebarNewReleasesUnread({
    serverId,
    filterId,
    isLoggedIn,
    pathname: location.pathname,
  });
  const { perfProbeOpen, setPerfProbeOpen, perfCpu, perfDiagRates } = useSidebarPerfProbe();
  const perfFlags = usePerfProbeFlags();




  const pickLibrary = (id: 'all' | string) => {
    setMusicLibraryFilter(id);
    setLibraryDropdownOpen(false);
  };

  // Fetch playlists when expanded
  useEffect(() => {
    if (!playlistsExpanded || !isLoggedIn) return;
    fetchPlaylists();
  }, [playlistsExpanded, isLoggedIn, fetchPlaylists]);

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
        <SidebarNavBody
          isCollapsed={isCollapsed}
          showLibraryPicker={showLibraryPicker}
          filterId={filterId}
          selectedFolderName={selectedFolderName}
          libraryDropdownOpen={libraryDropdownOpen}
          setLibraryDropdownOpen={setLibraryDropdownOpen}
          dropdownRect={dropdownRect}
          libraryTriggerRef={libraryTriggerRef}
          musicFolders={musicFolders}
          pickLibrary={pickLibrary}
          visibleLibraryConfigs={visibleLibraryConfigs}
          libraryItemsForReorder={libraryItemsForReorder}
          visibleSystemConfigs={visibleSystemConfigs}
          systemItemsForReorder={systemItemsForReorder}
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
          hasOfflineContent={hasOfflineContent}
          activeJobsCount={activeJobs.length}
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
      perfCpu={perfCpu}
      perfDiagRates={perfDiagRates}
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
