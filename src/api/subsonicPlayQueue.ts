import { api, apiForServer } from './subsonicClient';
import type { SubsonicSong } from './subsonicTypes';

export async function getPlayQueue(): Promise<{ current?: string; position?: number; songs: SubsonicSong[] }> {
  try {
    const data = await api<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>('getPlayQueue.view');
    const pq = data.playQueue;
    return { current: pq?.current, position: pq?.position, songs: pq?.entry ?? [] };
  } catch {
    return { songs: [] };
  }
}

export async function savePlayQueue(
  songIds: string[],
  current: string | undefined,
  position: number | undefined,
  serverId: string,
): Promise<void> {
  if (!serverId) return;
  const params: Record<string, unknown> = {};
  if (songIds.length > 0) params.id = songIds;
  if (current !== undefined) params.current = current;
  if (position !== undefined) params.position = position;
  await apiForServer(serverId, 'savePlayQueue.view', params);
}
