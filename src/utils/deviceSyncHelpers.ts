import type { SubsonicSong } from '../api/subsonicTypes';

export type SourceTab = 'playlists' | 'albums' | 'artists';

export function uuid(): string { return crypto.randomUUID(); }

export type SyncStatus = 'synced' | 'pending' | 'deletion';

export interface RemovableDrive {
  name: string;
  mount_point: string;
  available_space: number;
  total_space: number;
  file_system: string;
  is_removable: boolean;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Tracks that came from `calculate_sync_payload` may carry embedded playlist
 *  context so the follow-up `sync_batch_to_device` call knows to place them
 *  under `Playlists/{Name}/` instead of the album tree. */
export type SyncTrackMaybePlaylist = SubsonicSong & { _playlistName?: string; _playlistIndex?: number };

export function trackToSyncInfo(
  track: SyncTrackMaybePlaylist,
  url: string,
  playlistCtx?: { name: string; index: number },
) {
  // Fall back to track artist when the file has no albumArtist tag — not every
  // library is tagged with it. Treat empty strings as missing (some Subsonic
  // servers return "" rather than omitting the field).
  const albumArtist = (track.albumArtist?.trim() || track.artist?.trim() || '');
  return {
    id: track.id, url,
    suffix: track.suffix ?? 'mp3',
    artist: track.artist ?? '',
    albumArtist,
    album: track.album ?? '',
    title: track.title ?? '',
    trackNumber: track.track,
    duration: track.duration,
    playlistName: playlistCtx?.name ?? track._playlistName,
    playlistIndex: playlistCtx?.index ?? track._playlistIndex,
  };
}
