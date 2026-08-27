import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { PlaybackReportState, SubsonicNowPlaying } from '@/lib/api/subsonicTypes';
import { patchLibraryTrackOnUse } from '@/lib/library/patchOnUse';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';

/**
 * Resolves `true` only when the call actually reached the server.
 *
 * The reachability guard turns the whole thing into a silent no-op, which is
 * indistinguishable from success to a caller that only awaits it — and one
 * caller needs to know the difference.
 */
async function scrobbleOnServer(
  serverId: string,
  id: string,
  submission: boolean,
  time?: number,
): Promise<boolean> {
  // Presence / play-count updates are not playback-byte fetches — omit trackId so
  // hot cache, offline library, and favorites-auto do not suppress Navidrome calls.
  if (!shouldAttemptSubsonicForServer(serverId)) return false;
  const params: Record<string, unknown> = { id, submission };
  if (time !== undefined) params.time = time;
  await apiForServer(serverId, 'scrobble.view', params);
  return true;
}

/**
 * The server's play statistics for one track, read straight back after it
 * accepted a scrobble.
 *
 * Deliberately not `getSongForServer` from `subsonicLibrary`, for two reasons
 * that both matter here. That module reaches the network guard, which reaches
 * the playback stores, which reach back into this one — a static import closes
 * that ring and `dep:check` rejects it (a dynamic one is counted just the same).
 * And its guard call names the track, which suppresses the request for anything
 * the app can already play locally: right for a byte fetch, wrong for a stats
 * read, because a hot-cached or offline track still scrobbles and its count
 * still moves. The guard below is the same one, asked the way this call needs.
 */
async function readServerPlayStats(
  serverId: string,
  id: string,
): Promise<{ playCount?: number; played?: string } | null> {
  if (!shouldAttemptSubsonicForServer(serverId)) return null;
  try {
    const data = await apiForServer<{ song?: { playCount?: number; played?: string } }>(
      serverId,
      'getSong.view',
      { id },
    );
    return data.song ?? null;
  } catch {
    return null;
  }
}

export async function scrobbleSong(id: string, time: number, serverId: string): Promise<void> {
  if (!serverId) return;
  let reachedServer = false;
  try {
    reachedServer = await scrobbleOnServer(serverId, id, true, time);
  } catch {
    // A refused scrobble — a server error, a stale credential, a timeout — is
    // still a play that happened. Swallowed here rather than around everything
    // below, so the local half runs either way.
  }

  // Patch-on-use (§6.5 / F3): reflect the play in the local index so the played
  // surfaces aren't stale. The timestamp is a local truth — the listener did
  // play it, whether or not the server took the scrobble — so it is written
  // either way, and any resync overwrites it.
  patchLibraryTrackOnUse(serverId, id, { playedAt: time });

  // The count is the server's own tally, and only the server can say what it is
  // now. Counting locally cannot work: the row holds a server total, a local
  // increment is measured in a different unit, and the two are indistinguishable
  // once stored — a sync landing between the two writes then either loses the
  // play or counts it twice. So the count is not derived here at all; it is read
  // back from the server that just accepted the scrobble.
  //
  // Only when the scrobble actually arrived. A refused or skipped one leaves the
  // server tally untouched, and re-reading it would just rewrite the value the
  // row already has.
  if (!reachedServer) return;
  const refreshed = await readServerPlayStats(serverId, id);
  if (refreshed?.playCount == null) return;
  const playedAt = refreshed.played != null ? Date.parse(refreshed.played) : NaN;
  patchLibraryTrackOnUse(serverId, id, {
    playCount: refreshed.playCount,
    // The server's own timestamp for the same play, once it has one. Falls back
    // to the local time written above rather than clearing it.
    ...(Number.isFinite(playedAt) ? { playedAt } : {}),
  });
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
