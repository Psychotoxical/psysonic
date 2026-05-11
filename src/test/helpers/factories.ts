/**
 * Test fixture factories.
 *
 * Build minimal but valid domain objects with sensible defaults; override only
 * the fields the test cares about. Keeps tests focused on behaviour rather
 * than on assembling boilerplate.
 */
import type { Track } from '@/store/playerStore';

let trackCounter = 0;

export function makeTrack(overrides: Partial<Track> = {}): Track {
  trackCounter += 1;
  const id = overrides.id ?? `track-${trackCounter}`;
  return {
    id,
    title: `Track ${trackCounter}`,
    artist: 'Test Artist',
    album: 'Test Album',
    albumId: `album-${trackCounter}`,
    duration: 180,
    coverArt: id,
    ...overrides,
  } as Track;
}

export function makeTracks(n: number, overridesFn?: (i: number) => Partial<Track>): Track[] {
  return Array.from({ length: n }, (_, i) => makeTrack(overridesFn?.(i) ?? {}));
}

export function resetFactoryCounters(): void {
  trackCounter = 0;
}
