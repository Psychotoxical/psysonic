import React, { useCallback, useMemo, useState } from 'react';
import { Play, HardDriveDownload, Trash2, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOfflineStore, type OfflineAlbumMeta } from '../store/offlineStore';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from '../components/CachedImage';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import {
  buildOfflineTracksForAlbum,
  ensureServerForOfflineAlbum,
  offlineAlbumCoverArt,
  offlineTrackCount,
} from '../utils/offline/offlineLibraryHelpers';
import { showToast } from '../utils/ui/toast';

type FilterType = 'all' | 'album' | 'playlist' | 'artist';

export default function OfflineLibrary() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const servers = useAuthStore(s => s.servers);
  const serverNames = useMemo(
    () => Object.fromEntries(servers.map(s => [s.id, s.name])),
    [servers],
  );
  const showServerLabels = servers.length > 1;
  const offlineAlbums = useOfflineStore(s => s.albums);
  const offlineTracks = useOfflineStore(s => s.tracks);
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const [filter, setFilter] = useState<FilterType>('all');

  const albums = useMemo(
    () => Object.values(offlineAlbums).sort((a, b) => a.name.localeCompare(b.name)),
    [offlineAlbums],
  );

  const countByType = (type: FilterType) => {
    if (type === 'all') return albums.length;
    return albums.filter(a => (a.type ?? 'album') === type).length;
  };

  const filtered = filter === 'all'
    ? albums
    : albums.filter(a => (a.type ?? 'album') === filter);

  const runWithAlbumServer = useCallback(async (
    album: OfflineAlbumMeta,
    action: () => void,
  ) => {
    const ok = await ensureServerForOfflineAlbum(album);
    if (!ok) {
      showToast(t('connection.switchFailed'), 4500, 'error');
      return;
    }
    action();
  }, [t]);

  const handlePlay = (album: OfflineAlbumMeta) => {
    void runWithAlbumServer(album, () => {
      const tracks = buildOfflineTracksForAlbum(album, offlineTracks);
      if (tracks[0]) playTrack(tracks[0], tracks);
    });
  };

  const handleEnqueue = (album: OfflineAlbumMeta) => {
    void runWithAlbumServer(album, () => {
      enqueue(buildOfflineTracksForAlbum(album, offlineTracks));
    });
  };

  const renderCard = (album: OfflineAlbumMeta) => {
    const { src: coverUrl, cacheKey } = offlineAlbumCoverArt(album, 300);
    const trackCount = offlineTrackCount(album, offlineTracks);
    const serverLabel = serverNames[album.serverId];
    return (
      <div className="album-card card offline-library-card">
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
              onClick={() => handlePlay(album)}
              aria-label={`${album.name} abspielen`}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </div>
        </div>
        <div className="album-card-info">
          <p className="album-card-title truncate">{album.name}</p>
          <p className="album-card-artist truncate">{album.artist}</p>
          {showServerLabels && serverLabel && (
            <p className="offline-library-server truncate" title={serverLabel}>
              {t('connection.offlineCachedOnServer', { server: serverLabel })}
            </p>
          )}
          {album.year && <p className="album-card-year">{album.year}</p>}
          <div className="offline-library-card-meta">
            <button
              className="offline-library-enqueue"
              onClick={() => handleEnqueue(album)}
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
              onClick={() => deleteAlbum(album.id, album.serverId)}
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

  const renderArtistGroups = () => {
    const groups: Record<string, OfflineAlbumMeta[]> = {};
    for (const album of filtered) {
      const key = album.artist || '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(album);
    }
    const sortedArtists = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    return sortedArtists.map(artistName => (
      <div key={artistName} className="offline-artist-group">
        <h2 className="offline-artist-group-heading">{artistName}</h2>
        <VirtualCardGrid
          items={groups[artistName]}
          itemKey={(a, _i) => `${a.serverId}:${a.id}`}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={groups[artistName].length}
          renderItem={renderCard}
        />
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
        <VirtualCardGrid
          items={filtered}
          itemKey={(a, _i) => `${a.serverId}:${a.id}`}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={filtered.length}
          renderItem={renderCard}
        />
      )}
    </div>
  );
}
