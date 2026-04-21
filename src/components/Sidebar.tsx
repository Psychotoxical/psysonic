import React, { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { useAuthStore } from '../store/authStore';
import { useSidebarStore } from '../store/sidebarStore';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Settings,
  PanelLeftClose, PanelLeft, AudioLines, HardDriveDownload, HardDriveUpload,
  ChevronDown, Check, Music2, X, ChevronRight, PlayCircle,
} from 'lucide-react';
import PsysonicLogo from './PsysonicLogo';
import PSmallLogo from './PSmallLogo';
import WhatsNewBanner from './WhatsNewBanner';
import { getPlaylists } from '../api/subsonic';
import { usePlaylistStore } from '../store/playlistStore';
import { ALL_NAV_ITEMS } from '../config/navItems';
import OverlayScrollArea from './OverlayScrollArea';


export default function Sidebar({
  isCollapsed = false,
  toggleCollapse,
}: {
  isCollapsed?: boolean;
  toggleCollapse?: () => void;
}) {
  const { t } = useTranslation();
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
  const hasOfflineContent = Object.values(offlineAlbums).some(a => a.serverId === serverId);
  const sidebarItems = useSidebarStore(s => s.items);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
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
  const showLibraryPicker = !isCollapsed && isLoggedIn && musicFolders.length > 1;

  const filterId = serverId ? (musicLibraryFilterByServer[serverId] ?? 'all') : 'all';
  const selectedFolderName =
    filterId === 'all' ? null : musicFolders.find(f => f.id === filterId)?.name ?? null;
  const libraryTriggerPlain = filterId === 'all';

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

  // Resolve ordered, visible items per section from store config
  const visibleLibrary = sidebarItems
    .filter(cfg => {
      if (cfg == null || !cfg.visible || ALL_NAV_ITEMS[cfg.id]?.section !== 'library') return false;
      // Hide mode-inactive mix entries so the active mode controls what's shown
      if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums')) return false;
      if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
      return true;
    })
    .map(cfg => ALL_NAV_ITEMS[cfg.id]);
  const visibleSystem = sidebarItems
    .filter(cfg => cfg != null && cfg.visible && ALL_NAV_ITEMS[cfg.id]?.section === 'system')
    .map(cfg => ALL_NAV_ITEMS[cfg.id]);


  return (
    <aside className={`sidebar animate-slide-in ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        {isCollapsed
          ? <PSmallLogo style={{ height: '32px', width: 'auto' }} />
          : <PsysonicLogo style={{ height: '28px', width: 'auto' }} />
        }
      </div>

      <button
        className="collapse-btn"
        onClick={toggleCollapse}
        data-tooltip={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        data-tooltip-pos="right"
      >
        {isCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
      </button>

      <nav className="sidebar-nav" aria-label="Main navigation">
        <OverlayScrollArea
          className="sidebar-nav-scroll"
          viewportClassName="sidebar-nav-viewport"
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
        {visibleLibrary.map(item => (
          item.to === '/playlists' ? (
            // Playlists item with expand button
            <div key={item.to} className="sidebar-playlists-wrapper">
              <div className="sidebar-playlists-header-row">
                <NavLink
                  to={item.to}
                  className={({ isActive }) => `nav-link sidebar-playlists-main-link ${isActive ? 'active' : ''}`}
                  data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
                  data-tooltip-pos="bottom"
                >
                  <item.icon size={isCollapsed ? 22 : 18} />
                  {!isCollapsed && <span>{t(item.labelKey)}</span>}
                </NavLink>
                {!isCollapsed && (
                  <button
                    className={`sidebar-playlists-toggle ${playlistsExpanded ? 'expanded' : ''}`}
                    onClick={() => setPlaylistsExpanded(!playlistsExpanded)}
                    aria-expanded={playlistsExpanded}
                    aria-label={playlistsExpanded ? t('sidebar.collapsePlaylists') : t('sidebar.expandPlaylists')}
                    data-tooltip={playlistsExpanded ? t('sidebar.collapsePlaylists') : t('sidebar.expandPlaylists')}
                  >
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
              {!isCollapsed && playlistsExpanded && (
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
                        data-tooltip={isCollapsed ? pl.name : undefined}
                        data-tooltip-pos="bottom"
                      >
                        <PlayCircle size={12} />
                        <span>{pl.name}</span>
                      </NavLink>
                    ))
                  )}
                </div>
              )}
            </div>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              data-tooltip={isCollapsed ? t(item.labelKey) : undefined}
              data-tooltip-pos="bottom"
            >
              <item.icon size={isCollapsed ? 22 : 18} />
              {!isCollapsed && <span>{t(item.labelKey)}</span>}
            </NavLink>
          )
        ))}

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

        {visibleSystem.length > 0 && !isCollapsed && <span className="nav-section-label">{t('sidebar.system')}</span>}
        {visibleSystem.map(item => (
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
        ))}
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
  );
}
