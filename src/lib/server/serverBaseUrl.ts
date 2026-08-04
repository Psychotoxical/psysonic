import type { ServerProfile } from '@/store/authStoreTypes';

/** Normalized Subsonic root URL for a server profile (same shape as `getBaseUrl`). */
export function serverProfileBaseUrl(server: Pick<ServerProfile, 'url'>): string {
  if (!server.url) return '';
  const base = server.url.startsWith('http') ? server.url : `http://${server.url}`;
  return base.replace(/\/$/, '');
}

/** Stable index key derived from a server URL (host + optional path, no scheme). */
export function serverIndexKeyFromUrl(urlRaw: string): string {
  const base = serverProfileBaseUrl({ url: urlRaw });
  return base.replace(/^https?:\/\//, '');
}

export function serverIndexKeyForProfile(server: Pick<ServerProfile, 'url'>): string {
  return serverIndexKeyFromUrl(server.url);
}
