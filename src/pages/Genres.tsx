import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Headphones, Zap, Music2, Music, Cpu, Mic, Radio, Cloud,
  Leaf, Heart, Sun, Flame, Film, Globe, BookOpen, Podcast, Star,
  Tags, type LucideIcon,
} from 'lucide-react';
import { getGenres, SubsonicGenre } from '../api/subsonic';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';

function getGenreIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/ambient|drone|new age/.test(n)) return Cloud;
  if (/metal|hardcore|thrash|death|grind|doom/.test(n)) return Zap;
  if (/rock/.test(n)) return Radio;
  if (/jazz/.test(n)) return Music2;
  if (/classical|orchestra|chamber|baroque|opera|symphon/.test(n)) return Music;
  if (/electronic|techno|edm|house|trance|electro|synth/.test(n)) return Cpu;
  if (/hip.?hop|rap/.test(n)) return Mic;
  if (/pop/.test(n)) return Star;
  if (/folk|country|bluegrass|americana/.test(n)) return Leaf;
  if (/blues/.test(n)) return Music2;
  if (/soul|r.?b|funk|gospel/.test(n)) return Heart;
  if (/reggae|ska|dub/.test(n)) return Sun;
  if (/punk/.test(n)) return Flame;
  if (/soundtrack|score|ost|film|movie|cinema/.test(n)) return Film;
  if (/world|latin|afro|celtic|tribal|traditional/.test(n)) return Globe;
  if (/audiobook|spoken|hörbuch|speech|comedy/.test(n)) return BookOpen;
  if (/podcast/.test(n)) return Podcast;
  return Headphones;
}

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
const VISIBLE_KEY = 'genres-visible';
const PAGE_SIZE = 60;

export default function Genres() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rawGenres, setRawGenres] = useState<SubsonicGenre[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(() => {
    // Restore the previous visibleCount when navigating back from a detail
    // page so scroll position lines up with rendered cards.
    const saved = sessionStorage.getItem(VISIBLE_KEY);
    return saved ? Math.max(PAGE_SIZE, parseInt(saved, 10)) : PAGE_SIZE;
  });
  const observerTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getGenres()
      .then(data => setRawGenres(data))
      .finally(() => setLoading(false));
  }, []); // getGenres is not folder-scoped — no dep on musicLibraryFilterVersion

  // Memoised sort — without this the page re-sorted 500+ entries on every
  // unrelated re-render (e.g. theme change, sidebar toggle).
  const genres = useMemo(
    () => [...rawGenres].sort((a, b) => b.albumCount - a.albumCount),
    [rawGenres],
  );

  const visible = useMemo(() => genres.slice(0, visibleCount), [genres, visibleCount]);
  const hasMore = visibleCount < genres.length;

  // Infinite scroll — render the next batch when the user is ~1.5 screens
  // away from the sentinel, so the rest of the watermarks never block first
  // paint of the page.
  useEffect(() => {
    if (!hasMore) return;
    const root = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) setVisibleCount(c => c + PAGE_SIZE); },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: '1500px',
      },
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore]);

  // Restore scroll position after genres are rendered
  useEffect(() => {
    if (loading || genres.length === 0) return;
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (!saved) return;
    const pos = parseInt(saved, 10);
    sessionStorage.removeItem(SCROLL_KEY);
    sessionStorage.removeItem(VISIBLE_KEY);
    requestAnimationFrame(() => {
      const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
      if (el) el.scrollTop = pos;
    });
  }, [loading, genres.length]);

  const handleGenreClick = (genreValue: string) => {
    const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (el) {
      sessionStorage.setItem(SCROLL_KEY, String(el.scrollTop));
      sessionStorage.setItem(VISIBLE_KEY, String(visibleCount));
    }
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

      {!loading && visible.length > 0 && (
        <>
          <div className="album-grid-wrap">
            {visible.map(genre => {
              const Icon = getGenreIcon(genre.value);
              const color = genreColor(genre.value);
              return (
                <div
                  key={genre.value}
                  className="genre-card"
                  style={{ '--genre-color': color } as React.CSSProperties}
                  onClick={() => handleGenreClick(genre.value)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && handleGenreClick(genre.value)}
                  data-tooltip={genre.value}
                >
                  <div className="genre-card-watermark">
                    <Icon size={80} strokeWidth={1.2} />
                  </div>
                  <p className="genre-card-name">{genre.value}</p>
                  <p className="genre-card-count">
                    {t('genres.albumCount', { count: genre.albumCount })}
                  </p>
                </div>
              );
            })}
          </div>
          {hasMore && <div ref={observerTarget} style={{ height: 1 }} />}
        </>
      )}
    </div>
  );
}
