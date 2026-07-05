import { queueSongStar, queueSongRating } from '@/features/playback/store/pendingStarSync';
import React, { useEffect, useMemo, useState } from 'react';
import { useTracklistColumns, type ColDef } from '@/lib/hooks/useTracklistColumns';
import { TopFavoriteArtistsRow } from '@/features/favorites/components/TopFavoriteArtists';
import { RadioStationRow } from '@/features/favorites/components/RadioFavorites';
import FavoritesSongsSectionHeader from '@/features/favorites/components/FavoritesSongsSectionHeader';
import FavoritesSongsTracklist from '@/features/favorites/components/FavoritesSongsTracklist';
import { useFavoritesData } from '@/features/favorites/hooks/useFavoritesData';
import { useFavoritesSongFiltering } from '@/features/favorites/hooks/useFavoritesSongFiltering';
import { useFavoritesSelection } from '@/features/favorites/hooks/useFavoritesSelection';
import { useBulkPlPickerOutsideClick } from '@/features/playlist/hooks/useBulkPlPickerOutsideClick';
import { AlbumRow } from '@/features/album';
import { ArtistRow } from '@/features/artist';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useTranslation } from 'react-i18next';
import { useSelectionStore } from '@/store/selectionStore';
import FavoritesOfflineHeader from '@/features/favorites/components/FavoritesOfflineHeader';

const FAV_COLUMNS: readonly ColDef[] = [
  { key: 'num',        i18nKey: null,              minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',      i18nKey: 'trackTitle',      minWidth: 150, defaultWidth: 0,   required: true,  flex: true },
  { key: 'artist',     i18nKey: 'trackArtist',     minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'album',      i18nKey: 'trackAlbum',      minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'genre',      i18nKey: 'trackGenre',      minWidth: 60,  defaultWidth: 120, required: false },
  { key: 'rating',     i18nKey: 'trackRating',     minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration',   i18nKey: 'trackDuration',   minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',     i18nKey: 'trackFormat',     minWidth: 60,  defaultWidth: 80,  required: false },
  { key: 'playCount',  i18nKey: 'trackPlayCount', minWidth: 60,  defaultWidth: 80,  required: false },
  { key: 'lastPlayed', i18nKey: 'trackLastPlayed', minWidth: 90,  defaultWidth: 130, required: false },
  { key: 'bpm',        i18nKey: 'trackBpm',        minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'remove',     i18nKey: null,              minWidth: 36,  defaultWidth: 36,  required: true  },
];

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = 1950;

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
  const playRadio = usePlayerStore(s => s.playRadio);
  const stop = usePlayerStore(s => s.stop);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);

  const handleRate = (songId: string, rating: number) => {
    setRatings(r => ({ ...r, [songId]: rating }));
    // F4: optimistic override + retried server sync via the central helper.
    queueSongRating(songId, rating);
  };

  function removeSong(id: string) {
    // F4: optimistic un-star + retried server sync via the central helper.
    const song = songs.find(s => s.id === id);
    queueSongStar(id, false, song?.serverId);
    setSongs(prev => prev.filter(s => s.id !== id));
  }

  const { visibleSongs, handleSortClick, getSortIndicator } = useFavoritesSongFiltering({
    songs, sortKey, setSortKey, sortDir, setSortDir, sortClickCount, setSortClickCount,
    selectedArtist, selectedGenres, yearRange, ratings,
  });

  const selectedArtistName = useMemo(
    () => selectedArtist ? topFavoriteArtists.find(a => a.id === selectedArtist)?.name ?? null : null,
    [selectedArtist, topFavoriteArtists],
  );

  const { toggleSelect } = useFavoritesSelection(visibleSongs, inSelectMode, tracklistRef);

  useBulkPlPickerOutsideClick(showPlPicker, setShowPlPicker);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!inSelectMode) setShowPlPicker(false);
  }, [inSelectMode]);


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
      <div className="playlists-header" style={{ marginBottom: '-1.5rem' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>{t('favorites.title')}</h1>
        <FavoritesOfflineHeader />
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
                selectedArtistName={selectedArtistName}
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
                inSelectMode={inSelectMode}
                selectedCount={selectedCount}
                selectedIds={selectedIds}
                showPlPicker={showPlPicker}
                setShowPlPicker={setShowPlPicker}
              />
              <FavoritesSongsTracklist
                visibleSongs={visibleSongs}
                selectedIds={selectedIds}
                selectedCount={selectedCount}
                inSelectMode={inSelectMode}
                toggleSelect={toggleSelect}
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
