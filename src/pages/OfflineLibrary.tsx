import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import React, { useState } from 'react';
import { Play, HardDriveDownload, Trash2, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOfflineStore } from '../store/offlineStore';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from '../components/CachedImage';

type FilterType = 'all' | 'album' | 'playlist' | 'artist';

export default function OfflineLibrary() {
  const { t } = useTranslation();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const offlineAlbums = useOfflineStore(s => s.albums);
  const offlineTracks = useOfflineStore(s => s.tracks);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const [filter, setFilter] = useState<FilterType>('all');

  const albums = Object.values(offlineAlbums).filter(a => a.serverId === serverId);

  const countByType = (type: FilterType) => {
    if (type === 'all') return albums.length;
    return albums.filter(a => (a.type ?? 'album') === type).length;
  };

  const filtered = filter === 'all'
    ? albums
    : albums.filter(a => (a.type ?? 'album') === filter);

  const buildTracks = (albumId: string) => {
    const meta = offlineAlbums[`${serverId}:${albumId}`];
    if (!meta) return [];
    return meta.trackIds.flatMap(tid => {
      const t = offlineTracks[`${serverId}:${tid}`];
      if (!t) return [];
      return [{
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        albumId: t.albumId, artistId: t.artistId, duration: t.duration,
        coverArt: t.coverArt, track: undefined, year: t.year,
        bitRate: t.bitRate, suffix: t.suffix, genre: t.genre,
        replayGainTrackDb: t.replayGainTrackDb,
        replayGainAlbumDb: t.replayGainAlbumDb,
        replayGainPeak: t.replayGainPeak,
      }];
    });
  };

  const handlePlay = (albumId: string) => {
    const tracks = buildTracks(albumId);
    if (tracks[0]) playTrack(tracks[0], tracks);
  };

  const handleEnqueue = (albumId: string) => {
    enqueue(buildTracks(albumId));
  };

  const renderCard = (album: typeof albums[0]) => {
    const coverUrl = album.coverArt ? buildCoverArtUrl(album.coverArt, 300) : '';
    const cacheKey = album.coverArt ? coverArtCacheKey(album.coverArt, 300) : '';
    const trackCount = album.trackIds.filter(tid => !!offlineTracks[`${serverId}:${tid}`]).length;
    return (
      <div key={`${album.serverId}:${album.id}`} className="album-card card offline-library-card">
        <div className="album-card-cover">
          {coverUrl ? (
            <CachedImage src={coverUrl} cacheKey={cacheKey} alt={`${album.name} Cover`} loading="lazy" />
          ) : (
            <div className="album-card-cover-placeholder">
              <HardDriveDownload size={32} />
            </div>
          )}
          <div className="album-card-play-overlay">
            <button
              className="album-card-details-btn"
              onClick={() => handlePlay(album.id)}
              aria-label={`${album.name} abspielen`}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </div>
        </div>
        <div className="album-card-info">
          <p className="album-card-title truncate">{album.name}</p>
          <p className="album-card-artist truncate">{album.artist}</p>
          {album.year && <p className="album-card-year">{album.year}</p>}
          <div className="offline-library-card-meta">
            <button
              className="offline-library-enqueue"
              onClick={() => handleEnqueue(album.id)}
              data-tooltip={t('queue.appendToQueue')}
              data-tooltip-pos="top"
              aria-label={t('queue.appendToQueue')}
            >
              <ListPlus size={12} />
            </button>
            <span className="offline-library-tracks">
              {t('albumDetail.tracksCount', { n: trackCount })}
            </span>
            <button
              className="offline-library-delete"
              onClick={() => deleteAlbum(album.id, serverId)}
              data-tooltip={t('albumDetail.removeOffline')}
              data-tooltip-pos="top"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      </div>
    );
  };

  // For artist filter: group by artist name
  const renderArtistGroups = () => {
    const groups: Record<string, typeof albums> = {};
    for (const album of filtered) {
      const key = album.artist || '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(album);
    }
    const sortedArtists = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    return sortedArtists.map(artistName => (
      <div key={artistName} className="offline-artist-group">
        <h2 className="offline-artist-group-heading">{artistName}</h2>
        <div className="album-grid-wrap">
          {groups[artistName].map(renderCard)}
        </div>
      </div>
    ));
  };

  const TABS: { id: FilterType; labelKey: string }[] = [
    { id: 'all',      labelKey: 'connection.offlineFilterAll' },
    { id: 'album',    labelKey: 'connection.offlineFilterAlbums' },
    { id: 'playlist', labelKey: 'connection.offlineFilterPlaylists' },
    { id: 'artist',   labelKey: 'connection.offlineFilterArtists' },
  ];

  return (
    <div className="offline-library animate-fade-in">
      <div className="offline-library-header">
        <HardDriveDownload size={24} />
        <div>
          <h1 className="offline-library-title">{t('connection.offlineLibraryTitle')}</h1>
          <p className="offline-library-count">
            {t('connection.offlineAlbumCount', { n: albums.length, count: albums.length })}
          </p>
        </div>
      </div>

      <div className="offline-filter-tabs">
        {TABS.map(tab => {
          const count = countByType(tab.id);
          if (tab.id !== 'all' && count === 0) return null;
          return (
            <button
              key={tab.id}
              className={`offline-filter-tab${filter === tab.id ? ' active' : ''}`}
              onClick={() => setFilter(tab.id)}
            >
              {t(tab.labelKey)}
              <span className="offline-filter-tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">{t('connection.offlineLibraryEmpty')}</div>
      ) : filter === 'artist' ? (
        renderArtistGroups()
      ) : (
        <div className="album-grid-wrap">
          {filtered.map(renderCard)}
        </div>
      )}
    </div>
  );
}
