import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { api } from './subsonicClient';
import type { InternetRadioStation, RadioBrowserStation } from './subsonicTypes';

export async function getInternetRadioStations(): Promise<InternetRadioStation[]> {
  try {
    const data = await api<{ internetRadioStations?: { internetRadioStation?: InternetRadioStation[] } }>(
      'getInternetRadioStations.view'
    );
    return data.internetRadioStations?.internetRadioStation ?? [];
  } catch {
    return [];
  }
}

export async function createInternetRadioStation(
  name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('createInternetRadioStation.view', params);
}

export async function updateInternetRadioStation(
  id: string, name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { id, name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('updateInternetRadioStation.view', params);
}

export async function deleteInternetRadioStation(id: string): Promise<void> {
  await api('deleteInternetRadioStation.view', { id });
}

export async function uploadRadioCoverArt(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  await invoke('upload_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType: file.type || 'image/jpeg',
  });
}

export async function deleteRadioCoverArt(id: string): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  await invoke('delete_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
  });
}

export async function uploadRadioCoverArtBytes(id: string, fileBytes: number[], mimeType: string): Promise<void> {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  await invoke('upload_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType,
  });
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
  return invoke<[number[], string]>('fetch_url_bytes', { url });
}
