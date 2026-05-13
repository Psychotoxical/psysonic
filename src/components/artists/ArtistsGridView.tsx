import React from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import type { PlayerState } from '../../store/playerStoreTypes';
import { ArtistCardAvatar } from './ArtistAvatars';

interface Props {
  visible: SubsonicArtist[];
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
 * Card grid for the artists page. Click navigates to the artist detail
 * (or toggles selection while in select-mode); right-click opens the
 * standard context menu, escalating to `multi-artist` when there is an
 * active multi-selection.
 */
export function ArtistsGridView({
  visible,
  selectionMode,
  selectedIds,
  selectedArtists,
  showArtistImages,
  toggleSelect,
  navigate,
  openContextMenu,
  t,
}: Props) {
  return (
    <div className="album-grid-wrap">
      {visible.map(artist => (
        <div
          key={artist.id}
          className={`artist-card${selectionMode && selectedIds.has(artist.id) ? ' selected' : ''}${selectionMode ? ' artist-card--selectable' : ''}`}
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
          style={selectionMode && selectedIds.has(artist.id) ? {
            outline: '2px solid var(--accent)',
            outlineOffset: '2px',
            borderRadius: 'var(--radius-md)',
          } : {}}
        >
          {selectionMode && (
            <div className={`artist-card-select-check${selectedIds.has(artist.id) ? ' artist-card-select-check--on' : ''}`}>
              {selectedIds.has(artist.id) && <Check size={14} strokeWidth={3} />}
            </div>
          )}
          <ArtistCardAvatar artist={artist} showImages={showArtistImages} />
          <div style={{ textAlign: 'center' }}>
            <div className="artist-card-name">{artist.name}</div>
            {artist.albumCount != null && (
              <div className="artist-card-meta">{t('artists.albumCount', { count: artist.albumCount })}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
