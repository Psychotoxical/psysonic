import React from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { OTHER_BUCKET, type ArtistListFlatRow } from '@/features/artist/utils/artistsHelpers';
import { ArtistRowAvatar } from '@/features/artist/components/ArtistAvatars';

interface RowProps {
  artist: SubsonicArtist;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (id: string) => void;
  onOpenArtist: (id: string) => void;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

function ArtistListRow({
  artist,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  onOpenArtist,
  openContextMenu,
  t,
}: RowProps) {
  return (
    <button
      type="button"
      className={`artist-row${selectionMode && selectedIds.has(artist.id) ? ' selected' : ''}`}
      onClick={() => {
        if (selectionMode) {
          toggleSelect(artist.id);
        } else {
          onOpenArtist(artist.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (selectionMode && selectedIds.size > 0) {
          openContextMenu(e.clientX, e.clientY, selectedArtists, 'multi-artist');
        } else {
          openContextMenu(e.clientX, e.clientY, artist, 'artist');
        }
      }}
      id={`artist-${artist.id}`}
      style={selectionMode && selectedIds.has(artist.id) ? {
        background: 'var(--accent-dim)',
        color: 'var(--accent)',
      } : {}}
    >
      <ArtistRowAvatar artist={artist} showImages={showArtistImages} />
      <div style={{ textAlign: 'left' }}>
        <div className="artist-name">{artist.name}</div>
        {artist.albumCount != null && (
          <div className="artist-meta">{t('artists.albumCount', { count: artist.albumCount })}</div>
        )}
      </div>
    </button>
  );
}

interface Props {
  virtualized: boolean;
  groups: Record<string, SubsonicArtist[]>;
  letters: string[];
  artistListFlatRows: ArtistListFlatRow[];
  artistListVirtualizer: Virtualizer<HTMLElement, Element>;
  artistListWrapRef: React.RefObject<HTMLDivElement | null>;
  artistListScrollMargin: number;
  selectionMode: boolean;
  selectedIds: Set<string>;
  selectedArtists: SubsonicArtist[];
  showArtistImages: boolean;
  toggleSelect: (id: string) => void;
  onOpenArtist: (id: string) => void;
  openContextMenu: PlayerState['openContextMenu'];
  t: TFunction;
}

/**
 * List view for the artists page. Two render paths:
 *  - Non-virtualized — emits one `<div class="artist-list">` per starting
 *    letter, used when the `disableMainstageVirtualLists` perf flag is on
 *    (mostly for low-end devices where translate-Y positioning costs more
 *    than the saved DOM nodes).
 *  - Virtualized — flat `letter / artist / artist / …` row stream sitting
 *    on a single absolutely-positioned `<div>` whose height matches the
 *    virtualizer's totalSize.
 *
 * Both paths share `ArtistListRow` so click + context-menu behaviour is
 * identical regardless of the rendering path.
 */
export function ArtistsListView({
  virtualized,
  groups,
  letters,
  artistListFlatRows,
  artistListVirtualizer,
  artistListWrapRef,
  artistListScrollMargin,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  onOpenArtist,
  openContextMenu,
  t,
}: Props) {
  const rowCommonProps = {
    selectionMode, selectedIds, selectedArtists, showArtistImages,
    toggleSelect, onOpenArtist, openContextMenu, t,
  };

  if (!virtualized) {
    return (
      <>
        {letters.map(letter => (
          <div key={letter} style={{ marginBottom: '1.5rem' }}>
            <h3 className="letter-heading">{letter === OTHER_BUCKET ? t('artists.other') : letter}</h3>
            <div className="artist-list">
              {groups[letter].map(artist => (
                <ArtistListRow key={artist.id} artist={artist} {...rowCommonProps} />
              ))}
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div ref={artistListWrapRef} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{
          height: artistListFlatRows.length === 0 ? 0 : artistListVirtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {artistListVirtualizer.getVirtualItems().map(vi => {
          const row = artistListFlatRows[vi.index];
          if (!row) return null;
          if (row.kind === 'letter') {
            return (
              <div
                key={vi.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start - artistListScrollMargin}px)`,
                }}
              >
                <h3 className="letter-heading">{row.letter === OTHER_BUCKET ? t('artists.other') : row.letter}</h3>
              </div>
            );
          }
          const artist = row.artist;
          return (
            <div
              key={vi.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start - artistListScrollMargin}px)`,
                paddingBottom: row.isLastInLetter ? '1.5rem' : undefined,
              }}
            >
              <ArtistListRow artist={artist} {...rowCommonProps} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
