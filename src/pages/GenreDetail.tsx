import { getAlbumsByGenre, fetchAllSongsByGenre } from '../api/subsonicGenres';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Disc3, Play, Shuffle, ListPlus, Loader2 } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import AlbumCard from '../components/AlbumCard';
import { songToTrack } from '../utils/playback/songToTrack';
import { runBulkPlayAll, runBulkShuffle, runBulkEnqueue } from '../utils/playback/runBulkPlay';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { albumGridWarmCovers } from '../cover/layoutSizes';
import { VirtualCardGrid } from '../components/VirtualCardGrid';

const PAGE_SIZE = 50;
// Bulk play/shuffle pulls a bounded slice of the genre. The queue resolver
// (queueTrackResolver) holds a 500-entry LRU; seeding a larger queue evicts the
// earliest tracks, which then render as "…"/0:00 placeholders until lazily
// re-resolved. Keep the slice within that budget so the whole queue stays warm.
const GENRE_QUEUE_CAP = 500;

export default function GenreDetail() {
  const { name } = useParams<{ name: string }>();
  const genre = decodeURIComponent(name ?? '');
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [bulkLoading, setBulkLoading] = useState(false);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);

  const fetchGenreTracks = useCallback(
    () => fetchAllSongsByGenre(genre, GENRE_QUEUE_CAP).then(songs => songs.map(songToTrack)),
    [genre],
  );
  const handlePlayAll = useCallback(
    () => runBulkPlayAll({ fetchTracks: fetchGenreTracks, setLoading: setBulkLoading, playTrack }),
    [fetchGenreTracks, playTrack],
  );
  const handleShuffleAll = useCallback(
    () => runBulkShuffle({ fetchTracks: fetchGenreTracks, setLoading: setBulkLoading, playTrack }),
    [fetchGenreTracks, playTrack],
  );
  const handleEnqueueAll = useCallback(
    () => runBulkEnqueue({ fetchTracks: fetchGenreTracks, setLoading: setBulkLoading, enqueue }),
    [fetchGenreTracks, enqueue],
  );

  useEffect(() => {
    setAlbums([]);
    setOffset(0);
    setHasMore(true);
    setLoading(true);
    getAlbumsByGenre(genre, PAGE_SIZE, 0)
      .then(data => {
        setAlbums(data);
        setHasMore(data.length === PAGE_SIZE);
        setOffset(PAGE_SIZE);
      })
      .finally(() => setLoading(false));
  }, [genre]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    getAlbumsByGenre(genre, PAGE_SIZE, offset)
      .then(data => {
        setAlbums(prev => [...prev, ...data]);
        setHasMore(data.length === PAGE_SIZE);
        setOffset(prev => prev + PAGE_SIZE);
      })
      .finally(() => setLoadingMore(false));
  }, [genre, offset, loadingMore, hasMore]);

  return (
    <div className="content-body animate-fade-in">
      <button
        className="btn btn-ghost"
        onClick={() => navigate(-1)}
        style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <ArrowLeft size={16} />
        <span>{t('genres.back')}</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>{genre}</h1>
        {!loading && albums.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 500 }}>
            <Disc3 size={14} style={{ color: 'var(--accent)' }} />
            {t('genres.albumCount', { count: albums.length })}{hasMore ? '+' : ''}
          </span>
        )}
        {!loading && albums.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
            <button className="btn btn-primary" onClick={handlePlayAll} disabled={bulkLoading}>
              {bulkLoading ? <Loader2 size={15} className="spin" /> : <Play size={15} />} {t('common.play')}
            </button>
            <button
              className="btn btn-surface"
              onClick={handleShuffleAll}
              disabled={bulkLoading}
              data-tooltip={t('genres.shuffle')}
            >
              <Shuffle size={16} />
            </button>
            <button
              className="btn btn-surface"
              onClick={handleEnqueueAll}
              disabled={bulkLoading}
              data-tooltip={t('genres.addToQueue')}
            >
              <ListPlus size={16} />
            </button>
          </div>
        )}
      </div>

      {loading && <p className="loading-text">{t('genres.albumsLoading')}</p>}
      {!loading && albums.length === 0 && <p className="loading-text">{t('genres.albumsEmpty')}</p>}

      {albums.length > 0 && (
        <VirtualCardGrid
          items={albums}
          itemKey={(a, _i) => a.id}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={albums.length}
          warmGridCovers={albumGridWarmCovers()}
          renderItem={album => <AlbumCard album={album} />}
        />
      )}

      {hasMore && !loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem 0' }}>
          <button className="btn btn-surface" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? t('common.loadingMore') : t('genres.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
