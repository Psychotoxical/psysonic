import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cast, ChevronLeft, ChevronRight, Heart, X } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { InternetRadioStation } from '../../api/subsonicTypes';
import CachedImage from '../CachedImage';

interface RadioStationRowProps {
  title: string;
  stations: InternetRadioStation[];
  currentRadio: InternetRadioStation | null;
  isPlaying: boolean;
  onPlay: (s: InternetRadioStation) => void;
  onUnfavorite: (id: string) => void;
}

export function RadioStationRow({ title, stations, currentRadio, isPlaying, onPlay, onUnfavorite }: RadioStationRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
    setShowLeft(scrollLeft > 0);
    setShowRight(scrollLeft < scrollWidth - clientWidth - 5);
  };

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -scrollRef.current.clientWidth * 0.75 : scrollRef.current.clientWidth * 0.75, behavior: 'smooth' });
  };

  return (
    <section className="album-row-section">
      <div className="album-row-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>{title}</h2>
        <div className="album-row-nav">
          <button className={`nav-btn${!showLeft ? ' disabled' : ''}`} onClick={() => scroll('left')} disabled={!showLeft}>
            <ChevronLeft size={20} />
          </button>
          <button className={`nav-btn${!showRight ? ' disabled' : ''}`} onClick={() => scroll('right')} disabled={!showRight}>
            <ChevronRight size={20} />
          </button>
        </div>
      </div>
      <div className="album-grid-wrapper">
        <div className="album-grid" ref={scrollRef} onScroll={handleScroll}>
          {stations.map(s => (
            <RadioFavCard
              key={s.id}
              station={s}
              isActive={currentRadio?.id === s.id}
              isPlaying={isPlaying}
              onPlay={() => onPlay(s)}
              onUnfavorite={() => onUnfavorite(s.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

interface RadioFavCardProps {
  station: InternetRadioStation;
  isActive: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onUnfavorite: () => void;
}

function RadioFavCard({ station: s, isActive, isPlaying, onPlay, onUnfavorite }: RadioFavCardProps) {
  const { t } = useTranslation();
  return (
    <div className={`album-card${isActive ? ' radio-card-active' : ''}`}>
      <div className="album-card-cover">
        {s.coverArt ? (
          <CachedImage
            src={buildCoverArtUrl(`ra-${s.id}`, 256)}
            cacheKey={coverArtCacheKey(`ra-${s.id}`, 256)}
            alt={s.name}
            className="album-card-cover-img"
          />
        ) : (
          <div className="album-card-cover-placeholder playlist-card-icon">
            <Cast size={48} strokeWidth={1.2} />
          </div>
        )}
        {isActive && isPlaying && (
          <div className="radio-live-overlay">
            <span className="radio-live-badge">{t('radio.live')}</span>
          </div>
        )}
        <div className="album-card-play-overlay">
          <button className="album-card-details-btn" onClick={onPlay}>
            {isActive && isPlaying ? <X size={15} /> : <Cast size={14} />}
          </button>
        </div>
      </div>
      <div className="album-card-info">
        <div className="album-card-title">{s.name}</div>
        <div className="album-card-artist" style={{ display: 'flex', alignItems: 'center' }}>
          <button
            className="radio-favorite-btn active"
            style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer', display: 'flex' }}
            onClick={onUnfavorite}
            data-tooltip={t('radio.unfavorite')}
          >
            <Heart size={12} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
}
