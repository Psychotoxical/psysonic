import { getSongForServer } from '@/lib/api/subsonicLibrary';
import { resolveAlbum, resolveArtist } from '@/features/offline';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Location, NavigateFunction } from 'react-router';
import type { TFunction } from 'i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { navigateToAlbumDetail } from '@/lib/navigation/albumDetailNavigation';
import type { EntitySharePayloadV1 } from '@/lib/share/shareLink';
import { showToast } from '@/lib/dom/toast';
import {
  buildAlbumDetailPath,
  buildArtistDetailPath,
  buildComposerDetailPath,
} from '@/lib/navigation/detailServerScope';
import { activateShareServer, lookupShareServer } from '@/features/share/shareServerResolution';

const RESOLVE_QUEUE_CHUNK = 12;

type SharePasteQueuePayload = Extract<EntitySharePayloadV1, { k: 'queue' }>;

async function resolveSharePasteQueueSongs(
  serverId: string,
  ids: string[],
): Promise<{ songs: SubsonicSong[]; skipped: number } | null> {
  if (ids.length === 0) return null;

  const resolved: SubsonicSong[] = [];
  for (let i = 0; i < ids.length; i += RESOLVE_QUEUE_CHUNK) {
    const chunk = ids.slice(i, i + RESOLVE_QUEUE_CHUNK);
    const songs = await Promise.all(chunk.map(id => getSongForServer(serverId, id)));
    for (const s of songs) {
      if (s) resolved.push(s);
    }
  }

  const skipped = ids.length - resolved.length;
  if (resolved.length === 0) return null;
  return { songs: resolved, skipped };
}

/**
 * Switches to the matching server, resolves queue track ids, then replaces the
 * queue and starts playback. Used after the queue preview modal on global paste.
 */
export async function applySharePasteQueue(
  payload: SharePasteQueuePayload,
  t: TFunction,
): Promise<boolean> {
  const lookup = lookupShareServer(payload.srv);
  if (lookup.type === 'not-logged-in') {
    showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
    return false;
  }
  if (lookup.type === 'no-matching-server') {
    showToast(t('sharePaste.noMatchingServer', { url: lookup.url }), 6000, 'error');
    return false;
  }

  try {
    const result = await resolveSharePasteQueueSongs(lookup.serverId, payload.ids);
    if (!result) {
      showToast(t('sharePaste.queueAllUnavailable'), 6000, 'error');
      return false;
    }

    const tracks = result.songs.map(songToTrack);
    activateShareServer(lookup.serverId);
    usePlayerStore.getState().clearQueue();
    usePlayerStore.getState().playTrack(tracks[0]!, tracks);
    if (result.skipped > 0) {
      showToast(
        t('sharePaste.openedQueuePartial', {
          played: tracks.length,
          total: payload.ids.length,
          skipped: result.skipped,
        }),
        5000,
        'info',
      );
    } else {
      showToast(t('sharePaste.openedQueue', { count: tracks.length }), 3000, 'info');
    }
    return true;
  } catch (e) {
    console.error('[psysonic] share paste queue failed', e);
    showToast(t('sharePaste.genericError'), 5000, 'error');
    return false;
  }
}

/**
 * Switches to the matching server, validates the entity on the server, then
 * plays or navigates. Caller should `preventDefault` on the paste event when
 * the payload was already decoded successfully.
 */
export async function applySharePastePayload(
  payload: EntitySharePayloadV1,
  navigate: NavigateFunction,
  t: TFunction,
  location?: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
): Promise<void> {
  const lookup = lookupShareServer(payload.srv);
  if (lookup.type === 'not-logged-in') {
    showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
    return;
  }
  if (lookup.type === 'no-matching-server') {
    showToast(t('sharePaste.noMatchingServer', { url: lookup.url }), 6000, 'error');
    return;
  }

  try {
    if (payload.k === 'track') {
      const song = await getSongForServer(lookup.serverId, payload.id);
      if (!song) {
        showToast(t('sharePaste.trackUnavailable'), 5000, 'error');
        return;
      }
      const track = songToTrack(song);
      activateShareServer(lookup.serverId);
      usePlayerStore.getState().clearQueue();
      usePlayerStore.getState().playTrack(track, [track]);
      showToast(t('sharePaste.openedTrack'), 3000, 'info');
      return;
    }

    if (payload.k === 'album') {
      const albumResult = await resolveAlbum(lookup.serverId, payload.id);
      if (!albumResult) {
        showToast(t('sharePaste.albumUnavailable'), 5000, 'error');
        return;
      }
      activateShareServer(lookup.serverId);
      if (location) {
        navigateToAlbumDetail(navigate, location, payload.id, { serverId: lookup.serverId });
      } else {
        navigate(buildAlbumDetailPath(payload.id, { serverId: lookup.serverId }));
      }
      showToast(t('sharePaste.openedAlbum'), 3000, 'info');
      return;
    }

    if (payload.k === 'artist') {
      const artistResult = await resolveArtist(lookup.serverId, payload.id);
      if (!artistResult) {
        showToast(t('sharePaste.artistUnavailable'), 5000, 'error');
        return;
      }
      activateShareServer(lookup.serverId);
      navigate(buildArtistDetailPath(payload.id, { serverId: lookup.serverId }));
      showToast(t('sharePaste.openedArtist'), 3000, 'info');
      return;
    }

    if (payload.k === 'composer') {
      // Same id space as artists (Subsonic / Navidrome use one id pool for
      // every participant role), so resolveArtist still validates the entity —
      // the difference is which view we navigate to.
      const composerResult = await resolveArtist(lookup.serverId, payload.id);
      if (!composerResult) {
        showToast(t('sharePaste.composerUnavailable'), 5000, 'error');
        return;
      }
      activateShareServer(lookup.serverId);
      navigate(buildComposerDetailPath(payload.id, { serverId: lookup.serverId }));
      showToast(t('sharePaste.openedComposer'), 3000, 'info');
      return;
    }

    if (payload.k === 'queue') {
      await applySharePasteQueue(payload, t);
      return;
    }
  } catch (e) {
    console.error('[psysonic] share paste failed', e);
    showToast(t('sharePaste.genericError'), 5000, 'error');
  }
}
