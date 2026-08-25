import React, { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { useTracklistColumns } from '@/lib/hooks/useTracklistColumns';
import {
  previewInputFromSong,
  sameQueueTrack,
  usePlayerStore,
  usePreviewStore,
} from '@/features/playback';
import { useThemeStore } from '@/store/themeStore';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useDragPressHandle } from '@/lib/dnd/useDragPress';
import { useOrbitSongRowBehavior } from '@/features/orbit';
import { songToTrack } from '@/lib/media/songToTrack';

import { appendServerQuery, buildArtistDetailPath } from '@/lib/navigation/detailServerScope';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { useElementClientHeightById } from '@/lib/hooks/useResizeClientHeight';
import { useVirtualizerScrollMargin } from '@/lib/hooks/useVirtualizerScrollMargin';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '@/cover/layoutSizes';
import { useWarmTrackListAlbumCovers } from '@/cover/useWarmTrackListAlbumCovers';
import { useTrackListCoverArtEnabled } from '@/cover/useTrackListCoverArtSettings';
import { useResolvedTracklistBpm } from '@/lib/hooks/useResolvedTracklistBpm';
import ArtistAllTracksRow, { type ArtistAllTracksRowCallbacks } from '@/features/artist/components/ArtistAllTracksRow';
import {
  ARTIST_ALL_TRACKS_CENTERED_COLS,
  ARTIST_ALL_TRACKS_SORTABLE,
  type ArtistAllTracksColKey,
  type ArtistAllTracksSortKey,
} from '@/features/artist/utils/artistAllTracksColumns';
import {
  nextArtistAllTracksSort,
  sortArtistAllTracks,
  type ArtistAllTracksSortState,
} from '@/features/artist/utils/artistAllTracksSort';

const ROW_HEIGHT = 48;

interface Props {
  songs: SubsonicSong[];
  loading: boolean;
  /** The index could not answer — shown as an empty state, not an endless spinner. */
  failed: boolean;
  /** Plays the clicked track and hands the rest of the visible order to the queue. */
  onPlay: (songs: SubsonicSong[], index: number) => void;
  /**
   * Column state, owned by the section so its picker can sit in the tab row
   * rather than floating above the table on a line of its own.
   */
  columns: ReturnType<typeof useTracklistColumns>;
}

/**
 * The artist's complete track list: every track they perform on, across their own
 * releases and the compilations and guest spots they appear on.
 *
 * Virtualised because this list is unbounded — a prolific artist can reach into the
 * thousands, where the album tracklist tops out at one record.
 */
export default function ArtistAllTracksList({ songs, loading, failed, onPlay, columns }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const showBitrate = useThemeStore(s => s.showBitrate);
  const trackListCoversOn = useTrackListCoverArtEnabled('pages');
  const psyDrag = useDragDrop();
  // Rows are virtualised, so one can be recycled out from under a held button.
  const dragPress = useDragPressHandle();
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  const [sort, setSort] = useState<ArtistAllTracksSortState>({ key: 'natural', dir: 'asc' });

  const {
    colVisible, visibleCols, gridStyle, pickerOpen, startResize, startFlexColumnResize, tracklistRef,
  } = columns;
  const resolvedBpmSongs = useResolvedTracklistBpm(
    songs,
    colVisible.has('bpm') || sort.key === 'bpm',
  );
  const displayed = useMemo(
    () => sortArtistAllTracks(resolvedBpmSongs, sort),
    [resolvedBpmSongs, sort],
  );

  // ── Virtualisation against the page's own scroll container ──────────────────
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const viewportH = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);

  // The shared hook also watches the scroll element's first child, so sections
  // that resolve above this list (bio, similar artists, "also featured on") move
  // the offset with them instead of leaving rows at a stale Y.
  const scrollMargin = useVirtualizerScrollMargin(
    listWrapRef,
    () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    { active: true, deps: [pickerOpen, displayed.length] },
  );

  // React Compiler incompatible-library rule: third-party hook/value the compiler cannot analyze; usage is correct.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: () => ROW_HEIGHT,
    overscan: Math.max(8, Math.ceil(viewportH / ROW_HEIGHT)),
    scrollMargin,
    // Index-suffixed: the same track can legitimately appear twice (an album and
    // its compilation reissue), and a duplicate key would drop one of the rows.
    getItemKey: i => `${displayed[i].id}:${i}`,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  const warmVisibleSongs = useMemo(
    () => virtualItems.map(vi => displayed[vi.index]),
    [virtualItems, displayed],
  );
  useWarmTrackListAlbumCovers(warmVisibleSongs, COVER_ARTIST_TOP_TRACK_CSS_PX, {
    enabled: trackListCoversOn,
  });

  const handleSortClick = (key: string) => {
    if (!ARTIST_ALL_TRACKS_SORTABLE.has(key)) return;
    setSort(prev => nextArtistAllTracksSort(prev, key as ArtistAllTracksSortKey));
  };
  const sortIndicator = (key: string) => {
    if (sort.key !== key) return null;
    return sort.dir === 'asc'
      ? <ArrowUp size={12} style={{ marginLeft: 4, opacity: 0.7 }} />
      : <ArrowDown size={12} style={{ marginLeft: 4, opacity: 0.7 }} />;
  };

  // Latest-value box so the row callbacks stay stable across renders.
  const latest = useRef({ displayed, orbitActive, queueHint, addTrackToOrbit, onPlay, psyDrag });
  latest.current = { displayed, orbitActive, queueHint, addTrackToOrbit, onPlay, psyDrag };

  const cb = useMemo<ArtistAllTracksRowCallbacks>(() => ({
    activate: (song, index, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const L = latest.current;
      if (L.orbitActive) { L.queueHint(); return; }
      L.onPlay(L.displayed, index);
    },
    dblOrbit: (song, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      latest.current.addTrackToOrbit(song.id, song.serverId);
    },
    context: (song, e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, songToTrack(song), 'song');
    },
    mouseDownRow: (song, e) => {
      dragPress.arm(e, {
        canStart: ev => !(ev.target as HTMLElement).closest('button, a, input'),
        onStart: me => latest.current.psyDrag.startDrag(
          { data: JSON.stringify({ type: 'song', track: songToTrack(song) }), label: song.title },
          me.clientX, me.clientY,
        ),
      });
    },
    play: index => {
      const L = latest.current;
      if (L.orbitActive) { L.queueHint(); return; }
      L.onPlay(L.displayed, index);
    },
    startPreview: song => usePreviewStore.getState().startPreview(previewInputFromSong(song), 'artist'),
    navArtist: (artistId, serverId) => navigate(buildArtistDetailPath(artistId, { serverId })),
    navAlbum: (albumId, serverId) => {
      const query = appendServerQuery(undefined, serverId);
      navigate(query ? `/album/${albumId}?${query}` : `/album/${albumId}`);
    },
  }), [dragPress, navigate, openContextMenu]);

  if (loading && songs.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '2rem 0' }} aria-busy="true">
        {t('artistDetail.allTracksLoading')}
      </div>
    );
  }
  if (displayed.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '2rem 0' }}>
        {t(failed ? 'artistDetail.allTracksUnavailable' : 'artistDetail.allTracksEmpty')}
      </div>
    );
  }

  return (
      <div className="tracklist" data-preview-loc="artist" style={{ padding: 0 }} ref={tracklistRef}>
        <div style={{ position: 'relative' }}>
          <div className="tracklist-header tracklist-va" style={gridStyle}>
            {visibleCols.map((colDef, colIndex) => {
              const key = colDef.key;
              const isLastCol = colIndex === visibleCols.length - 1;
              const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
              if (key === 'num') {
                const titleColIndex = visibleCols.findIndex(c => c.key === 'title');
                const titleCol = titleColIndex >= 0 ? visibleCols[titleColIndex] : undefined;
                return (
                  <div key="num" className="track-num" style={{ position: 'relative' }}>
                    <span className="track-num-number">#</span>
                    {titleCol?.flex && (
                      <div className="col-resize-handle" onMouseDown={e => startFlexColumnResize(e, titleColIndex, 1)} />
                    )}
                  </div>
                );
              }
              const isCentered = ARTIST_ALL_TRACKS_CENTERED_COLS.has(key as ArtistAllTracksColKey);
              const canSort = ARTIST_ALL_TRACKS_SORTABLE.has(key);
              const isFlexTitle = key === 'title';
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
                    onClick={() => handleSortClick(key)}
                  >
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                    {canSort && sortIndicator(key)}
                  </div>
                  {!isLastCol && (
                    <div
                      className="col-resize-handle"
                      onMouseDown={e => (isFlexTitle ? startFlexColumnResize(e, colIndex, 1) : startResize(e, colIndex, 1))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div ref={listWrapRef} style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
          {virtualItems.map(vi => {
            const song = displayed[vi.index];
            const isActive = sameQueueTrack(currentTrack, song);
            return (
              <div
                key={vi.key}
                ref={rowVirtualizer.measureElement}
                data-index={vi.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start - rowVirtualizer.options.scrollMargin}px)`,
                }}
              >
                <ArtistAllTracksRow
                  song={song}
                  index={vi.index}
                  visibleCols={visibleCols}
                  gridStyle={gridStyle}
                  showBitrate={showBitrate}
                  isActive={isActive}
                  showEq={isActive && isPlaying}
                  isPreviewing={previewingId === song.id}
                  previewStarted={previewingId === song.id && previewAudioStarted}
                  orbitActive={orbitActive}
                  cb={cb}
                />
              </div>
            );
          })}
        </div>
      </div>
  );
}
