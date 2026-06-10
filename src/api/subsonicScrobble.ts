import { api, apiForServer } from './subsonicClient';
import type { SubsonicNowPlaying } from './subsonicTypes';
import { patchLibraryTrackOnUse } from '../utils/library/patchOnUse';
import { shouldAttemptSubsonicForServer } from '../utils/network/subsonicNetworkGuard';

async function scrobbleOnServer(
  serverId: string,
  id: string,
  submission: boolean,
  time?: number,
): Promise<void> {
  // Presence / play-count updates are not playback-byte fetches — omit trackId so
  // hot cache, offline library, and favorites-auto do not suppress Navidrome calls.
  if (!shouldAttemptSubsonicForServer(serverId)) return;
  const params: Record<string, unknown> = { id, submission };
  if (time !== undefined) params.time = time;
  await apiForServer(serverId, 'scrobble.view', params);
}

export async function scrobbleSong(id: string, time: number, serverId: string): Promise<void> {
  if (!serverId) return;
  try {
    await scrobbleOnServer(serverId, id, true, time);
    // Patch-on-use (§6.5 / F3): reflect the play in the local index so the
    // "recently played" surfaces aren't stale. `play_count` is left to the next
    // sync (the patch sets absolute values; a correct increment needs the base).
    patchLibraryTrackOnUse(serverId, id, { playedAt: time });
  } catch {
    // best effort
  }
}

export async function reportNowPlaying(id: string, serverId: string): Promise<void> {
  if (!serverId) return;
  try {
    await scrobbleOnServer(serverId, id, false);
  } catch {
    // best effort
  }
}

export async function getNowPlaying(): Promise<SubsonicNowPlaying[]> {
  try {
    const data = await api<{ nowPlaying: { entry?: SubsonicNowPlaying | SubsonicNowPlaying[] } }>('getNowPlaying.view', { _t: Date.now() });
    const raw = data.nowPlaying?.entry;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    return [];
  }
}
