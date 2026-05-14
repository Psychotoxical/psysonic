import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, ChevronRight, HardDriveDownload, PlayCircle, Settings, Sparkles } from 'lucide-react';
import type { SidebarItemConfig } from '../../store/sidebarStore';
import { ALL_NAV_ITEMS } from '../../config/navItems';
import WhatsNewBanner from '../WhatsNewBanner';
import { displayPlaylistName, isSmartPlaylistName } from '../../utils/componentHelpers/sidebarHelpers';
import SidebarLibraryPicker from './SidebarLibraryPicker';
import SidebarActiveJobs from './SidebarActiveJobs';

interface NavDndState {
  section: 'library' | 'system';
  fromIdx: number;
}

interface MusicFolder { id: string; name: string }

interface Props {
  isCollapsed: boolean;
  showLibraryPicker: boolean;
  filterId: string;
  selectedFolderName: string | null;
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: { top: number; left: number; width: number };
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
  musicFolders: MusicFolder[];
  pickLibrary: (id: 'all' | string) => void;
  visibleLibraryConfigs: SidebarItemConfig[];
  libraryItemsForReorder: SidebarItemConfig[];
  visibleSystemConfigs: SidebarItemConfig[];
  systemItemsForReorder: SidebarItemConfig[];
  playlistsExpanded: boolean;
  setPlaylistsExpanded: (v: boolean) => void;
  playlists: { id: string; name: string }[];
  playlistsLoading: boolean;
  newReleasesUnreadCount: number;
  navDnd: NavDndState | null;
  navDndRowClass: (section: 'library' | 'system', sectionIdx: number) => string;
  handleNavRowPointerDown: (e: React.PointerEvent, section: 'library' | 'system', sectionIdx: number) => void;
  isPlaying: boolean;
  hasNowPlayingTrack: boolean;
  hasOfflineContent: boolean;
  activeJobsCount: number;
  cancelAllDownloads: () => void;
  isSyncing: boolean;
  syncJobDone: number;
  syncJobSkip: number;
  syncJobFail: number;
  syncJobTotal: number;
}

export default function SidebarNavBody(props: Props) {
  const {
    isCollapsed, showLibraryPicker, filterId, selectedFolderName,
    libraryDropdownOpen, setLibraryDropdownOpen, dropdownRect, libraryTriggerRef,
    musicFolders, pickLibrary,
    visibleLibraryConfigs, libraryItemsForReorder,
    visibleSystemConfigs, systemItemsForReorder,
    playlistsExpanded, setPlaylistsExpanded, playlists, playlistsLoading,
    newReleasesUnreadCount, navDnd, navDndRowClass, handleNavRowPointerDown,
    isPlaying, hasNowPlayingTrack, hasOfflineContent,
    activeJobsCount, cancelAllDownloads,
    isSyncing, syncJobDone, syncJobSkip, syncJobFail, syncJobTotal,
  } = props;
  const { t } = useTranslation();

  return (
    <>
        {!isCollapsed && (showLibraryPicker ? (
          <SidebarLibraryPicker
            filterId={filterId}
            selectedFolderName={selectedFolderName}
            libraryDropdownOpen={libraryDropdownOpen}
            setLibraryDropdownOpen={setLibraryDropdownOpen}
            dropdownRect={dropdownRect}
            libraryTriggerRef={libraryTriggerRef}
            musicFolders={musicFolders}
            pickLibrary={pickLibrary}
          />
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
            {isPlaying && hasNowPlayingTrack && <span className="nav-np-dot" />}
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

        <SidebarActiveJobs
          isCollapsed={isCollapsed}
          activeJobsCount={activeJobsCount}
          cancelAllDownloads={cancelAllDownloads}
          isSyncing={isSyncing}
          syncJobDone={syncJobDone}
          syncJobSkip={syncJobSkip}
          syncJobFail={syncJobFail}
          syncJobTotal={syncJobTotal}
        />
    </>
  );
}
