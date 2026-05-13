import React from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import type { PlayerState } from '../../store/playerStoreTypes';
import type { ArtistListFlatRow } from '../../utils/artistsHelpers';
import { ArtistRowAvatar } from './ArtistAvatars';

interface RowProps {
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

function ArtistListRow({
  artist,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  navigate,
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
          navigate(`/artist/${artist.id}`);
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
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  navigate,
  openContextMenu,
  t,
}: Props) {
  const rowCommonProps = {
    selectionMode, selectedIds, selectedArtists, showArtistImages,
    toggleSelect, navigate, openContextMenu, t,
  };

  if (!virtualized) {
    return (
      <>
        {letters.map(letter => (
          <div key={letter} style={{ marginBottom: '1.5rem' }}>
            <h3 className="letter-heading">{letter}</h3>
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
    <div style={{ position: 'relative', width: '100%' }}>
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
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <h3 className="letter-heading">{row.letter}</h3>
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
                transform: `translateY(${vi.start}px)`,
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
