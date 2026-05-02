import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTracklistColumns, type ColDef } from '../utils/useTracklistColumns';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import CachedImage from '../components/CachedImage';
import {
  getStarred, getInternetRadioStations, setRating,
  SubsonicAlbum, SubsonicArtist, SubsonicSong, InternetRadioStation,
  buildCoverArtUrl, coverArtCacheKey,
} from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import StarRating from '../components/StarRating';
import { Cast, ChevronDown, ChevronLeft, ChevronRight, Check, Heart, ListPlus, Play, Square, Star, Users, X, SlidersHorizontal, ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { unstar } from '../api/subsonic';
import { useDragDrop } from '../contexts/DragDropContext';
import { useAuthStore } from '../store/authStore';
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
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [radioStations, setRadioStations] = useState<InternetRadioStation[]>([]);
  const [loading, setLoading] = useState(true);

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
  const lastSelectedIdxRef = useRef<number | null>(null);

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

  // ── Sorting logic ─────────────────────────────────────────────────────────
  const handleSortClick = (key: string) => {
    if (!SORTABLE_COLUMNS.has(key)) return;

    if (sortKey === key) {
      const nextCount = sortClickCount + 1;
      if (nextCount >= 3) {
        // Reset to natural order (favorite addition order)
        setSortKey('natural');
        setSortDir('asc');
        setSortClickCount(0);
      } else {
        // Toggle direction
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        setSortClickCount(nextCount);
      }
    } else {
      // Start new sort on this column
      setSortKey(key);
      setSortDir('asc');
      setSortClickCount(1);
    }
  };

  const getSortIndicator = (key: string) => {
    if (sortKey !== key) return null;
    if (sortClickCount === 0) return null;
    return sortDir === 'asc' ? <ArrowUp size={12} style={{ marginLeft: 4, opacity: 0.7 }} /> : <ArrowDown size={12} style={{ marginLeft: 4, opacity: 0.7 }} />;
  };

  function unfavoriteStation(id: string) {
    setRadioStations(prev => prev.filter(s => s.id !== id));
    try {
      const next = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
      next.delete(id);
      localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...next]));
    } catch { /* ignore */ }
  }

  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const navigate = useNavigate();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  // Clear selection when song list changes
  useEffect(() => {
    useSelectionStore.getState().clearAll();
    lastSelectedIdxRef.current = null;
  }, [songs]);

  // Clear selection on click outside tracklist
  useEffect(() => {
    if (!inSelectMode) return;
    const handler = (e: MouseEvent) => {
      if (tracklistRef.current && !tracklistRef.current.contains(e.target as Node)) {
        useSelectionStore.getState().clearAll();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [inSelectMode]);

  const toggleSelect = useCallback((id: string, idx: number, shift: boolean) => {
    useSelectionStore.getState().setSelectedIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdxRef.current !== null) {
        const from = Math.min(lastSelectedIdxRef.current, idx);
        const to = Math.max(lastSelectedIdxRef.current, idx);
        // we need visibleSongs here — read from latest closure via ref trick
        // Instead, just toggle range based on idx into songs array
        for (let j = from; j <= to; j++) {
          const sid = songs[j]?.id;
          if (sid) next.add(sid);
        }
      } else {
        if (next.has(id)) { next.delete(id); }
        else { next.add(id); lastSelectedIdxRef.current = idx; }
      }
      return next;
    });
  }, [songs]);

  useEffect(() => {
    const loadAll = async () => {
      const [starredResult] = await Promise.allSettled([
        getStarred(),
      ]);
      if (starredResult.status === 'fulfilled') {
        setAlbums(starredResult.value.albums);
        setArtists(starredResult.value.artists);
        setSongs(starredResult.value.songs);
      }

      // Radio favorites: read IDs from localStorage, fetch all stations, filter
      try {
        const favIds = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
        if (favIds.size > 0) {
          const all = await getInternetRadioStations();
          setRadioStations(all.filter(s => favIds.has(s.id)));
        }
      } catch { /* ignore */ }

      setLoading(false);
    };
    loadAll();
  }, [musicLibraryFilterVersion]);

  // ── Top Favorite Artists aggregated from favorited songs ─────────────
  const topFavoriteArtists = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number; coverArtId: string }>();
    for (const s of songs) {
      if (starredOverrides[s.id] === false) continue;
      const key = s.artistId || s.artist;
      if (!key) continue;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          id: key,
          name: s.artist || key,
          count: 1,
          coverArtId: s.artistId || '',
        });
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [songs, starredOverrides]);

  // ── Filter & sort logic ──────────────────────────────────────────────────
  const filteredSongs = useMemo(() => {
    return songs.filter(s => {
      // Remove unfavorited
      if (starredOverrides[s.id] === false) return false;

      // Artist filter
      if (selectedArtist) {
        const artistMatch = s.artistId === selectedArtist ||
                           s.artist === selectedArtist ||
                           s.albumArtist === selectedArtist;
        if (!artistMatch) return false;
      }

      // Genre filter
      if (selectedGenres.length > 0) {
        const songGenre = s.genre || '';
        const hasMatchingGenre = selectedGenres.some(g =>
          songGenre.toLowerCase().includes(g.toLowerCase())
        );
        if (!hasMatchingGenre) return false;
      }

      // Year range filter — only applied when range is non-default; songs without year are excluded
      if (yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) {
        if (s.year === undefined || s.year < yearRange[0] || s.year > yearRange[1]) return false;
      }

      return true;
    });
  }, [songs, starredOverrides, selectedArtist, selectedGenres, yearRange]);

  // ── Sort logic ───────────────────────────────────────────────────────────
  const visibleSongs = useMemo(() => {
    if (sortKey === 'natural' || sortClickCount === 0) {
      return filteredSongs;
    }

    const sorted = [...filteredSongs];
    const multiplier = sortDir === 'asc' ? 1 : -1;

    return sorted.sort((a, b) => {
      switch (sortKey) {
        case 'title':
          return multiplier * (a.title || '').localeCompare(b.title || '');
        case 'artist':
          return multiplier * ((a.artist || '').localeCompare(b.artist || ''));
        case 'album':
          return multiplier * ((a.album || '').localeCompare(b.album || ''));
        case 'rating':
          const ratingA = ratings[a.id] ?? userRatingOverrides[a.id] ?? a.userRating ?? 0;
          const ratingB = ratings[b.id] ?? userRatingOverrides[b.id] ?? b.userRating ?? 0;
          return multiplier * (ratingA - ratingB);
        case 'duration':
          return multiplier * ((a.duration || 0) - (b.duration || 0));
        default:
          return 0;
      }
    });
  }, [filteredSongs, sortKey, sortDir, sortClickCount, ratings, userRatingOverrides]);


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
              {/* ── Section Header with Stats & Filters ───────────────────────── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.75rem' }}>
                {/* Title Row with showing X of Y indicator */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  <h2 className="section-title" style={{ margin: 0 }}>{t('favorites.songs')}</h2>
                  {(selectedArtist || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) && (
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
                    className={`btn ${showFilters || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR ? 'btn-primary' : 'btn-surface'}`}
                    onClick={() => setShowFilters(v => !v)}
                  >
                    <SlidersHorizontal size={14} />
                    {t('common.filters')}
                  </button>

                  {(selectedArtist || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setSelectedArtist(null);
                        setSelectedGenres([]);
                        setYearRange([MIN_YEAR, CURRENT_YEAR]);
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
                          min={MIN_YEAR}
                          max={CURRENT_YEAR}
                          value={yearRange[0]}
                          onChange={e => {
                            const val = parseInt(e.target.value);
                            setYearRange(prev => [Math.min(val, prev[1] - 1), prev[1]]);
                          }}
                          style={{ flex: 1 }}
                        />
                        <input
                          type="range"
                          min={MIN_YEAR}
                          max={CURRENT_YEAR}
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
              <div className="tracklist" data-preview-loc="favorites" style={{ padding: 0 }} ref={tracklistRef} onClick={e => {
                if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
              }}>

                {/* ── Bulk action bar ── */}
                {inSelectMode && (
                  <div className="bulk-action-bar">
                    <span className="bulk-action-count">
                      {t('common.bulkSelected', { count: selectedCount })}
                    </span>
                    <div className="bulk-pl-picker-wrap">
                      <button
                        className="btn btn-surface btn-sm"
                        onClick={() => setShowPlPicker(v => !v)}
                      >
                        <ListPlus size={14} />
                        {t('common.bulkAddToPlaylist')}
                      </button>
                      {showPlPicker && (
                        <AddToPlaylistSubmenu
                          songIds={[...useSelectionStore.getState().selectedIds]}
                          onDone={() => { setShowPlPicker(false); useSelectionStore.getState().clearAll(); }}
                          dropDown
                        />
                      )}
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => useSelectionStore.getState().clearAll()}
                    >
                      <X size={13} />
                      {t('common.bulkClear')}
                    </button>
                  </div>
                )}

                {/* Column visibility picker */}
                <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
                  <div className="tracklist-col-picker">
                    <button className="tracklist-col-picker-btn" onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }} data-tooltip={t('albumDetail.columns')}>
                      <ChevronDown size={14} />
                    </button>
                    {pickerOpen && (
                      <div className="tracklist-col-picker-menu">
                        <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
                        {FAV_COLUMNS.filter(c => !c.required).map(c => {
                          const label = c.i18nKey ? t(`albumDetail.${c.i18nKey}`) : c.key;
                          const isOn = colVisible.has(c.key);
                          return (
                            <button key={c.key} className={`tracklist-col-picker-item${isOn ? ' active' : ''}`} onClick={() => toggleColumn(c.key)}>
                              <span className="tracklist-col-picker-check">{isOn && <Check size={13} />}</span>
                              {label}
                            </button>
                          );
                        })}
                        <div className="tracklist-col-picker-divider" />
                        <button className="tracklist-col-picker-reset" onClick={resetColumns}>
                          <RotateCcw size={13} />
                          {t('albumDetail.resetColumns')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ position: 'relative' }}>
                  <div className="tracklist-header tracklist-va" style={gridStyle}>
                    {visibleCols.map((colDef, colIndex) => {
                      const key = colDef.key;
                      const isLastCol = colIndex === visibleCols.length - 1;
                      const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
                      if (key === 'num') {
                        const allSelected = selectedCount === visibleSongs.length && visibleSongs.length > 0;
                        return (
                          <div key="num" className="track-num">
                            <span
                              className={`bulk-check${allSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
                              style={{ cursor: 'pointer' }}
                              onClick={e => {
                                e.stopPropagation();
                                if (allSelected) {
                                  useSelectionStore.getState().clearAll();
                                } else {
                                  useSelectionStore.getState().setSelectedIds(() => new Set(visibleSongs.map(s => s.id)));
                                }
                              }}
                            />
                            <span className="track-num-number">#</span>
                          </div>
                        );
                      }
                      if (key === 'title') {
                        const hasNextCol = colIndex + 1 < visibleCols.length;
                        const canSort = SORTABLE_COLUMNS.has('title');
                        return (
                          <div key="title" style={{ position: 'relative', padding: 0, margin: 0, minWidth: 0, overflow: 'hidden' }}>
                            <div
                              style={{
                                display: 'flex',
                                width: '100%',
                                height: '100%',
                                alignItems: 'center',
                                justifyContent: 'flex-start',
                                paddingLeft: 12,
                                cursor: canSort ? 'pointer' : 'default',
                                userSelect: 'none',
                              }}
                              onClick={() => handleSortClick('title')}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                              {canSort && getSortIndicator('title')}
                            </div>
                            {hasNextCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />}
                          </div>
                        );
                      }
                      if (key === 'remove') return <div key="remove" />;

                      const isCentered = key === 'duration' || key === 'rating';
                      const canSort = SORTABLE_COLUMNS.has(key);

                      return (
                        <div key={key} style={{ position: 'relative', padding: 0, margin: 0, minWidth: 0, overflow: 'hidden' }}>
                          <div
                            style={{
                              display: 'flex',
                              width: '100%',
                              height: '100%',
                              alignItems: 'center',
                              justifyContent: isCentered ? 'center' : 'flex-start',
                              paddingLeft: isCentered ? 0 : 12,
                              cursor: canSort ? 'pointer' : 'default',
                              userSelect: 'none',
                            }}
                            onClick={() => canSort && handleSortClick(key)}
                          >
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                            {canSort && getSortIndicator(key)}
                          </div>
                          {!isLastCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
                {visibleSongs.map((song, i) => {
                  const track = songToTrack(song);
                  const isSelected = selectedIds.has(song.id);
                  return (
                    <div
                      key={song.id}
                      className={`track-row track-row-va track-row-with-actions${currentTrack?.id === song.id ? ' active' : ''}${isSelected ? ' bulk-selected' : ''}`}
                      style={gridStyle}
                      onClick={e => {
                        if ((e.target as HTMLElement).closest('button, a, input')) return;
                        if (e.ctrlKey || e.metaKey) {
                          toggleSelect(song.id, i, false);
                        } else if (inSelectMode) {
                          toggleSelect(song.id, i, e.shiftKey);
                        } else if (orbitActive) {
                          queueHint();
                        } else {
                          playTrack(track, visibleSongs.map(songToTrack));
                        }
                      }}
                      onDoubleClick={orbitActive ? e => {
                        if ((e.target as HTMLElement).closest('button, a, input')) return;
                        if (e.ctrlKey || e.metaKey || inSelectMode) return;
                        addTrackToOrbit(song.id);
                      } : undefined}
                      onContextMenu={e => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, track, 'favorite-song'); }}
                      role="row"
                      onMouseDown={e => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        const sx = e.clientX, sy = e.clientY;
                        const onMove = (me: MouseEvent) => {
                          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                            const { selectedIds: selIds } = useSelectionStore.getState();
                            if (selIds.has(song.id) && selIds.size > 1) {
                              const bulkTracks = visibleSongs.filter(s => selIds.has(s.id)).map(songToTrack);
                              psyDrag.startDrag({ data: JSON.stringify({ type: 'songs', tracks: bulkTracks }), label: `${bulkTracks.length} Songs` }, me.clientX, me.clientY);
                            } else {
                              psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
                            }
                          }
                        };
                        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                      }}
                    >
                      {visibleCols.map(colDef => {
                        switch (colDef.key) {
                          case 'num': return (
                            <div key="num" className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`}>
                              <span className={`bulk-check${isSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`} onClick={e => { e.stopPropagation(); toggleSelect(song.id, i, e.shiftKey); }} />
                              {currentTrack?.id === song.id && isPlaying ? (
                                <span className="track-num-eq"><div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div></span>
                              ) : (
                                <span className="track-num-number">{i + 1}</span>
                              )}
                            </div>
                          );
                          case 'title': return (
                            <div key="title" className="track-info track-info-suggestion">
                              <button
                                type="button"
                                className="playlist-suggestion-play-btn"
                                onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(track, visibleSongs.map(songToTrack)); }}
                                data-tooltip={t('common.play')}
                                aria-label={t('common.play')}
                              >
                                <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                              </button>
                              <button
                                type="button"
                                className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                                onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'favorites'); }}
                                data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                                aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                              >
                                <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                                  <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                                  <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
                                </svg>
                                {previewingId === song.id
                                  ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                                  : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
                              </button>
                              <span className="track-title">{song.title}</span>
                            </div>
                          );
                          case 'artist': return (
                            <div key="artist" className="track-artist-cell">
                              <span className={`track-artist${song.artistId ? ' track-artist-link' : ''}`} style={{ cursor: song.artistId ? 'pointer' : 'default' }} onClick={() => song.artistId && navigate(`/artist/${song.artistId}`)}>{song.artist}</span>
                            </div>
                          );
                          case 'album': return (
                            <div key="album" className="track-artist-cell">
                              {song.albumId ? (
                                <span
                                  className="track-artist track-artist-link"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(`/album/${song.albumId}`);
                                  }}
                                >
                                  {song.album}
                                </span>
                              ) : (
                                <span className="track-artist">{song.album}</span>
                              )}
                            </div>
                          );
                          case 'genre': return (
                            <div key="genre" className="track-genre">
                              {song.genre ?? '—'}
                            </div>
                          );
                          case 'format': return (
                            <div key="format" className="track-meta">
                              {(song.suffix || song.bitRate) && (
                                <span className="track-codec">
                                  {song.suffix?.toUpperCase()}
                                  {song.suffix && song.bitRate && ' · '}
                                  {song.bitRate && `${song.bitRate} kbps`}
                                </span>
                              )}
                            </div>
                          );
                          case 'rating': return (
                            <StarRating
                              key="rating"
                              value={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0}
                              onChange={r => handleRate(song.id, r)}
                            />
                          );
                          case 'duration': return (
                            <div key="duration" className="track-duration">
                              {Math.floor(song.duration / 60)}:{(song.duration % 60).toString().padStart(2, '0')}
                            </div>
                          );
                          case 'remove': return (
                            <div key="remove" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <button className="btn-icon fav-remove-btn" data-tooltip={t('favorites.removeSong')} onClick={e => { e.stopPropagation(); removeSong(song.id); }} aria-label={t('favorites.removeSong')}>
                                <X size={14} />
                              </button>
                            </div>
                          );
                          default: return null;
                        }
                      })}
                    </div>
                  );
                })}

                {/* Empty state when filters return no results */}
                {visibleSongs.length === 0 && (selectedArtist || selectedGenres.length > 0 || yearRange[0] !== MIN_YEAR || yearRange[1] !== CURRENT_YEAR) && (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                    {t('favorites.noFilterResults')}
                  </div>
                )}
              </div>

            </section>
          )}
        </>
      )}
    </div>
  );
}

// ── Top Favorite Artists Row ──────────────────────────────────────────────────

interface TopFavoriteArtist {
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

function TopFavoriteArtistsRow({ title, artists, selectedKey, onToggle }: TopFavoriteArtistsRowProps) {
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

// ── Radio Station Row ─────────────────────────────────────────────────────────

interface RadioStationRowProps {
  title: string;
  stations: InternetRadioStation[];
  currentRadio: InternetRadioStation | null;
  isPlaying: boolean;
  onPlay: (s: InternetRadioStation) => void;
  onUnfavorite: (id: string) => void;
}

function RadioStationRow({ title, stations, currentRadio, isPlaying, onPlay, onUnfavorite }: RadioStationRowProps) {
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

// ── Radio Favorite Card ───────────────────────────────────────────────────────

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
