import { api } from './subsonicClient';
import type { SubsonicNowPlaying } from './subsonicTypes';

export async function scrobbleSong(id: string, time: number): Promise<void> {
  try {
    await api('scrobble.view', { id, time, submission: true });
  } catch {
    // best effort
  }
}

export async function reportNowPlaying(id: string): Promise<void> {
  try {
    await api('scrobble.view', { id, submission: false });
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
