import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { PlaybackReportState, SubsonicNowPlaying } from '@/lib/api/subsonicTypes';
import { patchLibraryTrackOnUse } from '@/lib/library/patchOnUse';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';

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
    // played surfaces aren't stale. The count goes up by one rather than being
    // set: the base lives in the row, not here, and nothing re-reads the row
    // after a play — measured on a real library, a finished track left the
    // count untouched through eight minutes of deltas, an album page opened
    // twice, and a full navigation away and back.
    patchLibraryTrackOnUse(serverId, id, { playedAt: time, playCountDelta: 1 });
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

export interface ReportPlaybackParams {
  mediaId: string;
  positionMs: number;
  state: PlaybackReportState;
  /** Effective playback speed; lets the server extrapolate position correctly. */
  playbackRate?: number;
  /**
   * When true, the server records live presence only and skips its scrobble /
   * play-count side effects. psysonic keeps those on the dedicated `scrobble.view`
   * channel (50% rule), so the timeline never double-counts a play.
   */
  ignoreScrobble?: boolean;
}

/**
 * OpenSubsonic `playbackReport` extension (Navidrome ≥ 0.62): report a point on
 * the playback timeline for rich, live now-playing. Best-effort and gated by the
 * same reachability guard as presence scrobbles; callers route through
 * `playbackReportSession` which only invokes this when the server advertises the
 * extension (otherwise the legacy `reportNowPlaying` presence call is used).
 */
export async function reportPlayback(serverId: string, params: ReportPlaybackParams): Promise<void> {
  if (!serverId) return;
  if (!shouldAttemptSubsonicForServer(serverId)) return;
  const query: Record<string, unknown> = {
    mediaId: params.mediaId,
    mediaType: 'song',
    positionMs: Math.max(0, Math.floor(params.positionMs)),
    state: params.state,
  };
  if (params.playbackRate !== undefined) query.playbackRate = params.playbackRate;
  if (params.ignoreScrobble !== undefined) query.ignoreScrobble = params.ignoreScrobble;
  try {
    await apiForServer(serverId, 'reportPlayback.view', query);
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

export async function getNowPlayingForServer(serverId: string): Promise<SubsonicNowPlaying[]> {
  if (!serverId) return [];
  const data = await apiForServer<{
    nowPlaying: { entry?: SubsonicNowPlaying | SubsonicNowPlaying[] };
  }>(serverId, 'getNowPlaying.view', { _t: Date.now() });
  const raw = data.nowPlaying?.entry;
  const entries = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return entries.map(entry => ({ ...entry, serverId }));
}

/** Aggregate live listeners from the selected server scope; one failed server does not hide the rest. */
export async function getNowPlayingForServers(serverIds: string[]): Promise<SubsonicNowPlaying[]> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  const results = await Promise.allSettled(uniqueServerIds.map(getNowPlayingForServer));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}
