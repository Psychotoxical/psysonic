import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { InternetRadioStation, RadioBrowserStation } from '@/lib/api/subsonicTypes';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';

type InternetRadioStationResponse = InternetRadioStation & {
  homePageUrl?: string;
};

type InternetRadioResponse = {
  internetRadioStations?: { internetRadioStation?: InternetRadioStationResponse[] };
};

function radioStationsFromResponse(data: InternetRadioResponse): InternetRadioStation[] {
  return (data.internetRadioStations?.internetRadioStation ?? []).map(({ homePageUrl, ...station }) => (
    homePageUrl && station.homepageUrl === undefined
      ? { ...station, homepageUrl: homePageUrl }
      : station
  ));
}

export async function getInternetRadioStations(): Promise<InternetRadioStation[]> {
  try {
    return radioStationsFromResponse(await api<InternetRadioResponse>('getInternetRadioStations.view'));
  } catch {
    return [];
  }
}

export async function getInternetRadioStationsForServer(
  serverId: string,
): Promise<InternetRadioStation[]> {
  if (!shouldAttemptSubsonicForServer(serverId)) throw new Error('Subsonic unavailable');
  const data = await apiForServer<InternetRadioResponse>(serverId, 'getInternetRadioStations.view');
  return radioStationsFromResponse(data).map(station => ({ ...station, serverId }));
}

export interface InternetRadioStationsForServersResult {
  stations: InternetRadioStation[];
  failedServerIds: string[];
}

export async function getInternetRadioStationsForServersSettled(
  serverIds: string[],
): Promise<InternetRadioStationsForServersResult> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueServerIds.map(serverId => getInternetRadioStationsForServer(serverId)),
  );
  return {
    stations: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    failedServerIds: uniqueServerIds.filter((_serverId, index) => results[index]?.status === 'rejected'),
  };
}

export async function createInternetRadioStation(
  name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('createInternetRadioStation.view', params);
}

export async function createInternetRadioStationForServer(
  serverId: string, name: string, streamUrl: string, homepageUrl?: string,
): Promise<void> {
  const params: Record<string, unknown> = { name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await apiForServer(serverId, 'createInternetRadioStation.view', params);
}

export async function updateInternetRadioStation(
  id: string, name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { id, name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('updateInternetRadioStation.view', params);
}

export async function updateInternetRadioStationForServer(
  serverId: string, id: string, name: string, streamUrl: string, homepageUrl?: string,
): Promise<void> {
  const params: Record<string, unknown> = { id, name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await apiForServer(serverId, 'updateInternetRadioStation.view', params);
}

export async function deleteInternetRadioStation(id: string): Promise<void> {
  await api('deleteInternetRadioStation.view', { id });
}

export async function deleteInternetRadioStationForServer(serverId: string, id: string): Promise<void> {
  await apiForServer(serverId, 'deleteInternetRadioStation.view', { id });
}

export async function uploadRadioCoverArt(id: string, file: File): Promise<void> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) throw new Error('No active server');
  return uploadRadioCoverArtForServer(serverId, id, file);
}

export async function uploadRadioCoverArtForServer(
  serverId: string,
  id: string,
  file: File,
): Promise<void> {
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) throw new Error('Server not found');
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadRadioCover(
    connectBaseUrlForServer(server),
    id,
    server.username,
    server.password,
    fileBytes,
    file.type || 'image/jpeg',
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function deleteRadioCoverArt(id: string): Promise<void> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) throw new Error('No active server');
  return deleteRadioCoverArtForServer(serverId, id);
}

export async function deleteRadioCoverArtForServer(serverId: string, id: string): Promise<void> {
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) throw new Error('Server not found');
  const res = await commands.deleteRadioCover(
    connectBaseUrlForServer(server),
    id,
    server.username,
    server.password,
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function uploadRadioCoverArtBytes(id: string, fileBytes: number[], mimeType: string): Promise<void> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) throw new Error('No active server');
  return uploadRadioCoverArtBytesForServer(serverId, id, fileBytes, mimeType);
}

export async function uploadRadioCoverArtBytesForServer(
  serverId: string,
  id: string,
  fileBytes: number[],
  mimeType: string,
): Promise<void> {
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) throw new Error('Server not found');
  const res = await commands.uploadRadioCover(
    connectBaseUrlForServer(server),
    id,
    server.username,
    server.password,
    fileBytes,
    mimeType,
  );
  if (res.status === 'error') throw new Error(res.error);
}

function parseRadioBrowserStations(raw: Array<Record<string, string>>): RadioBrowserStation[] {
  return raw.map(s => ({
    stationuuid: s.stationuuid ?? '',
    name: s.name ?? '',
    url: s.url ?? '',
    favicon: s.favicon ?? '',
    tags: s.tags ?? '',
  }));
}

export async function searchRadioBrowser(query: string, offset = 0): Promise<RadioBrowserStation[]> {
  const raw = await invoke<Array<Record<string, string>>>('search_radio_browser', { query, offset });
  return parseRadioBrowserStations(raw);
}

export async function getTopRadioStations(offset = 0): Promise<RadioBrowserStation[]> {
  const raw = await invoke<Array<Record<string, string>>>('get_top_radio_stations', { offset });
  return parseRadioBrowserStations(raw);
}

export async function fetchUrlBytes(url: string): Promise<[number[], string]> {
  const res = await commands.fetchUrlBytes(url);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}
