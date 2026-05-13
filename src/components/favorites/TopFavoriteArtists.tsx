import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import CachedImage from '../CachedImage';

export interface TopFavoriteArtist {
  id: string;
  name: string;
  count: number;
  coverArtId: string;
}

interface TopFavoriteArtistsRowProps {
  title: string;
  artists: TopFavoriteArtist[];
  selectedKey: string | null;
  onToggle: (key: string) => void;
}

export function TopFavoriteArtistsRow({ title, artists, selectedKey, onToggle }: TopFavoriteArtistsRowProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
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
            <TopFavoriteArtistCard
              key={a.id}
              artist={a}
              isSelected={selectedKey === a.id}
              onClick={() => onToggle(a.id)}
              songCountLabel={t('favorites.topArtistsSongCount', { count: a.count })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

interface TopFavoriteArtistCardProps {
  artist: TopFavoriteArtist;
  isSelected: boolean;
  onClick: () => void;
  songCountLabel: string;
}

function TopFavoriteArtistCard({ artist, isSelected, onClick, songCountLabel }: TopFavoriteArtistCardProps) {
  const coverId = artist.coverArtId;
  const coverSrc = useMemo(() => coverId ? buildCoverArtUrl(coverId, 300) : '', [coverId]);
  const coverCacheKey = useMemo(() => coverId ? coverArtCacheKey(coverId, 300) : '', [coverId]);

  return (
    <div
      className={`artist-card${isSelected ? ' artist-card-selected' : ''}`}
      onClick={onClick}
      style={isSelected ? { outline: '2px solid var(--accent)', outlineOffset: '-2px', borderRadius: 12 } : undefined}
    >
      <div className="artist-card-avatar">
        {coverId ? (
          <CachedImage
            src={coverSrc}
            cacheKey={coverCacheKey}
            alt={artist.name}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.parentElement?.classList.add('fallback-visible');
            }}
          />
        ) : (
          <Users size={32} color="var(--text-muted)" />
        )}
      </div>
      <div className="artist-card-info">
        <span className="artist-card-name">{artist.name}</span>
        <span className="artist-card-meta">{songCountLabel}</span>
      </div>
    </div>
  );
}
