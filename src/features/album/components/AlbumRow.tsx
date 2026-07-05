import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import React, { useRef, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import AlbumCard from '@/features/album/components/AlbumCard';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { dedupeById } from '@/lib/util/dedupeById';

interface Props {
  title: string;
  titleLink?: string;
  albums: SubsonicAlbum[];
  moreLink?: string;
  moreText?: string;
  onLoadMore?: () => Promise<void>;
  /** Restored horizontal scroll (e.g. Advanced Search session return). */
  restoreScrollLeft?: number;
  /** Parent stashes horizontal scroll when leaving the page. */
  onScrollLeftSnapshot?: (scrollLeft: number) => void;
  /** Fired once when `restoreScrollLeft` has been applied (or skipped). */
  onScrollRestoreComplete?: () => void;
  showRating?: boolean;
  /** Optional content rendered in the row header, left of the scroll-nav. */
  headerExtra?: React.ReactNode;
  disableArtwork?: boolean;
  disableInteractivity?: boolean;
  artworkSize?: number;
  windowArtworkByViewport?: boolean;
  initialArtworkBudget?: number;
  /** Appended to `/album/:id` links, e.g. `lossless=1`. */
  albumLinkQuery?: string;
  /** Search/browse rows: API `coverArt` only — no per-card library_resolve IPC. */
  libraryResolve?: boolean;
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
  albumLinkQuery,
  libraryResolve = false,
  restoreScrollLeft,
  onScrollLeftSnapshot,
  onScrollRestoreComplete,
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
  const scrollRestoreTargetRef = useRef(restoreScrollLeft);
  const scrollRestoreDoneRef = useRef(false);
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

    onScrollLeftSnapshot?.(scrollLeft);

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
    // handleScroll/recomputeArtworkBudget are recreated each render but read live
    // refs/props; the listeners are intentionally (re)bound only when the row data
    // or artwork config changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueAlbums, interactivityDisabled, windowArtworkByViewport, initialArtworkBudget]);

  // Reset when the row’s identity changes (new data / server), not when the list grows via
  // “load more” — reusing albums.length would shrink the budget mid-scroll and flash placeholders.
  const rowArtworkResetKey = uniqueAlbums[0]?.id ?? '';
  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArtworkBudget(initialArtworkBudget);
  }, [initialArtworkBudget, rowArtworkResetKey]);

  const notifyRestoreCompletePendingRef = useRef(false);
  const [restoreCompleteTick, setRestoreCompleteTick] = useState(0);

  useEffect(() => {
    if (restoreScrollLeft == null || restoreScrollLeft <= 0) return;
    scrollRestoreTargetRef.current = restoreScrollLeft;
    scrollRestoreDoneRef.current = false;
    notifyRestoreCompletePendingRef.current = false;
  }, [restoreScrollLeft]);

  useLayoutEffect(() => {
    if (scrollRestoreDoneRef.current) return;
    const target = scrollRestoreTargetRef.current;
    if (target == null || target <= 0) {
      scrollRestoreDoneRef.current = true;
      onScrollRestoreComplete?.();
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const finish = () => {
      scrollRestoreDoneRef.current = true;
      if (windowArtworkByViewport) {
        notifyRestoreCompletePendingRef.current = true;
        setRestoreCompleteTick(t => t + 1);
        return;
      }
      onScrollRestoreComplete?.();
    };

    const attempt = () => {
      if (cancelled || scrollRestoreDoneRef.current) return;
      const el = scrollRef.current;
      if (!el) {
        if (++attempts < 12) requestAnimationFrame(attempt);
        else finish();
        return;
      }

      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      const desired = Math.min(Math.max(0, target), maxScroll);
      el.scrollLeft = desired;
      if (windowArtworkByViewport) recomputeArtworkBudget();
      handleScroll();

      const stuck = Math.abs(el.scrollLeft - desired) <= 1;
      const layoutStillGrowing = desired > el.scrollLeft + 1 && maxScroll < target;
      if ((!stuck || layoutStillGrowing) && ++attempts < 12) {
        requestAnimationFrame(attempt);
        return;
      }
      finish();
    };

    attempt();
    return () => {
      cancelled = true;
    };
    // handleScroll/recomputeArtworkBudget/onScrollRestoreComplete are recreated
    // each render but read live state; the restore pass is intentionally keyed on
    // the row identity / layout signals, not on those callback identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowArtworkResetKey, windowArtworkByViewport, initialArtworkBudget, uniqueAlbums.length]);

  useLayoutEffect(() => {
    if (!notifyRestoreCompletePendingRef.current) return;
    notifyRestoreCompletePendingRef.current = false;
    onScrollRestoreComplete?.();
  }, [artworkBudget, restoreCompleteTick, onScrollRestoreComplete]);

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
              key={a.serverId ? `${a.serverId}:${a.id}` : a.id}
              album={a}
              showRating={showRating}
              linkQuery={albumLinkQuery}
              libraryResolve={libraryResolve}
              disableArtwork={
                artworkDisabled ||
                (windowArtworkByViewport && idx >= artworkBudget)
              }
              artworkSize={artworkSize}
            />
          ))}
          {loadingMore && (
            <div className="album-card-more" style={{ cursor: 'default' }}>
              <div style={{ padding: '1rem', background: 'var(--bg-app)', borderRadius: 'var(--radius-sm)' }}>
                <div className="spinner" style={{ width: 24, height: 24 }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{t('common.loadingMore')}</span>
            </div>
          )}
          {!loadingMore && moreLink && (
            <div className="album-card-more" onClick={() => navigate(moreLink)}>
              <div style={{ padding: '1rem', background: 'var(--bg-app)', borderRadius: 'var(--radius-sm)' }}>
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
