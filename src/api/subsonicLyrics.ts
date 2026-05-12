import { api } from './subsonicClient';
import type { SubsonicStructuredLyrics } from './subsonicTypes';

/**
 * Fetches structured lyrics from the server's embedded tags via the
 * OpenSubsonic `getLyricsBySongId` endpoint. Returns null when the
 * server doesn't support the endpoint or the track has no embedded lyrics.
 * Prefers synced lyrics over plain when both are present.
 */
export async function getLyricsBySongId(id: string): Promise<SubsonicStructuredLyrics | null> {
  try {
    const data = await api<{ lyricsList: { structuredLyrics?: SubsonicStructuredLyrics[] } }>(
      'getLyricsBySongId.view',
      { id },
    );
    const list = data.lyricsList?.structuredLyrics;
    if (!list || list.length === 0) return null;
    return list.find(l => l.synced || l.issynced) ?? list[0];
  } catch {
    // Server doesn't support the endpoint or track has no embedded lyrics
    return null;
  }
}
