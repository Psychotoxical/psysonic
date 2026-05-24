import type { ServerProfile } from '../../store/authStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { serverProfileBaseUrl } from './serverBaseUrl';

/** Stable index key derived from a server URL (host + optional path, no scheme). */
export function serverIndexKeyFromUrl(urlRaw: string): string {
  const base = serverProfileBaseUrl({ url: urlRaw });
  return base.replace(/^https?:\/\//, '');
}

export function serverIndexKeyForProfile(server: Pick<ServerProfile, 'url'>): string {
  return serverIndexKeyFromUrl(server.url);
}

export function resolveIndexKey(serverIdOrKey: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverIdOrKey);
  if (!server) return serverIdOrKey;
  return serverIndexKeyFromUrl(server.url) || serverIdOrKey;
}
