/**
 * Test fixture factories.
 *
 * Build minimal but valid domain objects with sensible defaults; override only
 * the fields the test cares about. Keeps tests focused on behaviour rather
 * than on assembling boilerplate.
 */
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { ServerProfile } from '@/store/authStoreTypes';
import type { Track } from '@/lib/media/trackTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
let trackCounter = 0;
let songCounter = 0;
let serverCounter = 0;

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

export function makeSubsonicSong(overrides: Partial<SubsonicSong> = {}): SubsonicSong {
  songCounter += 1;
  const id = overrides.id ?? `song-${songCounter}`;
  return {
    id,
    title: `Song ${songCounter}`,
    artist: 'Test Artist',
    album: 'Test Album',
    albumId: `album-${songCounter}`,
    duration: 180,
    coverArt: id,
    bitRate: 320,
    suffix: 'flac',
    contentType: 'audio/flac',
    size: 8_000_000,
    ...overrides,
  };
}

export function makeServer(overrides: Partial<ServerProfile> = {}): ServerProfile {
  serverCounter += 1;
  return {
    id: `server-${serverCounter}`,
    name: `Test Server ${serverCounter}`,
    url: `https://server-${serverCounter}.test`,
    username: 'tester',
    password: 'pw',
    ...overrides,
  };
}

/** Minimal `useAuthStore.setState(...)` partial — extend per test. */
export function makeAuthState(opts: { servers?: ServerProfile[]; activeServerId?: string | null } = {}) {
  const servers = opts.servers ?? [makeServer()];
  return {
    servers,
    activeServerId: opts.activeServerId === undefined ? servers[0]?.id ?? null : opts.activeServerId,
  };
}

/**
 * Seed the player store with a queue (thin-state). Replaces the old
 * `setState({ queue: [...] })` seeds: it seeds the resolver cache with the full
 * `tracks` (so rows / hot paths resolve them) AND sets the canonical
 * `queueItems` refs + index + currentTrack + queueServerId. Pass `serverId` to
 * match the active server when the test resolves through a real server id;
 * defaults to `''` (the resolver / refs use that same empty id).
 */
export function seedQueue(
  tracks: Track[],
  opts: { index?: number; currentTrack?: Track | null; serverId?: string } = {},
): void {
  const serverId = opts.serverId ?? '';
  const index = opts.index ?? 0;
  const currentTrack =
    opts.currentTrack === undefined ? (tracks[index] ?? null) : opts.currentTrack;
  seedQueueResolver(serverId, tracks);
  usePlayerStore.setState({
    queueItems: toQueueItemRefs(serverId, tracks),
    queueIndex: index,
    currentTrack,
    queueServerId: serverId || null,
  });
}

/** Minimal `usePlayerStore.setState(...)` partial for queue characterization tests. */
export function makeQueueState(opts: { queue?: Track[]; currentIndex?: number; currentTrack?: Track | null } = {}) {
  const queue = opts.queue ?? makeTracks(3);
  const currentIndex = opts.currentIndex ?? 0;
  const currentTrack = opts.currentTrack === undefined ? (queue[currentIndex] ?? null) : opts.currentTrack;
  return { queue, currentIndex, currentTrack };
}

export function resetFactoryCounters(): void {
  trackCounter = 0;
  songCounter = 0;
  serverCounter = 0;
}
