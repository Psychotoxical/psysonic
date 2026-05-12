import type { SubsonicArtist } from '../api/subsonicTypes';
import React, { useRef, useState, useEffect } from 'react';
import ArtistCardLocal from './ArtistCardLocal';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Props {
  title: string;
  artists: SubsonicArtist[];
  moreLink?: string;
  moreText?: string;
}

export default function ArtistRow({ title, artists, moreLink, moreText }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setShowLeft(scrollLeft > 0);
    setShowRight(scrollLeft < scrollWidth - clientWidth - 5);
  };

  useEffect(() => {
    handleScroll();
    window.addEventListener('resize', handleScroll);
    return () => window.removeEventListener('resize', handleScroll);
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
          {artists.map(a => <ArtistCardLocal key={a.id} artist={a} />)}
          {moreLink && (
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
