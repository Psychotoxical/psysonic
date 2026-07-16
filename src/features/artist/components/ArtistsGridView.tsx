import React from 'react';
import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { ARTISTS_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { ArtistCardAvatar } from '@/features/artist/components/ArtistAvatars';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

interface TileProps {
  artist: SubsonicArtist;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (artist: SubsonicArtist) => void;
  onOpenArtist: (artist: SubsonicArtist) => void;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

type TilePropsShared = Omit<TileProps, 'artist'>;

function ArtistGridTile({ artist, ...rest }: TileProps) {
  return (
    <div
      className={`artist-card${rest.selectionMode ? ' artist-card--selectable' : ''}${rest.selectionMode && rest.selectedIds.has(libraryEntityKey(artist)) ? ' artist-card--selected' : ''}`}
      onClick={() => {
        if (rest.selectionMode) {
          rest.toggleSelect(artist);
        } else {
          rest.onOpenArtist(artist);
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
    >
      {rest.selectionMode && (
        <div className={`artist-card-select-check${rest.selectedIds.has(libraryEntityKey(artist)) ? ' artist-card-select-check--on' : ''}`}>
          {rest.selectedIds.has(libraryEntityKey(artist)) && <Check size={14} strokeWidth={3} />}
        </div>
      )}
      <ArtistCardAvatar artist={artist} showImages={rest.showArtistImages} />
      <div className="artist-card-info artist-card-info--center">
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
  /** Plain CSS grid (canonical card layout) vs row virtualization for large catalogs. */
  disableVirtualization: boolean;
  /** Remount grid when browse filters change so virtualizer state cannot go stale. */
  layoutKey: string;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (artist: SubsonicArtist) => void;
  onOpenArtist: (artist: SubsonicArtist) => void;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

/**
 * Card grid for the artists page — same VirtualCardGrid path as Albums/Composers.
 */
export function ArtistsGridView({
  visible,
  disableVirtualization,
  layoutKey,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  onOpenArtist,
  openContextMenu,
  t,
}: Props) {
  const tilePropsShared: TilePropsShared = {
    selectionMode,
    selectedIds,
    selectedArtists,
    showArtistImages,
    toggleSelect,
    onOpenArtist,
    openContextMenu,
    t,
  };

  return (
    <VirtualCardGrid
      key={layoutKey}
      items={visible}
      itemKey={libraryEntityKey}
      rowVariant="artist"
      disableVirtualization={disableVirtualization}
      layoutSignal={visible.length}
      scrollRootId={ARTISTS_INPAGE_SCROLL_VIEWPORT_ID}
      wrapClassName={disableVirtualization ? 'album-grid-wrap album-grid-wrap--plain' : 'album-grid-wrap'}
      renderItem={artist => (
        <ArtistGridTile key={libraryEntityKey(artist)} artist={artist} {...tilePropsShared} />
      )}
    />
  );
}
