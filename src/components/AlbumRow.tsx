import type { SubsonicAlbum } from '../api/subsonicTypes';
import React, { useRef, useState, useEffect, useMemo } from 'react';
import AlbumCard from './AlbumCard';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePerfProbeFlags } from '../utils/perfFlags';
import { dedupeById } from '../utils/dedupeById';

interface Props {
  title: string;
  titleLink?: string;
  albums: SubsonicAlbum[];
  moreLink?: string;
  moreText?: string;
  onLoadMore?: () => Promise<void>;
  showRating?: boolean;
  /** Optional content rendered in the row header, left of the scroll-nav. */
  headerExtra?: React.ReactNode;
  disableArtwork?: boolean;
  disableInteractivity?: boolean;
  artworkSize?: number;
  windowArtworkByViewport?: boolean;
  initialArtworkBudget?: number;
}

export default function AlbumRow({
  title,
  titleLink,
  albums,
  moreLink,
  moreText,
  onLoadMore,
  showRating,
  headerExtra,
  disableArtwork = false,
  disableInteractivity = false,
  artworkSize,
  windowArtworkByViewport = false,
  initialArtworkBudget = 8,
}: Props) {
  const perfFlags = usePerfProbeFlags();
  const artworkDisabled = perfFlags.disableMainstageRailArtwork || disableArtwork;
  const interactivityDisabled = perfFlags.disableMainstageRailInteractivity || disableInteractivity;
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artworkBudget, setArtworkBudget] = useState(initialArtworkBudget);

  const loadingRef = useRef(false);
  const uniqueAlbums = useMemo(() => dedupeById(albums), [albums]);

  const recomputeArtworkBudget = () => {
    if (!windowArtworkByViewport) return;
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth } = el;
    const firstCard = el.querySelector<HTMLElement>('.album-card, .artist-card');
    const cardW = firstCard?.clientWidth || firstCard?.getBoundingClientRect().width || 170;
    const gridStyles = window.getComputedStyle(el);
    const gap = Number.parseFloat(gridStyles.columnGap || gridStyles.gap || '16') || 16;
    const step = Math.max(1, cardW + gap);
    const visibleCount = Math.ceil((scrollLeft + clientWidth) / step);
    // Extra slack so fast horizontal scroll doesn’t hit the idx≥budget cliff between frames.
    const nextBudget = Math.max(initialArtworkBudget, visibleCount + 12);
    setArtworkBudget(prev => (nextBudget > prev ? nextBudget : prev));
  };

  const handleScroll = () => {
    if (windowArtworkByViewport) recomputeArtworkBudget();

    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;

    if (!interactivityDisabled) {
      setShowLeft(scrollLeft > 0);
      setShowRight(scrollLeft < scrollWidth - clientWidth - 5);
    }

    // Auto-load trigger (native horizontal scroll still works when rail buttons are perf-disabled)
    if (onLoadMore && !loadingRef.current && scrollLeft > 0 && scrollLeft + clientWidth >= scrollWidth - 300) {
      triggerLoadMore();
    }
  };

  const triggerLoadMore = async () => {
    if (!onLoadMore || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    await onLoadMore();
    setLoadingMore(false);
    loadingRef.current = false;
  };

  useEffect(() => {
    handleScroll();
    const raf = window.requestAnimationFrame(() => {
      if (windowArtworkByViewport) recomputeArtworkBudget();
    });
    window.addEventListener('resize', handleScroll);
    const ro = new ResizeObserver(() => {
      if (windowArtworkByViewport) recomputeArtworkBudget();
    });
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', handleScroll);
      ro.disconnect();
    };
  }, [uniqueAlbums, interactivityDisabled, windowArtworkByViewport, initialArtworkBudget]);

  // Reset when the row’s identity changes (new data / server), not when the list grows via
  // “load more” — reusing albums.length would shrink the budget mid-scroll and flash placeholders.
  const rowArtworkResetKey = uniqueAlbums[0]?.id ?? '';
  useEffect(() => {
    setArtworkBudget(initialArtworkBudget);
  }, [initialArtworkBudget, rowArtworkResetKey]);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = scrollRef.current.clientWidth * 0.75;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  if (uniqueAlbums.length === 0) return null;

  return (
    <section className="album-row-section">
      <div className="album-row-header">
        {titleLink ? (
          <NavLink to={titleLink} className="section-title-link" style={{ marginBottom: 0 }}>
            {title}<ChevronRight size={18} className="section-title-chevron" />
          </NavLink>
        ) : (
          <h2 className="section-title" style={{ marginBottom: 0 }}>{title}</h2>
        )}
        <div className="album-row-nav">
          {headerExtra}
          {!interactivityDisabled && (
            <>
              <button
                className={`nav-btn ${!showLeft ? 'disabled' : ''}`}
                onClick={() => scroll('left')}
                disabled={!showLeft}
              >
                <ChevronLeft size={20} />
              </button>
              <button
                className={`nav-btn ${!showRight ? 'disabled' : ''}`}
                onClick={() => scroll('right')}
                disabled={!showRight}
              >
                <ChevronRight size={20} />
              </button>
            </>
          )}
        </div>
      </div>
      
      <div className="album-grid-wrapper">
        <div className="album-grid" ref={scrollRef} onScroll={handleScroll}>
          {uniqueAlbums.map((a, idx) => (
            <AlbumCard
              key={a.id}
              album={a}
              showRating={showRating}
              disableArtwork={
                artworkDisabled ||
                (windowArtworkByViewport && idx >= artworkBudget)
              }
              artworkSize={artworkSize}
            />
          ))}
          {loadingMore && (
            <div className="album-card-more" style={{ cursor: 'default' }}>
              <div style={{ padding: '1rem', background: 'var(--bg-app)', borderRadius: '50%' }}>
                <div className="spinner" style={{ width: 24, height: 24 }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{t('common.loadingMore')}</span>
            </div>
          )}
          {!loadingMore && moreLink && (
            <div className="album-card-more" onClick={() => navigate(moreLink)}>
              <div style={{ padding: '1rem', background: 'var(--bg-app)', borderRadius: '50%' }}>
                <ArrowRight size={24} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{moreText}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
