import type { ServerProfile } from '../../store/authStoreTypes';
import { serverProfileBaseUrl } from './serverBaseUrl';

/** Stable index key derived from a server URL (scheme + host + optional path). */
export function serverIndexKeyFromUrl(urlRaw: string): string {
  return serverProfileBaseUrl({ url: urlRaw });
}

export function serverIndexKeyForProfile(server: Pick<ServerProfile, 'url'>): string {
  return serverIndexKeyFromUrl(server.url);
}
