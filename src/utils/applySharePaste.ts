import type { NavigateFunction } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { getAlbum, getArtist, getSong, type SubsonicSong } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import { songToTrack, usePlayerStore } from '../store/playerStore';
import { findServerIdForShareUrl, type SharePayloadV1 } from './shareLink';
import { showToast } from './toast';

const RESOLVE_QUEUE_CHUNK = 12;

/**
 * Switches to the matching server, validates the entity on the server, then
 * plays or navigates. Caller should `preventDefault` on the paste event when
 * the payload was already decoded successfully.
 */
export async function applySharePastePayload(
  payload: SharePayloadV1,
  navigate: NavigateFunction,
  t: TFunction,
): Promise<void> {
  const { servers, isLoggedIn, setActiveServer } = useAuthStore.getState();
  if (!isLoggedIn) {
    showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
    return;
  }

  const serverId = findServerIdForShareUrl(servers, payload.srv);
  if (!serverId) {
    showToast(t('sharePaste.noMatchingServer', { url: payload.srv }), 6000, 'error');
    return;
  }

  if (useAuthStore.getState().activeServerId !== serverId) {
    setActiveServer(serverId);
  }

  try {
    if (payload.k === 'track') {
      const song = await getSong(payload.id);
      if (!song) {
        showToast(t('sharePaste.trackUnavailable'), 5000, 'error');
        return;
      }
      const track = songToTrack(song);
      usePlayerStore.getState().clearQueue();
      usePlayerStore.getState().playTrack(track, [track]);
      showToast(t('sharePaste.openedTrack'), 3000, 'info');
      return;
    }

    if (payload.k === 'album') {
      try {
        await getAlbum(payload.id);
      } catch {
        showToast(t('sharePaste.albumUnavailable'), 5000, 'error');
        return;
      }
      navigate(`/album/${payload.id}`);
      showToast(t('sharePaste.openedAlbum'), 3000, 'info');
      return;
    }

    if (payload.k === 'artist') {
      try {
        await getArtist(payload.id);
      } catch {
        showToast(t('sharePaste.artistUnavailable'), 5000, 'error');
        return;
      }
      navigate(`/artist/${payload.id}`);
      showToast(t('sharePaste.openedArtist'), 3000, 'info');
      return;
    }

    if (payload.k === 'queue') {
      const { ids } = payload;
      if (ids.length === 0) {
        showToast(t('sharePaste.genericError'), 5000, 'error');
        return;
      }
      const resolved: SubsonicSong[] = [];
      for (let i = 0; i < ids.length; i += RESOLVE_QUEUE_CHUNK) {
        const chunk = ids.slice(i, i + RESOLVE_QUEUE_CHUNK);
        const songs = await Promise.all(chunk.map(id => getSong(id)));
        for (let j = 0; j < songs.length; j++) {
          const s = songs[j];
          if (s) resolved.push(s);
        }
      }
      const skipped = ids.length - resolved.length;
      if (resolved.length === 0) {
        showToast(t('sharePaste.queueAllUnavailable'), 6000, 'error');
        return;
      }
      const tracks = resolved.map(songToTrack);
      usePlayerStore.getState().clearQueue();
      usePlayerStore.getState().playTrack(tracks[0]!, tracks);
      if (skipped > 0) {
        showToast(
          t('sharePaste.openedQueuePartial', { played: tracks.length, total: ids.length, skipped }),
          5000,
          'info',
        );
      } else {
        showToast(t('sharePaste.openedQueue', { count: tracks.length }), 3000, 'info');
      }
      return;
    }
  } catch (e) {
    console.error('[psysonic] share paste failed', e);
    showToast(t('sharePaste.genericError'), 5000, 'error');
  }
}
