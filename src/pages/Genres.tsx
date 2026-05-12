import type { SubsonicGenre } from '../api/subsonicTypes';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tags } from 'lucide-react';
import { getGenres } from '../api/subsonic';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';

const CTP_COLORS = [
  'var(--ctp-rosewater)', 'var(--ctp-flamingo)', 'var(--ctp-pink)', 'var(--ctp-mauve)',
  'var(--ctp-red)', 'var(--ctp-maroon)', 'var(--ctp-peach)', 'var(--ctp-yellow)',
  'var(--ctp-green)', 'var(--ctp-teal)', 'var(--ctp-sky)', 'var(--ctp-sapphire)',
  'var(--ctp-blue)', 'var(--ctp-lavender)',
];

function genreColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CTP_COLORS[h % CTP_COLORS.length];
}

const SCROLL_KEY = 'genres-scroll';
const FONT_MIN_REM = 0.78;
const FONT_MAX_REM = 1.7;

export default function Genres() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rawGenres, setRawGenres] = useState<SubsonicGenre[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGenres()
      .then(data => setRawGenres(data))
      .finally(() => setLoading(false));
  }, []);

  const genres = useMemo(
    () => [...rawGenres].sort((a, b) => b.albumCount - a.albumCount),
    [rawGenres],
  );

  // Log-scale font sizing — flattens the long tail (a 1000-album genre and a
  // 50-album genre look distinct, but a 1-album genre still has a readable size).
  const maxLog = useMemo(() => {
    if (genres.length === 0) return 1;
    return Math.log(Math.max(2, genres[0].albumCount));
  }, [genres]);

  useEffect(() => {
    if (loading || genres.length === 0) return;
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (!saved) return;
    const pos = parseInt(saved, 10);
    sessionStorage.removeItem(SCROLL_KEY);
    requestAnimationFrame(() => {
      const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
      if (el) el.scrollTop = pos;
    });
  }, [loading, genres.length]);

  const handleGenreClick = (genreValue: string) => {
    const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (el) sessionStorage.setItem(SCROLL_KEY, String(el.scrollTop));
    navigate(`/genres/${encodeURIComponent(genreValue)}`);
  };

  return (
    <div className="content-body animate-fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>{t('genres.title')}</h1>
        {!loading && genres.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 500 }}>
            <Tags size={14} style={{ color: 'var(--accent)' }} />
            {genres.length} {t('genres.genreCount')}
          </span>
        )}
      </div>

      {loading && <p className="loading-text">{t('genres.loading')}</p>}
      {!loading && genres.length === 0 && <p className="loading-text">{t('genres.empty')}</p>}

      {!loading && genres.length > 0 && (
        <div className="genre-cloud">
          {genres.map(genre => {
            const ratio = Math.log(Math.max(2, genre.albumCount)) / maxLog;
            const fontRem = FONT_MIN_REM + ratio * (FONT_MAX_REM - FONT_MIN_REM);
            const color = genreColor(genre.value);
            return (
              <button
                key={genre.value}
                type="button"
                className="genre-pill"
                style={{
                  '--genre-color': color,
                  fontSize: `${fontRem.toFixed(3)}rem`,
                } as React.CSSProperties}
                onClick={() => handleGenreClick(genre.value)}
                data-tooltip={t('genres.albumCount', { count: genre.albumCount })}
              >
                {genre.value}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
