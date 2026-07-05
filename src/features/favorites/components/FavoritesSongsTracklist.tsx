import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import FavoriteSongRow, { type FavoriteSongRowCallbacks } from '@/features/favorites/components/FavoriteSongRow';
import { TracklistColumnPicker } from '@/ui/TracklistColumnPicker';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { previewInputFromSong, usePreviewStore } from '@/features/playback/store/previewStore';
import { useSelectionStore } from '@/store/selectionStore';
import { useThemeStore } from '@/store/themeStore';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { songToTrack } from '@/lib/media/songToTrack';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useElementClientHeightById } from '@/lib/hooks/useResizeClientHeight';
import { SORTABLE_COLUMNS } from '@/features/favorites/hooks/useFavoritesSongFiltering';

interface Props {
  visibleSongs: SubsonicSong[];
  selectedIds: Set<string>;
  selectedCount: number;
  inSelectMode: boolean;
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
  allColumns: readonly ColDef[];
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  colVisible: Set<string>;
  toggleColumn: (key: string) => void;
  resetColumns: () => void;
  pickerOpen: boolean;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  tracklistRef: React.RefObject<HTMLDivElement | null>;
  startResize: (e: React.MouseEvent, colIndex: number, direction?: 1 | -1) => void;
  handleSortClick: (key: string) => void;
  getSortIndicator: (key: string) => React.ReactNode;
  ratings: Record<string, number>;
  handleRate: (songId: string, rating: number) => void;
  removeSong: (id: string) => void;
  hasFilters: boolean;
}

export default function FavoritesSongsTracklist({
  visibleSongs, selectedIds, selectedCount, inSelectMode, toggleSelect,
  allColumns, visibleCols, gridStyle, colVisible, toggleColumn, resetColumns,
  pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  startResize, handleSortClick, getSortIndicator,
  ratings, handleRate, removeSong, hasFilters,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const showBitrate = useThemeStore(s => s.showBitrate);
  const psyDrag = useDragDrop();
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  const visibleTracks = useMemo(() => visibleSongs.map(songToTrack), [visibleSongs]);

  const latestVals = {
    visibleSongs, visibleTracks, selectedIds, inSelectMode, orbitActive,
    toggleSelect, handleRate, removeSong, playTrack, openContextMenu,
    navigate, queueHint, addTrackToOrbit, psyDrag,
  };
  const latest = useRef(latestVals);
  latest.current = latestVals;

  const cb = useMemo<FavoriteSongRowCallbacks>(() => ({
    activate: (song, index, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const L = latest.current;
      if (e.ctrlKey || e.metaKey) L.toggleSelect(song.id, index, false);
      else if (L.inSelectMode) L.toggleSelect(song.id, index, e.shiftKey);
      else if (L.orbitActive) L.queueHint();
      else L.playTrack(L.visibleTracks[index], L.visibleTracks);
    },
    dblOrbit: (songId, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const L = latest.current;
      if (e.ctrlKey || e.metaKey || L.inSelectMode) return;
      L.addTrackToOrbit(songId);
    },
    context: (song, e) => {
      e.preventDefault();
      latest.current.openContextMenu(e.clientX, e.clientY, songToTrack(song), 'favorite-song');
    },
    mouseDownRow: (song, e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const track = songToTrack(song);
      const onMove = (me: MouseEvent) => {
        if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          const L = latest.current;
          const { selectedIds: selIds } = useSelectionStore.getState();
          if (selIds.has(song.id) && selIds.size > 1) {
            const bulkTracks = L.visibleSongs.filter(s => selIds.has(s.id)).map(songToTrack);
            L.psyDrag.startDrag({ data: JSON.stringify({ type: 'songs', tracks: bulkTracks }), label: `${bulkTracks.length} Songs` }, me.clientX, me.clientY);
          } else {
            L.psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
          }
        }
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    toggleSelect: (songId, index, shift) => latest.current.toggleSelect(songId, index, shift),
    play: (index) => {
      const L = latest.current;
      if (L.orbitActive) { L.queueHint(); return; }
      L.playTrack(L.visibleTracks[index], L.visibleTracks);
    },
    startPreview: (song) => usePreviewStore.getState().startPreview(
      previewInputFromSong(song),
      'favorites',
    ),
    rate: (songId, r) => latest.current.handleRate(songId, r),
    remove: (songId) => latest.current.removeSong(songId),
    navArtist: (artistId, serverId) => {
      const query = appendServerQuery(undefined, serverId);
      latest.current.navigate(query ? `/artist/${artistId}?${query}` : `/artist/${artistId}`);
    },
    navAlbum: (albumId, serverId) => {
      const query = appendServerQuery(undefined, serverId);
      latest.current.navigate(query ? `/album/${albumId}?${query}` : `/album/${albumId}`);
    },
  }), []);

  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const viewportH = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);

  // Bulk bar show/hide shifts listWrapRef top — remeasure on that edge only.
  const bulkBarVisible = selectedIds.size > 0;

  useLayoutEffect(() => {
    const sc = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    // scrollMargin must track height changes in sections above the list (filters, top artists).
    // Intentionally coupled to the Favorites page shell class — keep in sync with that layout.
    const root = tracklistRef.current?.closest('.content-body') as HTMLElement | null;
    if (!sc) return;
    const measure = () => {
      const wrap = listWrapRef.current;
      if (!wrap) return;
      const m = wrap.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      setScrollMargin(prev => (Math.abs(prev - m) > 0.5 ? m : prev));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    if (root) ro.observe(root);
    measure();
    return () => ro.disconnect();
  }, [tracklistRef, bulkBarVisible, pickerOpen, visibleSongs.length]);

  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: visibleSongs.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: () => 48,
    overscan: Math.max(8, Math.ceil(viewportH / 48)),
    scrollMargin,
    getItemKey: i => `${visibleSongs[i].id}:${i}`,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <>
      <TracklistColumnPicker
        allColumns={allColumns}
        pickerRef={pickerRef}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        colVisible={colVisible}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        t={t}
      />
    <div className="tracklist" data-preview-loc="favorites" style={{ padding: 0 }} ref={tracklistRef} onClick={e => {
      if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
    }}>

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

      <div ref={listWrapRef} style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualItems.map(vi => {
          const song = visibleSongs[vi.index];
          const i = vi.index;
          return (
            <div
              key={vi.key}
              data-index={i}
              ref={rowVirtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start - scrollMargin}px)` }}
            >
              <FavoriteSongRow
                song={song}
                index={i}
                visibleCols={visibleCols}
                gridStyle={gridStyle}
                showBitrate={showBitrate}
                isActive={currentTrack?.id === song.id}
                showEq={currentTrack?.id === song.id && isPlaying}
                isSelected={selectedIds.has(song.id)}
                inSelectMode={inSelectMode}
                ratingValue={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0}
                isPreviewing={previewingId === song.id}
                previewStarted={previewingId === song.id && previewAudioStarted}
                orbitActive={orbitActive}
                cb={cb}
              />
            </div>
          );
        })}
      </div>

      {/* Empty state when filters return no results */}
      {visibleSongs.length === 0 && hasFilters && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
          {t('favorites.noFilterResults')}
        </div>
      )}
    </div>
    </>
  );
}
