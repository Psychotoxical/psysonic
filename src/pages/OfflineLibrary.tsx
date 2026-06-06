import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { Play, HardDriveDownload, Trash2, ListPlus, ListMusic, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOfflineStore } from '../store/offlineStore';
import { useLocalPlaybackStore } from '../store/localPlaybackStore';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { AlbumCoverArtImage } from '../cover/AlbumCoverArtImage';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import {
  buildOfflineCacheQueueTracks,
  buildOfflineFavoritesQueueTracks,
  buildTracksForOfflineCard,
  collectEphemeralCacheCoverQuad,
  collectFavoriteAutoCoverQuad,
  countEphemeralCacheTracks,
  countFavoriteAutoTracks,
  favoriteAutoCoverScope,
  ensureServerForOfflineCard,
  ensureServerForOfflineIndexKey,
  ephemeralCacheCoverScope,
  offlineQueueServerKeyForCard,
  hydrateOfflineLibraryCards,
  offlineAlbumCoverScope,
  offlineTrackCount,
  type OfflineLibraryCard,
} from '../utils/offline/offlineLibraryHelpers';
import { showToast } from '../utils/ui/toast';
import { shuffleArray } from '../utils/playback/shuffleArray';
import { formatBytes } from '../utils/format/formatBytes';
import { getMediaDir } from '../utils/media/mediaDir';
import { canonicalQueueServerKey, resolveIndexKey } from '../utils/server/serverIndexKey';
import { reconcileAllLibraryTiersFromDisk } from '../utils/offline/libraryTierReconcile';
import {
  inferPinSourcesFromLibraryIndex,
  restoreOfflineLibraryPinSources,
} from '../utils/migrations/legacyOfflineFileMigration';

const OFFLINE_CARD_COVER_CSS_PX = 300;
const OFFLINE_CACHE_GRID_KEY = '__offline_cache__';
const OFFLINE_FAVORITES_GRID_KEY = '__offline_favorites__';

type FilterType = 'all' | 'album' | 'playlist' | 'artist';

type OfflineGridItem =
  | { kind: 'cache' }
  | { kind: 'favorites' }
  | { kind: 'card'; card: OfflineLibraryCard };

export default function OfflineLibrary() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const perfFlags = usePerfProbeFlags();
  const servers = useAuthStore(s => s.servers);
  const mediaDir = useAuthStore(s => s.mediaDir || null);
  const hotCacheEnabled = useAuthStore(s => s.hotCacheEnabled);
  const localPlaybackEntries = useLocalPlaybackStore(s => s.entries);
  const [cacheCoverQuad, setCacheCoverQuad] = useState<(string | null)[]>([
    null, null, null, null,
  ]);
  const [favoritesCoverQuad, setFavoritesCoverQuad] = useState<(string | null)[]>([
    null, null, null, null,
  ]);
  const pinRefreshKey = useLocalPlaybackStore(s => {
    const groups = s.listPinnedGroups();
    return groups
      .map(g => `${g.serverIndexKey}\0${g.pinSource.kind}\0${g.pinSource.sourceId}\0${g.trackIds.join(',')}`)
      .sort()
      .join('\n');
  });
  const deleteAlbum = useOfflineStore(s => s.deleteAlbum);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const [filter, setFilter] = useState<FilterType>('all');
  const [cards, setCards] = useState<OfflineLibraryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [libraryDiskBytes, setLibraryDiskBytes] = useState<number | null>(null);

  const refreshLibraryDiskSize = useCallback(async () => {
    const bytes = await invoke<number>('get_media_tier_size', {
      tier: 'library',
      mediaDir: getMediaDir(),
    }).catch(() => 0);
    setLibraryDiskBytes(bytes);
  }, []);

  const serverNames = useMemo(
    () => Object.fromEntries(servers.map(s => [s.id, s.name])),
    [servers],
  );
  const showServerLabels = servers.length > 1;

  const refreshCardsFromDisk = useCallback(async (): Promise<OfflineLibraryCard[]> => {
    await Promise.all([reconcileAllLibraryTiersFromDisk(), refreshLibraryDiskSize()]);
    restoreOfflineLibraryPinSources();
    await inferPinSourcesFromLibraryIndex();
    const groups = useLocalPlaybackStore.getState().listPinnedGroups();
    const hydrated = await hydrateOfflineLibraryCards(groups);
    return hydrated.filter(card => offlineTrackCount(card) > 0);
  }, [refreshLibraryDiskSize]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refreshCardsFromDisk().then(hydrated => {
      if (cancelled) return;
      setCards(hydrated);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [pinRefreshKey, mediaDir, refreshCardsFromDisk]);

  useEffect(() => {
    const refresh = () => {
      void refreshCardsFromDisk().then(hydrated => setCards(hydrated)).catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refreshCardsFromDisk]);

  const countByType = (type: FilterType) => {
    if (type === 'all') return cards.length;
    return cards.filter(c => (c.pinSource.kind ?? 'album') === type).length;
  };

  const filtered = filter === 'all'
    ? cards
    : cards.filter(c => (c.pinSource.kind ?? 'album') === filter);

  const cacheQueueTrackCount = useMemo(
    () => countEphemeralCacheTracks(),
    [localPlaybackEntries],
  );

  const favoritesTrackCount = useMemo(
    () => countFavoriteAutoTracks(),
    [localPlaybackEntries],
  );

  const showCacheQueueCard = hotCacheEnabled && cacheQueueTrackCount > 0;
  const showFavoritesCard = favoritesTrackCount > 0;

  const cacheCoverScope = useMemo(
    () => ephemeralCacheCoverScope(),
    [localPlaybackEntries],
  );

  const favoritesCoverScope = useMemo(
    () => favoriteAutoCoverScope(),
    [localPlaybackEntries],
  );

  useEffect(() => {
    if (!showCacheQueueCard) {
      setCacheCoverQuad([null, null, null, null]);
      return;
    }
    let cancelled = false;
    void collectEphemeralCacheCoverQuad().then(quad => {
      if (!cancelled) setCacheCoverQuad(quad);
    });
    return () => { cancelled = true; };
  }, [showCacheQueueCard, localPlaybackEntries]);

  useEffect(() => {
    if (!showFavoritesCard) {
      setFavoritesCoverQuad([null, null, null, null]);
      return;
    }
    let cancelled = false;
    void collectFavoriteAutoCoverQuad().then(quad => {
      if (!cancelled) setFavoritesCoverQuad(quad);
    });
    return () => { cancelled = true; };
  }, [showFavoritesCard, localPlaybackEntries]);

  const systemGridItems = useMemo((): OfflineGridItem[] => {
    const out: OfflineGridItem[] = [];
    if (showCacheQueueCard) out.push({ kind: 'cache' });
    if (showFavoritesCard) out.push({ kind: 'favorites' });
    return out;
  }, [showCacheQueueCard, showFavoritesCard]);

  const gridItems = useMemo((): OfflineGridItem[] => {
    return [...systemGridItems, ...filtered.map(card => ({ kind: 'card' as const, card }))];
  }, [filtered, systemGridItems]);

  const runWithCardServer = useCallback(async (
    card: OfflineLibraryCard,
    action: () => void | Promise<void>,
  ) => {
    const ok = await ensureServerForOfflineCard(card);
    if (!ok) {
      showToast(t('connection.switchFailed'), 4500, 'error');
      return;
    }
    await action();
  }, [t]);

  const handlePlay = (card: OfflineLibraryCard) => {
    void runWithCardServer(card, async () => {
      usePlayerStore.setState({ queueServerId: offlineQueueServerKeyForCard(card) });
      const tracks = await buildTracksForOfflineCard(card);
      if (!tracks[0]) {
        showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
        return;
      }
      playTrack(tracks[0], tracks);
    });
  };

  const handlePlayOfflineCache = useCallback(async () => {
    const { tracks, queueServerIndexKey } = await buildOfflineCacheQueueTracks();
    if (!tracks.length) {
      showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
      return;
    }
    if (queueServerIndexKey) {
      const ok = await ensureServerForOfflineIndexKey(queueServerIndexKey);
      if (!ok) {
        showToast(t('connection.switchFailed'), 4500, 'error');
        return;
      }
      usePlayerStore.setState({
        queueServerId: canonicalQueueServerKey(queueServerIndexKey),
      });
    }
    const queue = shuffleArray(tracks);
    playTrack(queue[0], queue);
  }, [playTrack, t]);

  const handlePlayOfflineFavorites = useCallback(async () => {
    const { tracks, queueServerIndexKey } = await buildOfflineFavoritesQueueTracks();
    if (!tracks.length) {
      showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
      return;
    }
    if (queueServerIndexKey) {
      const ok = await ensureServerForOfflineIndexKey(queueServerIndexKey);
      if (!ok) {
        showToast(t('connection.switchFailed'), 4500, 'error');
        return;
      }
      usePlayerStore.setState({
        queueServerId: canonicalQueueServerKey(queueServerIndexKey),
      });
    }
    const queue = shuffleArray(tracks);
    playTrack(queue[0], queue);
  }, [playTrack, t]);

  const handleEnqueueFavorites = useCallback(async () => {
    const { tracks, queueServerIndexKey } = await buildOfflineFavoritesQueueTracks();
    if (!tracks.length) {
      showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
      return;
    }
    if (queueServerIndexKey) {
      const ok = await ensureServerForOfflineIndexKey(queueServerIndexKey);
      if (!ok) {
        showToast(t('connection.switchFailed'), 4500, 'error');
        return;
      }
      usePlayerStore.setState({
        queueServerId: canonicalQueueServerKey(queueServerIndexKey),
      });
    }
    enqueue(tracks);
  }, [enqueue, t]);

  const handleEnqueueCache = useCallback(async () => {
    const { tracks, queueServerIndexKey } = await buildOfflineCacheQueueTracks();
    if (!tracks.length) {
      showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
      return;
    }
    if (queueServerIndexKey) {
      const ok = await ensureServerForOfflineIndexKey(queueServerIndexKey);
      if (!ok) {
        showToast(t('connection.switchFailed'), 4500, 'error');
        return;
      }
      usePlayerStore.setState({
        queueServerId: canonicalQueueServerKey(queueServerIndexKey),
      });
    }
    enqueue(tracks);
  }, [enqueue, t]);

  const handleEnqueue = (card: OfflineLibraryCard) => {
    void runWithCardServer(card, async () => {
      usePlayerStore.setState({ queueServerId: offlineQueueServerKeyForCard(card) });
      const tracks = await buildTracksForOfflineCard(card);
      if (tracks.length === 0) {
        showToast(t('connection.offlinePlaybackUnavailable'), 4500, 'error');
        return;
      }
      enqueue(tracks);
    });
  };

  const renderFavoritesCard = () => {
    const showQuad = favoritesCoverQuad.some(Boolean) && favoritesCoverScope;
    return (
      <div
        className="album-card card offline-library-card offline-library-favorites-card"
        onClick={() => navigate('/favorites')}
      >
        <div className="album-card-cover">
          {showQuad ? (
            <div className="playlist-cover-grid">
              {favoritesCoverQuad.map((coverId, i) => (
                coverId ? (
                  <AlbumCoverArtImage
                    key={`${coverId}-${i}`}
                    albumId={coverId}
                    coverArt={coverId}
                    serverScope={favoritesCoverScope!}
                    libraryResolve
                    displayCssPx={OFFLINE_CARD_COVER_CSS_PX / 2}
                    surface="dense"
                    className="playlist-cover-cell"
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                )
              ))}
            </div>
          ) : (
            <div className="album-card-cover-placeholder playlist-card-icon">
              <Heart size={48} strokeWidth={1.2} />
            </div>
          )}
          <div className="album-card-play-overlay">
            <button
              className="album-card-details-btn"
              onClick={(e) => {
                e.stopPropagation();
                void handlePlayOfflineFavorites();
              }}
              aria-label={t('connection.offlineFavoritesQueuePlayAria')}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </div>
        </div>
        <div className="album-card-info">
          <p className="album-card-title truncate">{t('connection.offlineFavoritesQueueTitle')}</p>
          <p className="album-card-artist truncate">{'\u00A0'}</p>
          <p className="album-card-year offline-library-card-year">{'\u00A0'}</p>
          <div className="offline-library-card-meta">
            <button
              className="offline-library-enqueue"
              onClick={(e) => {
                e.stopPropagation();
                void handleEnqueueFavorites();
              }}
              data-tooltip={t('queue.appendToQueue')}
              data-tooltip-pos="top"
              aria-label={t('queue.appendToQueue')}
            >
              <ListPlus size={12} />
            </button>
            <span className="offline-library-tracks">
              {t('albumDetail.tracksCount', { n: favoritesTrackCount })}
            </span>
            <span className="offline-library-delete offline-library-delete--spacer" aria-hidden />
          </div>
        </div>
      </div>
    );
  };

  const renderCacheQueueCard = () => {
    const showQuad = cacheCoverQuad.some(Boolean) && cacheCoverScope;
    return (
      <div className="album-card card offline-library-card offline-library-cache-card">
        <div className="album-card-cover">
          {showQuad ? (
            <div className="playlist-cover-grid">
              {cacheCoverQuad.map((coverId, i) => (
                coverId ? (
                  <AlbumCoverArtImage
                    key={`${coverId}-${i}`}
                    albumId={coverId}
                    coverArt={coverId}
                    serverScope={cacheCoverScope!}
                    libraryResolve
                    displayCssPx={OFFLINE_CARD_COVER_CSS_PX / 2}
                    surface="dense"
                    className="playlist-cover-cell"
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                )
              ))}
            </div>
          ) : (
            <div className="album-card-cover-placeholder playlist-card-icon">
              <ListMusic size={48} strokeWidth={1.2} />
            </div>
          )}
          <div className="album-card-play-overlay">
            <button
              className="album-card-details-btn"
              onClick={() => void handlePlayOfflineCache()}
              aria-label={t('connection.offlineCacheQueuePlayAria')}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </div>
        </div>
        <div className="album-card-info">
          <p className="album-card-title truncate">{t('connection.offlineCacheQueueTitle')}</p>
          <p className="album-card-artist truncate">{'\u00A0'}</p>
          <p className="album-card-year offline-library-card-year">{'\u00A0'}</p>
          <div className="offline-library-card-meta">
            <button
              className="offline-library-enqueue"
              onClick={() => void handleEnqueueCache()}
              data-tooltip={t('queue.appendToQueue')}
              data-tooltip-pos="top"
              aria-label={t('queue.appendToQueue')}
            >
              <ListPlus size={12} />
            </button>
            <span className="offline-library-tracks">
              {t('albumDetail.tracksCount', { n: cacheQueueTrackCount })}
            </span>
            <span className="offline-library-delete offline-library-delete--spacer" aria-hidden />
          </div>
        </div>
      </div>
    );
  };

  const renderGridItem = (item: OfflineGridItem) => {
    if (item.kind === 'cache') return renderCacheQueueCard();
    if (item.kind === 'favorites') return renderFavoritesCard();
    return renderCard(item.card);
  };

  const renderCard = (card: OfflineLibraryCard) => {
    const coverScope = offlineAlbumCoverScope(card);
    const trackCount = offlineTrackCount(card);
    const serverLabel = serverNames[resolveIndexKey(card.serverIndexKey)] ?? serverNames[card.serverIndexKey];
    const albumId = card.coverArt
      ?? (card.pinSource.kind === 'album'
        ? card.pinSource.sourceId
        : card.pinSource.sourceId);
    const quadCovers = card.pinSource.kind === 'playlist' ? card.coverQuadIds : undefined;
    const showQuad = !!quadCovers?.some(Boolean) && coverScope;
    return (
      <div className="album-card card offline-library-card">
        <div className="album-card-cover">
          {showQuad ? (
            <div className="playlist-cover-grid">
              {quadCovers!.map((coverId, i) => (
                coverId ? (
                  <AlbumCoverArtImage
                    key={`${coverId}-${i}`}
                    albumId={coverId}
                    coverArt={coverId}
                    serverScope={coverScope!}
                    libraryResolve
                    displayCssPx={OFFLINE_CARD_COVER_CSS_PX / 2}
                    surface="dense"
                    className="playlist-cover-cell"
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <div key={i} className="playlist-cover-cell playlist-cover-cell--empty" />
                )
              ))}
            </div>
          ) : coverScope && card.coverArt ? (
            <AlbumCoverArtImage
              albumId={albumId}
              coverArt={card.coverArt}
              serverScope={coverScope}
              libraryResolve
              displayCssPx={OFFLINE_CARD_COVER_CSS_PX}
              surface="dense"
              alt={`${card.name} Cover`}
              loading="lazy"
            />
          ) : (
            <div className="album-card-cover-placeholder">
              <HardDriveDownload size={32} />
            </div>
          )}
          <div className="album-card-play-overlay">
            <button
              className="album-card-details-btn"
              onClick={() => handlePlay(card)}
              aria-label={`${card.name} abspielen`}
            >
              <Play size={15} fill="currentColor" />
            </button>
          </div>
        </div>
        <div className="album-card-info">
          <p className="album-card-title truncate">{card.name}</p>
          {card.artist ? (
            <p className="album-card-artist truncate">{card.artist}</p>
          ) : null}
          {showServerLabels && serverLabel && (
            <p className="offline-library-server truncate" title={serverLabel}>
              {t('connection.offlineCachedOnServer', { server: serverLabel })}
            </p>
          )}
          <p className="album-card-year offline-library-card-year">
            {card.year ?? '\u00A0'}
          </p>
          <div className="offline-library-card-meta">
            <button
              className="offline-library-enqueue"
              onClick={() => handleEnqueue(card)}
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
              onClick={() => deleteAlbum(card.pinSource.sourceId, card.serverIndexKey)}
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

  const renderOfflineGrid = (items: OfflineGridItem[], layoutSignal: number) => (
    <VirtualCardGrid
      items={items}
      itemKey={(item, _i) => {
        if (item.kind === 'cache') return OFFLINE_CACHE_GRID_KEY;
        if (item.kind === 'favorites') return OFFLINE_FAVORITES_GRID_KEY;
        return `${item.card.serverIndexKey}:${item.card.pinSource.kind}:${item.card.pinSource.sourceId}`;
      }}
      rowVariant="offline"
      disableVirtualization={perfFlags.disableMainstageVirtualLists}
      layoutSignal={layoutSignal}
      warmGridCovers={albumGridWarmCovers(OFFLINE_CARD_COVER_CSS_PX)}
      renderItem={renderGridItem}
    />
  );

  const renderArtistGroups = () => {
    const groups: Record<string, OfflineLibraryCard[]> = {};
    for (const card of filtered) {
      const key = card.artist || '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(card);
    }
    const sortedArtists = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    return sortedArtists.map(artistName => (
      <div key={artistName} className="offline-artist-group">
        <h2 className="offline-artist-group-heading">{artistName}</h2>
        {renderOfflineGrid(
          groups[artistName].map(card => ({ kind: 'card', card })),
          groups[artistName].length,
        )}
      </div>
    ));
  };

  const TABS: { id: FilterType; labelKey: string }[] = [
    { id: 'all', labelKey: 'connection.offlineFilterAll' },
    { id: 'album', labelKey: 'connection.offlineFilterAlbums' },
    { id: 'playlist', labelKey: 'connection.offlineFilterPlaylists' },
    { id: 'artist', labelKey: 'connection.offlineFilterArtists' },
  ];

  return (
    <div className="offline-library animate-fade-in">
      <div className="offline-library-header">
        <div className="offline-library-header-main">
          <HardDriveDownload size={24} className="offline-library-header-icon" />
          <div>
            <h1 className="offline-library-title">{t('connection.offlineLibraryTitle')}</h1>
            <p className="offline-library-count">
              {t('connection.offlineAlbumCount', { n: cards.length, count: cards.length })}
            </p>
          </div>
        </div>
        <div className="offline-library-header-stat" aria-live="polite">
          <span className="offline-library-disk-label">{t('connection.offlineLibraryDiskLabel')}</span>
          <span className="offline-library-disk-value">
            {libraryDiskBytes !== null ? formatBytes(libraryDiskBytes) : '…'}
          </span>
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

      {loading ? (
        <div className="empty-state">{t('common.loading', { defaultValue: 'Loading…' })}</div>
      ) : gridItems.length === 0 ? (
        <div className="empty-state">{t('connection.offlineLibraryEmpty')}</div>
      ) : filter === 'artist' ? (
        <>
          {systemGridItems.length > 0 && renderOfflineGrid(systemGridItems, systemGridItems.length)}
          {filtered.length > 0 ? renderArtistGroups() : null}
        </>
      ) : (
        renderOfflineGrid(gridItems, gridItems.length)
      )}
    </div>
  );
}
