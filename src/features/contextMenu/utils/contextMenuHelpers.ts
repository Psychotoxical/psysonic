import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { isSmartPlaylist } from '@/lib/format/playlistClassification';

export function manualPlaylistTargetsForServer(
  playlists: readonly SubsonicPlaylist[],
  serverId: string | undefined,
): SubsonicPlaylist[] {
  if (!serverId) return [];
  return playlists.filter(playlist => (
    playlist.serverId === serverId
    && !isSmartPlaylist(playlist)
  ));
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

/** Fisher-Yates in-place shuffle — returns a new array, does not mutate the input. */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
