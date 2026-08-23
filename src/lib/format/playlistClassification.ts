import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';

export const LEGACY_SMART_PLAYLIST_PREFIX = 'psy-smart-';

type ClassifiablePlaylist = Pick<SubsonicPlaylist, 'name'> & Pick<Partial<SubsonicPlaylist>, 'smart'>;

function hasLegacySmartPlaylistName(name: string): boolean {
  return name.toLowerCase().startsWith(LEGACY_SMART_PLAYLIST_PREFIX);
}

/** Native metadata is authoritative; the legacy prefix is used only when it is unavailable. */
export function isSmartPlaylist(playlist: ClassifiablePlaylist): boolean {
  return playlist.smart ?? hasLegacySmartPlaylistName(playlist.name);
}

/** Keep legacy prefixed names visually unchanged while native smart names remain literal. */
export function playlistDisplayName(playlist: Pick<SubsonicPlaylist, 'name'>): string {
  return hasLegacySmartPlaylistName(playlist.name)
    ? playlist.name.slice(LEGACY_SMART_PLAYLIST_PREFIX.length)
    : playlist.name;
}

/** A Navidrome smart playlist has a root match-all or match-any expression. */
export function hasNavidromeSmartRules(rules: unknown): boolean {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
  const record = rules as Record<string, unknown>;
  return Array.isArray(record.all) || Array.isArray(record.any);
}
