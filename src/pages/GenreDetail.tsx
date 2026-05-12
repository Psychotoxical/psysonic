import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Disc3 } from 'lucide-react';
import { getAlbumsByGenre } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import AlbumCard from '../components/AlbumCard';

const PAGE_SIZE = 50;

export default function GenreDetail() {
  const { name } = useParams<{ name: string }>();
  const genre = decodeURIComponent(name ?? '');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

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
      </div>

      {loading && <p className="loading-text">{t('genres.albumsLoading')}</p>}
      {!loading && albums.length === 0 && <p className="loading-text">{t('genres.albumsEmpty')}</p>}

      {albums.length > 0 && (
        <div className="album-grid-wrap">
          {albums.map(album => <AlbumCard key={album.id} album={album} />)}
        </div>
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
