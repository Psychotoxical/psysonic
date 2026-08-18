import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/store/themeStore';
import { useOverflowTooltip } from '@/lib/hooks/useOverflowTooltip';
import { Cast, ChevronLeft, ChevronRight, Heart, X } from 'lucide-react';
import type { InternetRadioStation } from '@/lib/api/subsonicTypes';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { radioCoverRef } from '@/cover/ref';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '@/cover/layoutSizes';
import { radioStationKey, sameRadioStation } from '@/features/radio';
import { useAuthStore } from '@/store/authStore';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';

interface RadioStationRowProps {
  title: string;
  stations: InternetRadioStation[];
  currentRadio: InternetRadioStation | null;
  isPlaying: boolean;
  onPlay: (s: InternetRadioStation) => void;
  onUnfavorite: (station: InternetRadioStation) => void;
}

export function RadioStationRow({ title, stations, currentRadio, isPlaying, onPlay, onUnfavorite }: RadioStationRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeft, setShowLeft] = useState(false);
  const [showRight, setShowRight] = useState(true);
  const servers = useAuthStore(s => s.servers);
  const serverLabelById = useMemo(() => new Map(
    servers.map(server => [server.id, serverListDisplayLabel(server, servers)]),
  ), [servers]);
  const showServerLabels = new Set(stations.map(station => station.serverId).filter(Boolean)).size > 1;

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
              key={radioStationKey(s)}
              station={s}
              isActive={sameRadioStation(currentRadio, s)}
              isPlaying={isPlaying}
              serverLabel={showServerLabels && s.serverId ? serverLabelById.get(s.serverId) : undefined}
              onPlay={() => onPlay(s)}
              onUnfavorite={() => onUnfavorite(s)}
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
  serverLabel?: string;
  onPlay: () => void;
  onUnfavorite: () => void;
}

function RadioFavCard({ station: s, isActive, isPlaying, serverLabel, onPlay, onUnfavorite }: RadioFavCardProps) {
  const { t } = useTranslation();
  const showCardTooltips = useThemeStore(st => st.showCardTooltips);
  const nameTooltip = useOverflowTooltip(s.name, showCardTooltips);
  return (
    <div className={`album-card${isActive ? ' radio-card-active' : ''}`}>
      <div className="album-card-cover">
        {s.coverArt ? (
          <CoverArtImage
            coverRef={radioCoverRef(s)}
            displayCssPx={COVER_DENSE_GRID_MIN_CELL_CSS_PX}
            surface="dense"
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
          <button
            className="album-card-details-btn"
            onClick={onPlay}
            aria-label={isActive && isPlaying ? t('radio.stopStation') : t('radio.playStation')}
          >
            {isActive && isPlaying ? <X size={15} /> : <Cast size={14} />}
          </button>
        </div>
      </div>
      <div className="album-card-info">
        <div className="album-card-title" {...nameTooltip}>{s.name}</div>
        <div className="album-card-artist" style={{ display: 'flex', alignItems: 'center' }}>
          {serverLabel && <span style={{ marginRight: 6 }}>{serverLabel}</span>}
          <button
            className="radio-favorite-btn active"
            style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer', display: 'flex' }}
            onClick={onUnfavorite}
            aria-label={t('radio.unfavorite')}
            data-tooltip={t('radio.unfavorite')}
          >
            <Heart size={12} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
}
