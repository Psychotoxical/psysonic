import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';

/** Subsonic JSON may return one ref object instead of a one-element array. */
export function coerceOpenArtistRefs(
  refs: SubsonicOpenArtistRef[] | SubsonicOpenArtistRef | undefined | null,
): SubsonicOpenArtistRef[] {
  if (refs == null) return [];
  if (Array.isArray(refs)) return refs;
  if (typeof refs === 'object') return [refs];
  return [];
}
