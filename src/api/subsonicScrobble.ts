import { api, apiForServer } from './subsonicClient';
import type { SubsonicNowPlaying } from './subsonicTypes';

async function scrobbleOnServer(
  serverId: string,
  id: string,
  submission: boolean,
  time?: number,
): Promise<void> {
  const params: Record<string, unknown> = { id, submission };
  if (time !== undefined) params.time = time;
  await apiForServer(serverId, 'scrobble.view', params);
}

export async function scrobbleSong(id: string, time: number, serverId: string): Promise<void> {
  if (!serverId) return;
  try {
    await scrobbleOnServer(serverId, id, true, time);
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
