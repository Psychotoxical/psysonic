import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import AlbumCard from '../components/AlbumCard';
import { search } from '../api/subsonic';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';

export default function LabelAlbums() {
  const { t } = useTranslation();
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  useEffect(() => {
    if (!name) return;
    setLoading(true);

    // Search for the label name and ask for a large number of albums
    search(name, { albumCount: 200, artistCount: 0, songCount: 0 })
      .then(res => {
        // Filter out albums that don't match the record label exactly if possible,
        // to avoid unrelated search hits. We do case-insensitive comparison.
        const matches = res.albums.filter(a =>
          a.recordLabel?.toLowerCase() === name.toLowerCase()
        );
        // Fallback: if Navidrome's search doesn't return the exact label in the recordLabel field
        // (or it's not indexed exactly as typed), just show all album matches
        // as a decent best-effort if our strict filter yields nothing.
        setAlbums(matches.length > 0 ? matches : res.albums);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [name, musicLibraryFilterVersion]);

  return (
    <div className="animate-fade-in" style={{ padding: '0 var(--space-6)' }}>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ margin: '1rem 0', gap: '6px' }}>
        <ChevronLeft size={16} /> {t('common.back')}
      </button>

      <h1 className="page-title" style={{ marginBottom: '2rem' }}>
        Label: <span style={{ color: 'var(--accent)' }}>{name}</span>
      </h1>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : albums.length === 0 ? (
        <div className="empty-state">{t('common.noAlbums')}</div>
      ) : (
        <div className="album-grid-wrap">
          {albums.map(a => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      )}
    </div>
  );
}
