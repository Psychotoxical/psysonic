import type React from 'react';
import type { SubsonicAlbum, SubsonicArtist } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import type { EntityShareKind } from '../../utils/shareLink';

export type RatingKind = 'song' | 'album' | 'artist';

export interface KeyboardRating {
  kind: RatingKind;
  id: string;
  value: number;
}

export interface ContextMenuItemsProps {
  type: string | null;
  item: unknown;
  queueIndex?: number;
  playlistId?: string;
  playlistSongIndex?: number;
  shareKindOverride?: EntityShareKind;
  playTrack: (track: Track, queue?: Track[], manual?: boolean, orbitConfirmed?: boolean, targetQueueIndex?: number) => void;
  playNext: (tracks: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
  removeTrack: (idx: number) => void;
  queue: Track[];
  currentTrack: Track | null;
  closeContextMenu: () => void;
  starredOverrides: Record<string, boolean>;
  setStarredOverride: (id: string, starred: boolean) => void;
  lastfmLovedCache: Record<string, boolean>;
  setLastfmLovedForSong: (title: string, artist: string, loved: boolean) => void;
  openSongInfo: (id: string) => void;
  userRatingOverrides: Record<string, number>;
  setKeyboardRating: React.Dispatch<React.SetStateAction<KeyboardRating | null>>;
  keyboardRating: KeyboardRating | null;
  playlistSubmenuOpen: boolean;
  setPlaylistSubmenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  playlistSongIds: string[];
  setPlaylistSongIds: React.Dispatch<React.SetStateAction<string[]>>;
  orbitRole: 'host' | 'guest' | null;
  entityRatingSupport: 'full' | 'track_only' | 'unknown';
  audiomuseNavidromeEnabled: boolean;
  applySongRating: (id: string, rating: number) => void;
  applyAlbumRating: (album: SubsonicAlbum, rating: number) => void;
  applyArtistRating: (artist: SubsonicArtist, rating: number) => void;
  handleAction: (action: () => void | Promise<void>) => Promise<void>;
  startRadio: (artistId: string, artistName: string, seedTrack?: Track) => void;
  startInstantMix: (song: Track) => void;
  downloadAlbum: (albumName: string, albumId: string) => Promise<void>;
  copyShareLink: (kind: EntityShareKind, id: string) => void;
  isStarred: (id: string, itemStarred?: string) => boolean;
}
