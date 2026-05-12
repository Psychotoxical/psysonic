import { getSimilarSongs2, getTopSongs } from '../api/subsonicArtists';
import { getRandomSongs } from '../api/subsonicLibrary';
import type { Track } from '../store/playerStoreTypes';
import {
  enrichSongsForMixRatingFilter,
  getMixMinRatingsConfigFromAuth,
  passesMixMinRatings,
} from './mixRatingFilter';
import { shuffleArray } from './shuffleArray';
import { songToTrack } from './songToTrack';
/**
 * Infinite queue source strategy (Instant Mix-like):
 * 1) Prefer artist-driven candidates (Top + Similar) around the current track.
 * 2) Fallback to random songs when artist-driven fetches are empty.
 */
export async function buildInfiniteQueueCandidates(
  seedTrack: Track | null,
  existingIds: Set<string>,
  count = 5,
): Promise<Track[]> {
  const RANDOM_TOPUP_BATCH_SIZE = Math.max(10, count * 2);
  const RANDOM_TOPUP_MAX_BATCHES = 8;
  const artistId = seedTrack?.artistId?.trim() || null;
  const artistName = seedTrack?.artist?.trim() || null;

  const [similar, top] = await Promise.all([
    artistId ? getSimilarSongs2(artistId).catch(() => []) : Promise.resolve([]),
    artistName ? getTopSongs(artistName).catch(() => []) : Promise.resolve([]),
  ]);

  const seedId = seedTrack?.id ?? null;
  const mixCfg = getMixMinRatingsConfigFromAuth();
  const mixedSources = [...top, ...similar];
  const filteredMixedSongs = mixCfg.enabled
    ? (await enrichSongsForMixRatingFilter(mixedSources, mixCfg)).filter(s => passesMixMinRatings(s, mixCfg))
    : mixedSources;
  const out: Track[] = shuffleArray(
    filteredMixedSongs
      .map(songToTrack)
      .filter(t => t.id !== seedId && !existingIds.has(t.id)),
  )
    .slice(0, count)
    .map(t => ({ ...t, autoAdded: true as const }));

  const seenIds = new Set<string>([...existingIds, ...out.map(t => t.id)]);
  for (let b = 0; out.length < count && b < RANDOM_TOPUP_MAX_BATCHES; b++) {
    const random = await getRandomSongs(RANDOM_TOPUP_BATCH_SIZE, seedTrack?.genre).catch(() => []);
    if (!random.length) break;
    const filteredRandomSongs = mixCfg.enabled
      ? (await enrichSongsForMixRatingFilter(random, mixCfg)).filter(s => passesMixMinRatings(s, mixCfg))
      : random;
    for (const track of shuffleArray(filteredRandomSongs.map(songToTrack))) {
      if (track.id === seedId || seenIds.has(track.id)) continue;
      out.push({ ...track, autoAdded: true as const });
      seenIds.add(track.id);
      if (out.length >= count) break;
    }
  }

  return out.slice(0, count);
}
