import { setRating, unstar } from '../api/subsonicStarRating';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong, InternetRadioStation } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTracklistColumns, type ColDef } from '../utils/useTracklistColumns';
import { TopFavoriteArtistsRow } from '../components/favorites/TopFavoriteArtists';
import { RadioStationRow } from '../components/favorites/RadioFavorites';
import FavoritesSongsSectionHeader from '../components/favorites/FavoritesSongsSectionHeader';
import FavoritesSongsTracklist from '../components/favorites/FavoritesSongsTracklist';
import { useFavoritesData } from '../hooks/useFavoritesData';
import { useFavoritesSongFiltering } from '../hooks/useFavoritesSongFiltering';
import { useFavoritesSelection } from '../hooks/useFavoritesSelection';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import CachedImage from '../components/CachedImage';
import { usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import StarRating from '../components/StarRating';
import { Cast, ChevronDown, ChevronRight, Check, Heart, ListPlus, Play, Square, Star, X, SlidersHorizontal, RotateCcw, AudioLines } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDragDrop } from '../contexts/DragDropContext';
import { useSelectionStore } from '../store/selectionStore';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { AddToPlaylistSubmenu } from '../components/ContextMenu';
import GenreFilterBar from '../components/GenreFilterBar';

const FAV_COLUMNS: readonly ColDef[] = [
  { key: 'num',      i18nKey: null,            minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',    i18nKey: 'trackTitle',    minWidth: 150, defaultWidth: 0,   required: true,  flex: true },
  { key: 'artist',   i18nKey: 'trackArtist',   minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'album',    i18nKey: 'trackAlbum',    minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'genre',    i18nKey: 'trackGenre',    minWidth: 60,  defaultWidth: 120, required: false },
  { key: 'rating',   i18nKey: 'trackRating',   minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration', i18nKey: 'trackDuration', minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',   i18nKey: 'trackFormat',   minWidth: 60,  defaultWidth: 80,  required: false },
  { key: 'remove',   i18nKey: null,            minWidth: 36,  defaultWidth: 36,  required: true  },
];

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1950;

// Columns that support 3-state sorting (asc → desc → reset)
const SORTABLE_COLUMNS = new Set(['title', 'artist', 'album', 'rating', 'duration']);

export default function Favorites() {
  const { t } = useTranslation();
  const {
    albums, artists, songs, setSongs, radioStations,
    loading, topFavoriteArtists, unfavoriteStation,
  } = useFavoritesData();

  // ── Sorting (3-state: asc → desc → reset) ────────────────────────────────
  const [sortKey, setSortKey] = useState<string>('natural');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortClickCount, setSortClickCount] = useState(0);

  // ── Artist filtering ─────────────────────────────────────────────────────
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);

  // ── Genre filtering ──────────────────────────────────────────────────────
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);

  // ── Year range filtering ─────────────────────────────────────────────────
  const [yearRange, setYearRange] = useState<[number, number]>([MIN_YEAR, CURRENT_YEAR]);
  const [showFilters, setShowFilters] = useState(false);

  // ── Column resize/visibility (must be before early return) ───────────────
  const {
    colVisible, visibleCols, gridStyle,
    startResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(FAV_COLUMNS, 'psysonic_favorites_columns');

  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [showPlPicker, setShowPlPicker] = useState(false);

  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const selectedIds = useSelectionStore(s => s.selectedIds);
  const inSelectMode = selectedCount > 0;

  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();
  const playRadio = usePlayerStore(s => s.playRadio);
  const stop = usePlayerStore(s => s.stop);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const psyDrag = useDragDrop();

  const handleRate = (songId: string, rating: number) => {
    setRatings(r => ({ ...r, [songId]: rating }));
    usePlayerStore.getState().setUserRatingOverride(songId, rating);
    setRating(songId, rating).catch(() => {});
  };

  function removeSong(id: string) {
    unstar(id, 'song').catch(() => {});
    setStarredOverride(id, false);
    setSongs(prev => prev.filter(s => s.id !== id));
  }

  const { filteredSongs, visibleSongs, handleSortClick, getSortIndicator } = useFavoritesSongFiltering({
    songs, sortKey, setSortKey, sortDir, setSortDir, sortClickCount, setSortClickCount,
    selectedArtist, selectedGenres, yearRange, ratings,
  });

  const { toggleSelect } = useFavoritesSelection(songs, inSelectMode, tracklistRef);


  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }
  // Check if user has any favorites (using original unfiltered lists)
  const hasAnyFavorites = albums.length > 0 || artists.length > 0 || songs.length > 0 || radioStations.length > 0;

  return (
    <div className="content-body animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
      <div style={{ marginBottom: '-1.5rem' }}>
        <h1 className="page-title">{t('favorites.title')}</h1>
      </div>

      {!hasAnyFavorites ? (
        <div className="empty-state">{t('favorites.empty')}</div>
      ) : (
        <>
          {artists.length > 0 && (
            <ArtistRow title={t('favorites.artists')} artists={artists} />
          )}

          {albums.length > 0 && (
            <AlbumRow title={t('favorites.albums')} albums={albums} />
          )}

          {radioStations.length > 0 && (
            <RadioStationRow
              title={t('favorites.stations')}
              stations={radioStations}
              currentRadio={currentRadio}
              isPlaying={isPlaying}
              onPlay={s => {
                if (currentRadio?.id === s.id && isPlaying) stop();
                else playRadio(s);
              }}
              onUnfavorite={unfavoriteStation}
            />
          )}

          {topFavoriteArtists.length >= 2 && (
            <TopFavoriteArtistsRow
              title={t('favorites.topArtists')}
              artists={topFavoriteArtists}
              selectedKey={selectedArtist}
              onToggle={key => setSelectedArtist(prev => prev === key ? null : key)}
            />
          )}

          {(visibleSongs.length > 0 || selectedArtist || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) && (
            <section className="album-row-section">
              <FavoritesSongsSectionHeader
                visibleSongs={visibleSongs}
                songs={songs}
                selectedArtist={selectedArtist}
                setSelectedArtist={setSelectedArtist}
                selectedGenres={selectedGenres}
                setSelectedGenres={setSelectedGenres}
                yearRange={yearRange}
                setYearRange={setYearRange}
                showFilters={showFilters}
                setShowFilters={setShowFilters}
                setSortKey={setSortKey}
                setSortClickCount={setSortClickCount}
                playTrack={playTrack}
                enqueue={enqueue}
                starredOverrides={starredOverrides}
                minYear={MIN_YEAR}
                currentYear={CURRENT_YEAR}
              />
              <FavoritesSongsTracklist
                visibleSongs={visibleSongs}
                selectedIds={selectedIds}
                selectedCount={selectedCount}
                inSelectMode={inSelectMode}
                toggleSelect={toggleSelect}
                showPlPicker={showPlPicker}
                setShowPlPicker={setShowPlPicker}
                allColumns={FAV_COLUMNS}
                visibleCols={visibleCols}
                gridStyle={gridStyle}
                colVisible={colVisible}
                toggleColumn={toggleColumn}
                resetColumns={resetColumns}
                pickerOpen={pickerOpen}
                setPickerOpen={setPickerOpen}
                pickerRef={pickerRef}
                tracklistRef={tracklistRef}
                startResize={startResize}
                handleSortClick={handleSortClick}
                getSortIndicator={getSortIndicator}
                ratings={ratings}
                handleRate={handleRate}
                removeSong={removeSong}
                hasFilters={!!(selectedArtist || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR)}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
