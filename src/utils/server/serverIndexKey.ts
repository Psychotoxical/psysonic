import type { ServerProfile } from '../../store/authStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { serverProfileBaseUrl } from './serverBaseUrl';

/** Stable index key derived from a server URL (scheme + host + optional path). */
export function serverIndexKeyFromUrl(urlRaw: string): string {
  return serverProfileBaseUrl({ url: urlRaw });
}

export function serverIndexKeyForProfile(server: Pick<ServerProfile, 'url'>): string {
  return serverIndexKeyFromUrl(server.url);
}

export function resolveIndexKey(serverIdOrKey: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverIdOrKey);
  if (!server) return serverIdOrKey;
  return serverIndexKeyFromUrl(server.url) || serverIdOrKey;
}
