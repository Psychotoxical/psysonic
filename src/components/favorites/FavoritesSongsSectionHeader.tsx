import React from 'react';
import { useTranslation } from 'react-i18next';
import { ListPlus, Play, SlidersHorizontal, X } from 'lucide-react';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import { songToTrack } from '../../utils/songToTrack';
import GenreFilterBar from '../GenreFilterBar';

interface Props {
  visibleSongs: SubsonicSong[];
  songs: SubsonicSong[];
  selectedArtist: string | null;
  setSelectedArtist: React.Dispatch<React.SetStateAction<string | null>>;
  selectedGenres: string[];
  setSelectedGenres: React.Dispatch<React.SetStateAction<string[]>>;
  yearRange: [number, number];
  setYearRange: React.Dispatch<React.SetStateAction<[number, number]>>;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  setSortKey: React.Dispatch<React.SetStateAction<string>>;
  setSortClickCount: React.Dispatch<React.SetStateAction<number>>;
  playTrack: ReturnType<typeof usePlayerStore.getState>['playTrack'];
  enqueue: ReturnType<typeof usePlayerStore.getState>['enqueue'];
  starredOverrides: Record<string, boolean>;
  minYear: number;
  currentYear: number;
}

export default function FavoritesSongsSectionHeader({
  visibleSongs, songs, selectedArtist, setSelectedArtist,
  selectedGenres, setSelectedGenres, yearRange, setYearRange,
  showFilters, setShowFilters, setSortKey, setSortClickCount,
  playTrack, enqueue, starredOverrides, minYear, currentYear,
}: Props) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.75rem' }}>
      {/* Title Row with showing X of Y indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <h2 className="section-title" style={{ margin: 0 }}>{t('favorites.songs')}</h2>
        {(selectedArtist || selectedGenres.length > 0 || yearRange[0] !== minYear || yearRange[1] !== currentYear) && (
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {selectedArtist
              ? t('favorites.showingFiltered', { filtered: visibleSongs.length, total: songs.filter(s => starredOverrides[s.id] !== false).length, artist: selectedArtist })
              : t('favorites.showingCount', { filtered: visibleSongs.length, total: songs.filter(s => starredOverrides[s.id] !== false).length })}
          </span>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={visibleSongs.length === 0}
          onClick={() => {
            if (visibleSongs.length === 0) return;
            const tracks = visibleSongs.map(songToTrack);
            playTrack(tracks[0], tracks);
          }}
        >
          <Play size={15} />
          {t('favorites.playAll')}
        </button>
        <button
          className="btn btn-surface"
          disabled={visibleSongs.length === 0}
          onClick={() => {
            if (visibleSongs.length === 0) return;
            const tracks = visibleSongs.map(songToTrack);
            enqueue(tracks);
          }}
        >
          <ListPlus size={15} />
          {t('favorites.enqueueAll')}
        </button>

        {/* Filter Toggle Button */}
        <button
          className={`btn ${showFilters || selectedGenres.length > 0 || yearRange[0] !== minYear || yearRange[1] !== currentYear ? 'btn-primary' : 'btn-surface'}`}
          onClick={() => setShowFilters(v => !v)}
        >
          <SlidersHorizontal size={14} />
          {t('common.filters')}
        </button>

        {(selectedArtist || selectedGenres.length > 0 || yearRange[0] !== minYear || yearRange[1] !== currentYear) && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setSelectedArtist(null);
              setSelectedGenres([]);
              setYearRange([minYear, currentYear]);
              setSortKey('natural');
              setSortClickCount(0);
            }}
          >
            <X size={13} />
            {t('common.clearAll')}
          </button>
        )}
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.75rem', background: 'var(--surface)', borderRadius: '8px', marginTop: '0.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <GenreFilterBar selected={selectedGenres} onSelectionChange={setSelectedGenres} />
          </div>

          {/* Year Range Filter */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
              <span>{t('common.yearRange')}:</span>
              <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{yearRange[0]} - {yearRange[1]}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <input
                type="range"
                min={minYear}
                max={currentYear}
                value={yearRange[0]}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  setYearRange(prev => [Math.min(val, prev[1] - 1), prev[1]]);
                }}
                style={{ flex: 1 }}
              />
              <input
                type="range"
                min={minYear}
                max={currentYear}
                value={yearRange[1]}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  setYearRange(prev => [prev[0], Math.max(val, prev[0] + 1)]);
                }}
                style={{ flex: 1 }}
              />
            </div>
          </div>
        </div>
      )}

      {selectedArtist && (
        <button
          onClick={() => setSelectedArtist(null)}
          className="btn btn-ghost btn-sm"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
            fontSize: '0.75rem',
            alignSelf: 'flex-start',
          }}
        >
          <X size={11} />
          {t('favorites.clearArtistFilter')}
        </button>
      )}
    </div>
  );
}
