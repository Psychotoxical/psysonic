import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import React, { useMemo, useState, useEffect } from 'react';
import { useTracklistColumns } from '@/lib/hooks/useTracklistColumns';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { useSelectionStore } from '@/store/selectionStore';
import {
  COLUMNS,
  type SortKey,
} from '@/features/album/utils/albumTrackListHelpers';
import { useAlbumTrackListSelection } from '@/features/album/hooks/useAlbumTrackListSelection';
import { TrackRow } from '@/features/album/components/TrackRow';
import { AlbumTrackListMobile } from '@/features/album/components/AlbumTrackListMobile';
import { TracklistColumnPicker } from '@/ui/TracklistColumnPicker';
import { TracklistHeaderRow } from '@/features/album/components/TracklistHeaderRow';
import { DiscHeaderCover } from '@/features/album/components/DiscHeaderCover';
import { offlineActionPolicy, type OfflineActionPolicy } from '@/features/offline';
import { ownedEntityKey, ownedOverrideValue } from '@/lib/util/ownedEntityKey';

export type { SortKey } from '@/features/album/utils/albumTrackListHelpers';

interface AlbumTrackListProps {
  songs: SubsonicSong[];
  /** Per-disc subtitles from the album payload, rendered after "CD N". */
  discTitles?: { disc: number; title: string }[];
  sorted?: boolean;
  hasVariousArtists: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  ratings: Record<string, number>;
  userRatingOverrides: Record<string, number>;
  starredSongs: Set<string>;
  onPlaySong: (song: SubsonicSong) => void;
  /** Optional dbl-click handler — currently set only in Orbit mode so the list knows to bind it. */
  onDoubleClickSong?: (song: SubsonicSong) => void;
  onRate: (song: SubsonicSong, rating: number) => void;
  onToggleSongStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  onContextMenu: (x: number, y: number, track: Track, type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song') => void;
  sortKey?: SortKey;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: SortKey) => void;
  actionPolicy?: OfflineActionPolicy;
}

// ── AlbumTrackList ────────────────────────────────────────────────────────────

export default function AlbumTrackList({
  songs,
  discTitles,
  sorted,
  hasVariousArtists: _hasVariousArtists,
  currentTrack,
  isPlaying,
  ratings,
  userRatingOverrides,
  starredSongs,
  onPlaySong,
  onDoubleClickSong,
  onRate,
  onToggleSongStar,
  onContextMenu,
  sortKey,
  sortDir,
  onSort,
  actionPolicy,
}: AlbumTrackListProps) {
  const policy = actionPolicy ?? offlineActionPolicy('trackRow', false);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [contextMenuSongKey, setContextMenuSongKey] = useState<string | null>(null);
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);

  const {
    colVisible, visibleCols, gridStyle,
    startResize, startFlexColumnResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(COLUMNS, 'psysonic_tracklist_columns');

  const {
    inSelectMode, allSelected, onToggleSelect, onDragStart, toggleAll,
  } = useAlbumTrackListSelection({ songs, tracklistRef });

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!contextMenuOpen) setContextMenuSongKey(null);
  }, [contextMenuOpen]);

  // ── Disc grouping ─────────────────────────────────────────────────────────
  const discs = new Map<number, SubsonicSong[]>();
  if (!sorted) {
    songs.forEach(song => {
      const disc = song.discNumber ?? 1;
      if (!discs.has(disc)) discs.set(disc, []);
      discs.get(disc)!.push(song);
    });
  } else {
    discs.set(1, songs as SubsonicSong[]);
  }
  const discNums = sorted ? [1] : Array.from(discs.keys()).sort((a, b) => a - b);
  const isMultiDisc = !sorted && discNums.length > 1;
  const discTitleByNum = new Map<number, string>(
    (discTitles ?? []).filter(d => d.title?.trim()).map(d => [d.disc, d.title.trim()]),
  );

  const displayCols = useMemo(
    () => (policy.canFavorite ? visibleCols : visibleCols.filter(c => c.key !== 'favorite')),
    [policy.canFavorite, visibleCols],
  );

  if (isMobile) {
    return (
      <AlbumTrackListMobile
        discNums={discNums}
        discs={discs}
        discTitleByNum={discTitleByNum}
        isMultiDisc={isMultiDisc}
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        contextMenuSongKey={contextMenuSongKey}
        setContextMenuSongKey={setContextMenuSongKey}
        onPlaySong={onPlaySong}
        onContextMenu={onContextMenu}
      />
    );
  }

  return (
    <>
      <TracklistColumnPicker
        allColumns={COLUMNS}
        pickerRef={pickerRef}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        colVisible={colVisible}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        t={t}
      />

    <div
        className="tracklist"
        ref={tracklistRef}
        data-preview-loc="albums"
        onClick={e => {
          if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
        }}
      >

      <TracklistHeaderRow
        visibleCols={displayCols}
        gridStyle={gridStyle}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        allSelected={allSelected}
        inSelectMode={inSelectMode}
        toggleAll={toggleAll}
        startResize={startResize}
        startFlexColumnResize={startFlexColumnResize}
        t={t}
      />

      {/* ── Tracks ── */}
      {discNums.map(discNum => (
        <div key={discNum}>
          {isMultiDisc && (
            <div className="disc-header">
              <DiscHeaderCover song={discs.get(discNum)![0]} />
              CD {discNum}
              {discTitleByNum.get(discNum) && (
                <span className="disc-subtitle">{discTitleByNum.get(discNum)}</span>
              )}
            </div>
          )}
          {discs.get(discNum)!.map(song => {
            const globalIdx = songs.indexOf(song);
            const songKey = ownedEntityKey(song);
            return (
              <TrackRow
                key={songKey}
                song={song}
                globalIdx={globalIdx}
                visibleCols={displayCols}
                gridStyle={gridStyle}
                currentTrack={currentTrack}
                isPlaying={isPlaying}
                ratingValue={ratings[songKey] ?? ownedOverrideValue(userRatingOverrides, song) ?? song.userRating ?? 0}
                isStarred={starredSongs.has(songKey)}
                inSelectMode={inSelectMode}
                isContextMenuSong={contextMenuSongKey === songKey}
                onPlaySong={onPlaySong}
                onDoubleClickSong={onDoubleClickSong}
                onRate={onRate}
                onToggleSongStar={onToggleSongStar}
                onContextMenu={onContextMenu}
                onToggleSelect={onToggleSelect}
                onDragStart={onDragStart}
                setContextMenuSongKey={setContextMenuSongKey}
                actionPolicy={policy}
              />
            );
          })}
        </div>
      ))}

    </div>
    </>
  );
}
