import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Disc3, Users, Music } from 'lucide-react';
import { search, SearchResults, buildCoverArtUrl } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';

function debounce(fn: (q: string) => void, ms: number): (q: string) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (q: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(q), ms);
  };
}

export default function LiveSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const playTrack = usePlayerStore(state => state.playTrack);
  const ref = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(
    debounce(async (q: string) => {
      if (!q.trim()) { setResults(null); setOpen(false); return; }
      setLoading(true);
      try {
        const r = await search(q);
        setResults(r);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 300),
    []
  );

  useEffect(() => { doSearch(query); }, [query, doSearch]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasResults = results && (results.artists.length || results.albums.length || results.songs.length);

  return (
    <div className="live-search" ref={ref} role="search">
      <div className="live-search-input-wrap">
        {loading ? (
          <span className="live-search-icon animate-spin" style={{ opacity: 0.6 }}>
            <div style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          </span>
        ) : (
          <Search size={16} className="live-search-icon" />
        )}
        <input
          id="live-search-input"
          className="input live-search-field"
          type="search"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results && setOpen(true)}
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={open}
          autoComplete="off"
        />
        {query && (
          <button className="live-search-clear" onClick={() => { setQuery(''); setResults(null); setOpen(false); }} aria-label={t('search.clearLabel')}>
            ×
          </button>
        )}
      </div>

      {open && (
        <div className="live-search-dropdown" id="search-results" role="listbox">
          {!hasResults && !loading && (
            <div className="search-empty">{t('search.noResults', { query })}</div>
          )}

          {results?.artists.length ? (
            <div className="search-section">
              <div className="search-section-label"><Users size={12} /> {t('search.artists')}</div>
              {results.artists.map(a => (
                <button
                  key={a.id}
                  className="search-result-item"
                  onClick={() => { navigate(`/artist/${a.id}`); setOpen(false); setQuery(''); }}
                  role="option"
                >
                  <div className="search-result-icon"><Users size={14} /></div>
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
          ) : null}

          {results?.albums.length ? (
            <div className="search-section">
              <div className="search-section-label"><Disc3 size={12} /> {t('search.albums')}</div>
              {results.albums.map(a => (
                <button
                  key={a.id}
                  className="search-result-item"
                  onClick={() => { navigate(`/album/${a.id}`); setOpen(false); setQuery(''); }}
                  role="option"
                >
                  {a.coverArt ? (
                    <img className="search-result-thumb" src={buildCoverArtUrl(a.coverArt, 40)} alt="" loading="lazy" />
                  ) : (
                    <div className="search-result-icon"><Disc3 size={14} /></div>
                  )}
                  <div>
                    <div className="search-result-name">{a.name}</div>
                    <div className="search-result-sub">{a.artist}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : null}

          {results?.songs.length ? (
            <div className="search-section">
              <div className="search-section-label"><Music size={12} /> {t('search.songs')}</div>
              {results.songs.map(s => (
                <button
                  key={s.id}
                  className="search-result-item"
                  onClick={() => {
                    playTrack({
                      id: s.id, title: s.title, artist: s.artist, album: s.album,
                      albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt,
                      year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating
                    });
                    setOpen(false); setQuery('');
                  }}
                  role="option"
                >
                  <div className="search-result-icon"><Music size={14} /></div>
                  <div>
                    <div className="search-result-name">{s.title}</div>
                    <div className="search-result-sub">{s.artist} · {s.album}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
