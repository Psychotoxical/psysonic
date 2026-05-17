import React from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Virtualizer } from '@tanstack/react-virtual';
import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import type { PlayerState } from '../../store/playerStoreTypes';
import { ArtistCardAvatar } from './ArtistAvatars';

export type ArtistsGridVirtualization = {
  virtualizer: Virtualizer<HTMLElement, Element>;
  scrollMargin: number;
};

interface TileProps {
  artist: SubsonicArtist;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (id: string) => void;
  navigate: NavigateFunction;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

type TilePropsShared = Omit<TileProps, 'artist'>;

function ArtistGridTile({ artist, ...rest }: TileProps) {
  return (
    <div
      className={`artist-card${rest.selectionMode && rest.selectedIds.has(artist.id) ? ' selected' : ''}${rest.selectionMode ? ' artist-card--selectable' : ''}`}
      onClick={() => {
        if (rest.selectionMode) {
          rest.toggleSelect(artist.id);
        } else {
          rest.navigate(`/artist/${artist.id}`);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (rest.selectionMode && rest.selectedIds.size > 0) {
          rest.openContextMenu(e.clientX, e.clientY, rest.selectedArtists, 'multi-artist');
        } else {
          rest.openContextMenu(e.clientX, e.clientY, artist, 'artist');
        }
      }}
      style={rest.selectionMode && rest.selectedIds.has(artist.id) ? {
        outline: '2px solid var(--accent)',
        outlineOffset: '2px',
        borderRadius: 'var(--radius-md)',
      } : {}}
    >
      {rest.selectionMode && (
        <div className={`artist-card-select-check${rest.selectedIds.has(artist.id) ? ' artist-card-select-check--on' : ''}`}>
          {rest.selectedIds.has(artist.id) && <Check size={14} strokeWidth={3} />}
        </div>
      )}
      <ArtistCardAvatar artist={artist} showImages={rest.showArtistImages} />
      <div style={{ textAlign: 'center' }}>
        <div className="artist-card-name">{artist.name}</div>
        {artist.albumCount != null && (
          <div className="artist-card-meta">{rest.t('artists.albumCount', { count: artist.albumCount })}</div>
        )}
      </div>
    </div>
  );
}

interface Props {
  visible: SubsonicArtist[];
  /** Column count from layout (capped at six in parent); drives `repeat(n, minmax(0,1fr))`. */
  gridCols: number;
  /** ResizeObserver target — same node for plain and virtual grid. */
  measureRef: React.RefObject<HTMLDivElement | null>;
  virtualization?: ArtistsGridVirtualization | null;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (id: string) => void;
  navigate: NavigateFunction;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

/**
 * Card grid for the artists page. Optional row virtualization (TanStack) for
 * large libraries; column count and `measureRef` always come from the parent.
 */
export function ArtistsGridView({
  visible,
  gridCols,
  measureRef,
  virtualization,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  navigate,
  openContextMenu,
  t,
}: Props) {
  const tilePropsShared: TilePropsShared = {
    selectionMode,
    selectedIds,
    selectedArtists,
    showArtistImages,
    toggleSelect,
    navigate,
    openContextMenu,
    t,
  };

  const cols = Math.max(1, gridCols);

  if (virtualization) {
    const { virtualizer, scrollMargin } = virtualization;
    const rowCount = Math.ceil(visible.length / cols);
    return (
      <div
        ref={measureRef}
        className="album-grid-wrap"
        style={{ display: 'block', position: 'relative', width: '100%' }}
      >
        <div
          style={{
            height: rowCount === 0 ? 0 : virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map(vRow => {
            const start = vRow.index * cols;
            const rowArtists = visible.slice(start, start + cols);
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start - scrollMargin}px)`,
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gap: 'var(--space-4)',
                  alignItems: 'start',
                }}
              >
                {rowArtists.map(artist => (
                  <ArtistGridTile key={artist.id} artist={artist} {...tilePropsShared} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={measureRef}
      className="album-grid-wrap"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: 'var(--space-4)',
        alignItems: 'start',
      }}
    >
      {visible.map(artist => (
        <ArtistGridTile key={artist.id} artist={artist} {...tilePropsShared} />
      ))}
    </div>
  );
}
