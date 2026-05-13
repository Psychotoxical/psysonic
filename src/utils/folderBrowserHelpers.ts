import type React from 'react';
import type { SubsonicAlbum, SubsonicDirectoryEntry } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';

export type ColumnKind = 'roots' | 'indexes' | 'directory';
export type NavPos = { colIndex: number; rowIndex: number };

export type Column = {
  id: string;
  name: string;
  items: SubsonicDirectoryEntry[];
  selectedId: string | null;
  loading: boolean;
  error: boolean;
  kind: ColumnKind;
};

/** getMusicDirectory: `albumId` or `album` + row `id` (Navidrome). */
export function entryToAlbumIfPresent(item: SubsonicDirectoryEntry): SubsonicAlbum | null {
  if (!item.isDir) return null;
  const albumId = item.albumId ?? (item.album ? item.id : undefined);
  if (!albumId) return null;
  return {
    id: albumId,
    name: item.album ?? item.title,
    artist: item.artist ?? '',
    artistId: item.artistId ?? '',
    coverArt: item.coverArt,
    year: item.year,
    genre: item.genre,
    starred: item.starred,
    userRating: item.userRating,
    songCount: 0,
    duration: 0,
  };
}

export function entryToTrack(e: SubsonicDirectoryEntry): Track {
  return {
    id: e.id,
    title: e.title,
    artist: e.artist ?? '',
    album: e.album ?? '',
    albumId: e.albumId ?? '',
    artistId: e.artistId,
    coverArt: e.coverArt,
    duration: e.duration ?? 0,
    track: e.track,
    year: e.year,
    bitRate: e.bitRate,
    suffix: e.suffix,
    genre: e.genre,
    starred: e.starred,
    userRating: e.userRating,
  };
}

export function isFolderBrowserArrowKey(e: React.KeyboardEvent): boolean {
  return (
    e.key === 'ArrowUp' ||
    e.key === 'ArrowDown' ||
    e.key === 'ArrowLeft' ||
    e.key === 'ArrowRight' ||
    e.code === 'ArrowUp' ||
    e.code === 'ArrowDown' ||
    e.code === 'ArrowLeft' ||
    e.code === 'ArrowRight'
  );
}

/** Modifiers from native event + getModifierState (WebKit/WebView can miss flags on the synthetic event). */
export function folderBrowserHasKeyModifiers(e: React.KeyboardEvent): boolean {
  const n = e.nativeEvent;
  if (n.ctrlKey || n.altKey || n.shiftKey || n.metaKey) return true;
  if (typeof n.getModifierState === 'function') {
    return (
      n.getModifierState('Control') ||
      n.getModifierState('Alt') ||
      n.getModifierState('Shift') ||
      n.getModifierState('Meta') ||
      n.getModifierState('OS')
    );
  }
  return false;
}
