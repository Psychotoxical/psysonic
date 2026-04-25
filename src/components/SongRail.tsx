import React, { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { SubsonicSong } from '../api/subsonic';
import SongCard from './SongCard';

interface Props {
  title: string;
  songs: SubsonicSong[];
  /** Called when user clicks the reroll button (visible only if provided). */
  onReroll?: () => void | Promise<void>;
  /** Loading state — disables reroll, optional shimmer */
  loading?: boolean;
  /** Empty-state copy when songs is empty AND not loading. */
  emptyText?: string;
}

export default function SongRail({ title, songs, onReroll, loading, emptyText }: Props) {
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
  }, [songs]);

  const scroll = (dir: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const amount = scrollRef.current.clientWidth * 0.75;
    scrollRef.current.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  };

  // Hide rail entirely if empty and no empty-state copy
  if (songs.length === 0 && !loading && !emptyText) return null;

  return (
    <section className="song-row-section">
      <div className="song-row-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>{title}</h2>
        <div className="song-row-nav">
          {onReroll && (
            <button
              className="nav-btn song-row-reroll"
              onClick={() => onReroll()}
              disabled={loading}
              aria-label="Reroll"
              data-tooltip="Reroll"
              data-tooltip-pos="top"
            >
              <RefreshCw size={16} className={loading ? 'is-spinning' : ''} />
            </button>
          )}
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

      <div className="song-grid-wrapper">
        {songs.length === 0 && emptyText ? (
          <p className="song-row-empty">{emptyText}</p>
        ) : (
          <div className="song-grid" ref={scrollRef} onScroll={handleScroll}>
            {songs.map(s => (
              <SongCard key={s.id} song={s} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
