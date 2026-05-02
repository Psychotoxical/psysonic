import React, { useRef, useState, useEffect } from 'react';
import { SubsonicAlbum } from '../api/subsonic';
import AlbumCard from './AlbumCard';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

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
}

export default function AlbumRow({ title, titleLink, albums, moreLink, moreText, onLoadMore, showRating, headerExtra }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadingRef = useRef(false);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setShowLeft(scrollLeft > 0);
    setShowRight(scrollLeft < scrollWidth - clientWidth - 5);

    // Auto-load trigger
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
    window.addEventListener('resize', handleScroll);
    return () => window.removeEventListener('resize', handleScroll);
  }, [albums]);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = scrollRef.current.clientWidth * 0.75;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  if (albums.length === 0) return null;

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
        </div>
      </div>
      
      <div className="album-grid-wrapper">
        <div className="album-grid" ref={scrollRef} onScroll={handleScroll}>
          {albums.map(a => <AlbumCard key={a.id} album={a} showRating={showRating} />)}
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
