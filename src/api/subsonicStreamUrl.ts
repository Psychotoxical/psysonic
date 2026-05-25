import md5 from 'md5';
import { coverStorageKey } from '../cover/storageKeys';
import type { CoverArtTier } from '../cover/types';
import { useAuthStore } from '../store/authStore';
import { findServerByIdOrIndexKey } from '../utils/server/serverLookup';
import { restBaseFromUrl, SUBSONIC_CLIENT, secureRandomSalt } from './subsonicClient';

function coverArtQueryParams(username: string, password: string, id: string, size: number): URLSearchParams {
  const salt = secureRandomSalt();
  const token = md5(password + salt);
  return new URLSearchParams({
    id,
    size: String(size),
    u: username,
    t: token,
    s: salt,
    v: '1.16.1',
    c: SUBSONIC_CLIENT,
    f: 'json',
  });
}

function streamUrlFromProfile(
  serverUrl: string,
  username: string,
  password: string,
  id: string,
): string {
  const baseUrl = restBaseFromUrl(serverUrl);
  const salt = secureRandomSalt();
  const token = md5(password + salt);
  const p = new URLSearchParams({
    id,
    u: username,
    t: token,
    s: salt,
    v: '1.16.1',
    c: SUBSONIC_CLIENT,
    f: 'json',
  });
  return `${baseUrl}/stream.view?${p.toString()}`;
}

export function buildStreamUrlForServer(serverId: string, id: string): string {
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) return buildStreamUrl(id);
  return streamUrlFromProfile(server.url, server.username, server.password, id);
}

export function buildStreamUrl(id: string): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  if (!server || !baseUrl) return streamUrlFromProfile('', '', '', id);
  return streamUrlFromProfile(server.url, server.username, server.password, id);
}

/** @deprecated Use `coverStorageKey` from `src/cover/storageKeys` — shim until migration. */
export function coverArtCacheKey(id: string, size = 256): string {
  return coverStorageKey({ kind: 'active' }, id, size as CoverArtTier);
}

/** @deprecated Use `coverStorageKey` from `src/cover/storageKeys` — shim until migration. */
export function coverArtCacheKeyForServer(serverIdOrKey: string, id: string, size = 256): string {
  const server = findServerByIdOrIndexKey(serverIdOrKey);
  if (!server) return `${serverIdOrKey}:cover:${id}:${size}`;
  return coverStorageKey(
    {
      kind: 'server',
      serverId: server.id,
      url: server.url,
      username: server.username,
      password: server.password,
    },
    id,
    size as CoverArtTier,
  );
}

/** @deprecated Use `buildCoverArtFetchUrl` from `src/cover/fetchUrl` — shim until migration. */
export function buildCoverArtUrl(id: string, size = 256): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const p = coverArtQueryParams(server?.username ?? '', server?.password ?? '', id, size);
  return `${baseUrl}/rest/getCoverArt.view?${p.toString()}`;
}

/** @deprecated Use `buildCoverArtFetchUrl` from `src/cover/fetchUrl` — shim until migration. */
export function buildCoverArtUrlForServer(
  serverUrl: string,
  username: string,
  password: string,
  id: string,
  size = 256,
): string {
  const p = coverArtQueryParams(username, password, id, size);
  return `${restBaseFromUrl(serverUrl)}/getCoverArt.view?${p.toString()}`;
}

export function buildDownloadUrl(id: string): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const salt = secureRandomSalt();
  const token = md5((server?.password ?? '') + salt);
  const p = new URLSearchParams({
    id,
    u: server?.username ?? '',
    t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json',
  });
  return `${baseUrl}/rest/download.view?${p.toString()}`;
}
