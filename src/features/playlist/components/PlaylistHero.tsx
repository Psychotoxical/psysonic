import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Camera, ChevronLeft, Download, FileUp, Globe, HardDriveDownload, ListPlus,
  Loader2, Lock, Pencil, Play, Search, Shuffle, Sparkles, Trash2,
} from 'lucide-react';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import type { ZipDownload } from '@/features/offline';
import type { AlbumOfflineStatus } from '@/features/album';
import { dequeueOfflinePin } from '@/features/offline';
import { useThemeStore } from '@/store/themeStore';
import { usePlaylistLayoutStore, type PlaylistLayoutItemId } from '@/features/playlist/store/playlistLayoutStore';
import {
  displayPlaylistName, formatSize, isSmartPlaylistName, totalDurationLabel,
} from '@/lib/format/playlistDetailHelpers';
import type { CoverArtId } from '@/cover/types';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';
import { PLAYLIST_MAIN_COVER_CSS_PX } from '@/features/playlist/hooks/usePlaylistCovers';
import { PlaylistSmartCoverCell } from '@/features/playlist/components/PlaylistCoverImages';
import type { OfflineActionPolicy } from '@/features/offline';

interface Props {
  playlist: SubsonicPlaylist;
  songs: SubsonicSong[];
  id: string | undefined;
  customCoverId: string | null;
  coverQuadIds: (CoverArtId | null)[];
  resolvedBgUrl: string | null;
  saving: boolean;
  searchOpen: boolean;
  csvImporting: boolean;
  activeZip: ZipDownload | undefined;
  offlineStatus: AlbumOfflineStatus;
  offlineProgress: { done: number; total: number } | null;
  activeServerId: string;
  actionPolicy: OfflineActionPolicy;
  setEditingMeta: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchResults: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  setSelectedSearchIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSearchPlPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handlePlayAll: () => void;
  handleShuffleAll: () => void;
  handleEnqueueAll: () => void;
  handleImportCsv: () => void;
  handleDownload: () => void;
  deleteAlbum: (id: string, serverId: string) => void;
  downloadPlaylist: (id: string, name: string, coverArt: string | undefined, songs: SubsonicSong[], serverId: string) => void;
}

export default function PlaylistHero({
  playlist, songs, id,
  customCoverId, coverQuadIds,
  resolvedBgUrl, saving, searchOpen, csvImporting, activeZip,
  offlineStatus, offlineProgress, activeServerId, actionPolicy,
  setEditingMeta, setSearchOpen, setSearchQuery, setSearchResults,
  setSelectedSearchIds, setSearchPlPickerOpen,
  handlePlayAll, handleShuffleAll, handleEnqueueAll, handleImportCsv, handleDownload,
  deleteAlbum, downloadPlaylist,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const enableCoverArtBackground = useThemeStore(s => s.enableCoverArtBackground);
  const enablePlaylistCoverPhoto = useThemeStore(s => s.enablePlaylistCoverPhoto);
  const layoutItems = usePlaylistLayoutStore(s => s.items);
  const isLayoutVisible = (id: PlaylistLayoutItemId) =>
    layoutItems.find(i => i.id === id)?.visible !== false;

  return (
    <div className="album-detail-header">
      {resolvedBgUrl && enableCoverArtBackground && (
        <>
          <div className="album-detail-bg" style={{ backgroundImage: `url(${resolvedBgUrl})` }} aria-hidden="true" />
          <div className="album-detail-overlay" aria-hidden="true" />
        </>
      )}

      <div className="album-detail-content">
        <button className="btn btn-ghost album-detail-back" onClick={() => navigate('/playlists')}>
          <ChevronLeft size={16} /> {t('playlists.title')}
        </button>

        <div className="album-detail-hero">
          {/* Cover — click to open edit modal */}
          {enablePlaylistCoverPhoto && (
            <div
              className="playlist-hero-cover"
              onClick={() => { if (actionPolicy.canEditPlaylist) setEditingMeta(true); }}
            >
              {customCoverId ? (
                <AlbumCoverArtImage
                  albumId={customCoverId}
                  coverArt={customCoverId}
                  displayCssPx={PLAYLIST_MAIN_COVER_CSS_PX}
                  surface="dense"
                  alt=""
                  className="playlist-cover-grid"
                  style={{ objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div className="playlist-cover-grid">
                  {coverQuadIds.map((coverId, i) =>
                    coverId
                      ? <PlaylistSmartCoverCell key={i} coverId={coverId} />
                      : <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                  )}
                </div>
              )}
              <div className="playlist-hero-cover-overlay">
                <Camera size={28} />
              </div>
            </div>
          )}

          <div className="album-detail-meta">
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 className="album-detail-title" style={{ marginBottom: 0, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {isSmartPlaylistName(playlist.name) && <Sparkles size={16} style={{ color: 'var(--text-muted)' }} />}
                  <span>{displayPlaylistName(playlist.name)}</span>
                </h1>
                {actionPolicy.canEditPlaylist && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setEditingMeta(true)}
                    data-tooltip={t('playlists.editMeta')}
                    style={{ padding: '4px 6px', opacity: 0.7, flexShrink: 0 }}
                  >
                    <Pencil size={14} />
                  </button>
                )}
              </div>
              {playlist.comment && (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{playlist.comment}</div>
              )}
            </>
            <div className="album-detail-info">
              <span>{t('playlists.songs', { count: songs.length })}</span>
              {songs.length > 0 && <span>· {totalDurationLabel(songs)}</span>}
              {playlist.public !== undefined && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  · {playlist.public
                    ? <><Globe size={11} /> {t('playlists.publicLabel')}</>
                    : <><Lock size={11} /> {t('playlists.privateLabel')}</>}
                </span>
              )}
              {saving && <Loader2 size={12} className="spin-slow" style={{ display: 'inline', marginLeft: 4 }} />}
            </div>
            <div className="album-detail-actions compact-action-bar">
              <div className="album-detail-actions-primary">
                <button
                  className="btn btn-primary"
                  disabled={songs.length === 0}
                  onClick={handlePlayAll}
                  aria-label={t('playlists.playTooltip')}
                  data-tooltip={t('playlists.playTooltip')}
                >
                  <Play size={15} /> <span className="compact-btn-label">{t('common.play', 'Reproducir')}</span>
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={songs.length === 0}
                  onClick={handleShuffleAll}
                  data-tooltip={t('playlists.shuffle', 'Shuffle')}
                >
                  <Shuffle size={16} />
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={songs.length === 0}
                  onClick={handleEnqueueAll}
                  data-tooltip={t('playlists.addToQueue')}
                >
                  <ListPlus size={16} />
                </button>
              </div>
              {actionPolicy.canEditPlaylist && isLayoutVisible('addSongs') && (
                <button
                  className={`btn btn-ghost ${searchOpen ? 'active' : ''}`}
                  onClick={() => { setSearchOpen(v => !v); setSearchQuery(''); setSearchResults([]); setSelectedSearchIds(new Set()); setSearchPlPickerOpen(false); }}
                  aria-label={t('playlists.addSongsTooltip')}
                  data-tooltip={t('playlists.addSongsTooltip')}
                >
                  <Search size={16} /> <span className="compact-btn-label">{t('playlists.addSongs')}</span>
                </button>
              )}
              {actionPolicy.canEditPlaylist && isLayoutVisible('importCsv') && (
                <button
                  className="btn btn-ghost"
                  onClick={handleImportCsv}
                  disabled={csvImporting}
                  aria-label={t('playlists.importCSVTooltip')}
                  data-tooltip={t('playlists.importCSVTooltip')}
                >
                  {csvImporting ? <Loader2 size={16} className="spin-slow" /> : <FileUp size={16} />}
                  <span className="compact-btn-label">{t('playlists.importCSV')}</span>
                </button>
              )}
              {actionPolicy.canDownload && isLayoutVisible('downloadZip') && songs.length > 0 && (
                activeZip && !activeZip.done && !activeZip.error ? (
                  <div className="download-progress-wrap">
                    <Download size={14} />
                    <div className="download-progress-bar">
                      <div className="download-progress-fill" style={{ width: `${activeZip.total ? Math.round((activeZip.bytes / activeZip.total) * 100) : 0}%` }} />
                    </div>
                    <span className="download-progress-pct">{activeZip.total ? Math.round((activeZip.bytes / activeZip.total) * 100) : '…'}%</span>
                  </div>
                ) : (
                  <button className="btn btn-ghost" onClick={handleDownload} aria-label={t('playlists.downloadZip')} data-tooltip={t('playlists.downloadZip')}>
                    <Download size={16} /> <span className="compact-btn-label">{t('playlists.downloadZip')}{songs.reduce((acc, s) => acc + (s.size ?? 0), 0) > 0 ? ` · ${formatSize(songs.reduce((acc, s) => acc + (s.size ?? 0), 0))}` : ''}</span>
                  </button>
                )
              )}
              {actionPolicy.canPinOffline && isLayoutVisible('offlineCache') && songs.length > 0 && id
                && (!isSmartPlaylistName(playlist.name) || offlineStatus !== 'none') && (
                <button
                  className={`btn btn-ghost${offlineStatus === 'cached' ? ' btn-danger' : ''}${offlineStatus === 'queued' ? ' offline-cache-btn--queued' : ''}`}
                  disabled={offlineStatus === 'downloading'}
                  onClick={() => {
                    if (offlineStatus === 'cached') {
                      deleteAlbum(id, activeServerId);
                    } else if (offlineStatus === 'queued') {
                      dequeueOfflinePin(id);
                    } else if (playlist) {
                      downloadPlaylist(id, playlist.name, playlist.coverArt, songs, activeServerId);
                    }
                  }}
                  data-tooltip={offlineStatus === 'downloading'
                    ? t('albumDetail.offlineDownloading', { n: offlineProgress?.done ?? 0, total: offlineProgress?.total ?? 0 })
                    : offlineStatus === 'queued'
                      ? t('albumDetail.removeFromOfflineQueue')
                      : offlineStatus === 'cached'
                        ? t('playlists.removeOffline')
                        : t('playlists.cacheOffline')}
                >
                  {offlineStatus === 'downloading' ? (
                    <>
                      <div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'currentColor' }} />
                      <span className="compact-btn-label">{t('albumDetail.offlineDownloading', { n: offlineProgress?.done ?? 0, total: offlineProgress?.total ?? 0 })}</span>
                    </>
                  ) : offlineStatus === 'queued' ? (
                    <>
                      <HardDriveDownload size={16} />
                      <span className="compact-btn-label">{t('albumDetail.offlineQueued')}</span>
                    </>
                  ) : offlineStatus === 'cached' ? (
                    <>
                      <Trash2 size={16} />
                      <span className="compact-btn-label">{t('playlists.removeOffline')}</span>
                    </>
                  ) : (
                    <>
                      <HardDriveDownload size={16} />
                      <span className="compact-btn-label">{t('playlists.cacheOffline')}</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
