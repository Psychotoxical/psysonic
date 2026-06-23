import type { SubsonicArtist } from '../api/subsonicTypes';
import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import ArtistCardLocal from './ArtistCardLocal';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Props {
  title: string;
  artists: SubsonicArtist[];
  moreLink?: string;
  moreText?: string;
  artistLinkQuery?: string;
  /** Search results: use API coverArt ids only. */
  libraryResolve?: boolean;
  /** Restored horizontal scroll (e.g. Advanced Search session return). */
  restoreScrollLeft?: number;
  /** Parent stashes horizontal scroll when leaving the page. */
  onScrollLeftSnapshot?: (scrollLeft: number) => void;
}

export default function ArtistRow({
  title, artists, moreLink, moreText, artistLinkQuery, libraryResolve = false,
  restoreScrollLeft,
  onScrollLeftSnapshot,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);
  const scrollRestoreTargetRef = useRef(restoreScrollLeft);
  const scrollRestoreDoneRef = useRef(false);
  const rowResetKey = artists[0]?.id ?? '';

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setShowLeft(scrollLeft > 0);
    setShowRight(scrollLeft < scrollWidth - clientWidth - 5);
    onScrollLeftSnapshot?.(scrollLeft);
  };

  useEffect(() => {
    if (restoreScrollLeft == null || restoreScrollLeft <= 0) return;
    scrollRestoreTargetRef.current = restoreScrollLeft;
    scrollRestoreDoneRef.current = false;
  }, [restoreScrollLeft]);

  useLayoutEffect(() => {
    if (scrollRestoreDoneRef.current) return;
    const target = scrollRestoreTargetRef.current;
    if (target == null || target <= 0) {
      scrollRestoreDoneRef.current = true;
      return;
    }

    let attempts = 0;
    let cancelled = false;

    const attempt = () => {
      if (cancelled || scrollRestoreDoneRef.current) return;
      const el = scrollRef.current;
      if (!el) {
        if (++attempts < 12) requestAnimationFrame(attempt);
        else scrollRestoreDoneRef.current = true;
        return;
      }

      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      const desired = Math.min(Math.max(0, target), maxScroll);
      el.scrollLeft = desired;
      handleScroll();

      const stuck = Math.abs(el.scrollLeft - desired) <= 1;
      const layoutStillGrowing = desired > el.scrollLeft + 1 && maxScroll < target;
      if ((!stuck || layoutStillGrowing) && ++attempts < 12) {
        requestAnimationFrame(attempt);
        return;
      }
      scrollRestoreDoneRef.current = true;
    };

    attempt();
    return () => {
      cancelled = true;
    };
    // handleScroll is recreated each render but reads live refs; the restore pass
    // is intentionally keyed on the row identity, not on the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowResetKey, artists.length]);

  useEffect(() => {
    handleScroll();
    window.addEventListener('resize', handleScroll);
    return () => window.removeEventListener('resize', handleScroll);
    // handleScroll is recreated each render but reads live refs; the resize
    // listener is intentionally rebound only when the row data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artists]);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = scrollRef.current.clientWidth * 0.75;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  if (artists.length === 0) return null;

  return (
    <section className="album-row-section">
      <div className="album-row-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>{title}</h2>
        <div className="album-row-nav">
          <button className={`nav-btn ${!showLeft ? 'disabled' : ''}`} onClick={() => scroll('left')} disabled={!showLeft}>
            <ChevronLeft size={20} />
          </button>
          <button className={`nav-btn ${!showRight ? 'disabled' : ''}`} onClick={() => scroll('right')} disabled={!showRight}>
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      <div className="album-grid-wrapper">
        <div className="album-grid" ref={scrollRef} onScroll={handleScroll}>
          {artists.map(a => (
            <ArtistCardLocal
              key={a.serverId ? `${a.serverId}:${a.id}` : a.id}
              artist={a}
              linkQuery={artistLinkQuery}
              libraryResolve={libraryResolve}
            />
          ))}
          {moreLink && (
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
