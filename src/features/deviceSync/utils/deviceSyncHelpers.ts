import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { TrackSyncInfo } from '@/generated/bindings';

export type SourceTab = 'playlists' | 'albums' | 'artists';

export function uuid(): string { return crypto.randomUUID(); }

export type SyncStatus = 'synced' | 'pending' | 'deletion';

export type { RemovableDrive } from '@/generated/bindings';

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
export type SyncTrackMaybePlaylist = SubsonicSong & {
  _playlistName?: string;
  _playlistId?: string;
  _playlistIndex?: number;
};

type PlaylistSourceIdentity = { type: string; id: string; name: string; pathId?: string };

function playlistCollisionKey(name: string): string {
  const sanitized = Array.from(name, char => (
    '/\\:*?"<>|'.includes(char) || /\p{Cc}/u.test(char) ? '_' : char
  )).join('').replace(/^[. ]+|[. ]+$/g, '');
  return (sanitized || 'Unnamed Playlist').toLowerCase();
}

export function playlistPathId(
  source: PlaylistSourceIdentity,
  sources: readonly PlaylistSourceIdentity[],
): string | undefined {
  if (source.type !== 'playlist') return undefined;
  if (source.pathId) return source.pathId;
  const key = playlistCollisionKey(source.name);
  const collisions = sources.filter(candidate => (
    candidate.type === 'playlist' && playlistCollisionKey(candidate.name) === key
  ));
  return collisions.length > 1 ? source.id : undefined;
}

export function withPlaylistPathIds<T extends PlaylistSourceIdentity>(sources: readonly T[]): T[] {
  return sources.map(source => {
    const pathId = playlistPathId(source, sources);
    return pathId && !source.pathId ? { ...source, pathId } : source;
  });
}

export function trackToSyncInfo(
  track: SyncTrackMaybePlaylist,
  url: string,
  playlistCtx?: { id?: string; name: string; index: number },
): TrackSyncInfo {
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
    trackNumber: track.track ?? null,
    duration: track.duration,
    playlistName: playlistCtx?.name ?? track._playlistName,
    playlistId: playlistCtx?.id ?? track._playlistId,
    playlistIndex: playlistCtx?.index ?? track._playlistIndex,
  };
}
