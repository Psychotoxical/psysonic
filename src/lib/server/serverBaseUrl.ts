import type { ServerProfile } from '@/store/authStoreTypes';

/** Normalized Subsonic root URL for a server profile (same shape as `getBaseUrl`). */
export function serverProfileBaseUrl(server: Pick<ServerProfile, 'url'>): string {
  if (!server.url) return '';
  const base = server.url.startsWith('http') ? server.url : `http://${server.url}`;
  return base.replace(/\/$/, '');
}
