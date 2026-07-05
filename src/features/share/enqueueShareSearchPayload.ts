import type { TFunction } from 'i18next';
import {
  getAlbumWithCredentials,
  getArtistWithCredentials,
  getSongWithCredentials,
} from '@/lib/api/subsonicEntityWithCredentials';
import { getSong } from '@/lib/api/subsonicLibrary';
import { resolveAlbum, resolveArtist } from '@/features/offline';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Track } from '@/lib/media/trackTypes';
import { orbitBulkGuard } from '@/features/orbit';
import { findServerIdForShareUrl } from '@/lib/share/shareLink';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import type {
  AlbumShareSearchPayload,
  ArtistShareSearchPayload,
  ComposerShareSearchPayload,
  QueueableShareSearchPayload,
} from '@/lib/share/shareSearch';
import { showToast } from '@/lib/dom/toast';

const RESOLVE_QUEUE_CHUNK = 12;

type ShareServerLookupResult =
  | { type: 'ok'; serverId: string; server: ServerProfile }
  | { type: 'not-logged-in' }
  | { type: 'no-matching-server'; url: string };

type ShareResolveOptions = {
  activateServer?: boolean;
};

export type ShareSearchResolveResult =
  | { type: 'ok'; songs: SubsonicSong[]; total: number; skipped: number }
  | { type: 'not-logged-in' }
  | { type: 'no-matching-server'; url: string }
  | { type: 'all-unavailable' }
  | { type: 'error' };

export type ShareSearchAlbumResolveResult =
  | { type: 'ok'; album: SubsonicAlbum }
  | { type: 'not-logged-in' }
  | { type: 'no-matching-server'; url: string }
  | { type: 'unavailable' }
  | { type: 'error' };

export type ShareSearchArtistResolveResult =
  | { type: 'ok'; artist: SubsonicArtist }
  | { type: 'not-logged-in' }
  | { type: 'no-matching-server'; url: string }
  | { type: 'unavailable' }
  | { type: 'error' };

function lookupShareServer(shareSrv: string): ShareServerLookupResult {
  const { servers, isLoggedIn } = useAuthStore.getState();
  if (!isLoggedIn) {
    return { type: 'not-logged-in' };
  }

  const serverId = findServerIdForShareUrl(servers, shareSrv);
  const server = serverId
    ? servers.find(s => s.id === serverId)
      ?? servers.find(s => serverIndexKeyFromUrl(s.url) === serverId)
    : undefined;
  if (!serverId || !server) {
    return { type: 'no-matching-server', url: shareSrv };
  }

  return { type: 'ok', serverId, server };
}

function activateShareServer(serverId: string): void {
  const { activeServerId, setActiveServer } = useAuthStore.getState();
  if (activeServerId !== serverId) {
    setActiveServer(serverId);
  }
}

export function activateShareSearchServer(shareSrv: string, t: TFunction): boolean {
  const lookup = lookupShareServer(shareSrv);
  if (lookup.type === 'not-logged-in') {
    showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
    return false;
  }
  if (lookup.type === 'no-matching-server') {
    showToast(t('sharePaste.noMatchingServer', { url: lookup.url }), 6000, 'error');
    return false;
  }

  activateShareServer(lookup.serverId);
  return true;
}

async function resolveSharedSong(
  id: string,
  lookup: Extract<ShareServerLookupResult, { type: 'ok' }>,
  options: ShareResolveOptions,
): Promise<SubsonicSong | null> {
  if (options.activateServer) {
    activateShareServer(lookup.serverId);
    return getSong(id);
  }
  return getSongWithCredentials(
    connectBaseUrlForServer(lookup.server),
    lookup.server.username,
    lookup.server.password,
    id,
    lookup.server,
  );
}

async function getAlbumAfterActivation(
  id: string,
  serverId: string,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  activateShareServer(serverId);
  const result = await resolveAlbum(serverId, id);
  if (!result) throw new Error('album unavailable');
  return result;
}

async function getArtistAfterActivation(
  id: string,
  serverId: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  activateShareServer(serverId);
  const result = await resolveArtist(serverId, id);
  if (!result) throw new Error('artist unavailable');
  return result;
}

export async function resolveShareSearchPayload(
  payload: QueueableShareSearchPayload,
  options: ShareResolveOptions = {},
): Promise<ShareSearchResolveResult> {
  const lookup = lookupShareServer(payload.srv);
  if (lookup.type === 'not-logged-in') {
    return { type: 'not-logged-in' };
  }
  if (lookup.type === 'no-matching-server') {
    return { type: 'no-matching-server', url: lookup.url };
  }

  try {
    const ids = payload.k === 'track' ? [payload.id] : payload.ids;
    const resolved: SubsonicSong[] = [];
    for (let i = 0; i < ids.length; i += RESOLVE_QUEUE_CHUNK) {
      const chunk = ids.slice(i, i + RESOLVE_QUEUE_CHUNK);
      const songs = await Promise.all(chunk.map(id => resolveSharedSong(id, lookup, options)));
      for (const song of songs) {
        if (song) resolved.push(song);
      }
    }

    const skipped = ids.length - resolved.length;
    if (resolved.length === 0) {
      return { type: 'all-unavailable' };
    }

    return { type: 'ok', songs: resolved, total: ids.length, skipped };
  } catch {
    return { type: 'error' };
  }
}

export async function resolveShareSearchAlbum(
  payload: AlbumShareSearchPayload,
  options: ShareResolveOptions = {},
): Promise<ShareSearchAlbumResolveResult> {
  const lookup = lookupShareServer(payload.srv);
  if (lookup.type === 'not-logged-in') {
    return { type: 'not-logged-in' };
  }
  if (lookup.type === 'no-matching-server') {
    return { type: 'no-matching-server', url: lookup.url };
  }

  try {
    const { album } = options.activateServer
      ? await getAlbumAfterActivation(payload.id, lookup.serverId)
      : await getAlbumWithCredentials(
          connectBaseUrlForServer(lookup.server),
          lookup.server.username,
          lookup.server.password,
          payload.id,
          lookup.server,
        );
    return { type: 'ok', album };
  } catch {
    return { type: 'unavailable' };
  }
}

export async function resolveShareSearchArtist(
  payload: ArtistShareSearchPayload | ComposerShareSearchPayload,
  options: ShareResolveOptions = {},
): Promise<ShareSearchArtistResolveResult> {
  const lookup = lookupShareServer(payload.srv);
  if (lookup.type === 'not-logged-in') {
    return { type: 'not-logged-in' };
  }
  if (lookup.type === 'no-matching-server') {
    return { type: 'no-matching-server', url: lookup.url };
  }

  try {
    const { artist } = options.activateServer
      ? await getArtistAfterActivation(payload.id, lookup.serverId)
      : await getArtistWithCredentials(
          connectBaseUrlForServer(lookup.server),
          lookup.server.username,
          lookup.server.password,
          payload.id,
          lookup.server,
        );
    return { type: 'ok', artist };
  } catch {
    return { type: 'unavailable' };
  }
}

export async function enqueueShareSearchPayload(
  payload: QueueableShareSearchPayload,
  t: TFunction,
): Promise<boolean> {
  const resolved = await resolveShareSearchPayload(payload, { activateServer: true });
  if (resolved.type === 'not-logged-in') {
    showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
    return false;
  }
  if (resolved.type === 'no-matching-server') {
    showToast(t('sharePaste.noMatchingServer', { url: resolved.url }), 6000, 'error');
    return false;
  }
  if (resolved.type === 'all-unavailable') {
    showToast(
      payload.k === 'track' ? t('sharePaste.trackUnavailable') : t('sharePaste.queueAllUnavailable'),
      payload.k === 'track' ? 5000 : 6000,
      'error',
    );
    return false;
  }
  if (resolved.type === 'error') {
    showToast(t('sharePaste.genericError'), 5000, 'error');
    return false;
  }

  try {
    const tracks: Track[] = resolved.songs.map(songToTrack);
    const okToEnqueue = await orbitBulkGuard(tracks.length);
    if (!okToEnqueue) return false;
    usePlayerStore.getState().enqueue(tracks, true);
    if (resolved.skipped > 0) {
      showToast(
        t('search.shareQueuedPartial', { queued: tracks.length, total: resolved.total, skipped: resolved.skipped }),
        5000,
        'info',
      );
    } else {
      showToast(t('search.shareQueued', { count: tracks.length }), 3000, 'info');
    }
    return true;
  } catch (e) {
    console.error('[psysonic] share search enqueue failed', e);
    showToast(t('sharePaste.genericError'), 5000, 'error');
    return false;
  }
}
