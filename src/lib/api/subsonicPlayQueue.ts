import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

export type PlayQueueResult = { current?: string; position?: number; songs: SubsonicSong[] };

function parsePlayQueueResponse(
  data: { playQueue?: { current?: string; position?: number; entry?: SubsonicSong[] } },
): PlayQueueResult {
  const pq = data.playQueue;
  return { current: pq?.current, position: pq?.position, songs: pq?.entry ?? [] };
}

export async function getPlayQueue(): Promise<PlayQueueResult> {
  try {
    const data = await api<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>('getPlayQueue.view');
    return parsePlayQueueResponse(data);
  } catch {
    return { songs: [] };
  }
}

export async function getPlayQueueForServer(serverId: string): Promise<PlayQueueResult> {
  if (!serverId) return { songs: [] };
  try {
    const data = await apiForServer<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>(
      serverId,
      'getPlayQueue.view',
    );
    return parsePlayQueueResponse(data);
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
