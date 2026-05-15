import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { getSimilarSongs2, getSimilarSongs, getTopSongs } from '../../api/subsonicArtists';
import { filterSongsForLuckyMixRatings, getMixMinRatingsConfigFromAuth } from '../mix/mixRatingFilter';
import { buildDownloadUrl } from '../../api/subsonicStreamUrl';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../store/playerStoreTypes';
import { useZipDownloadStore } from '../../store/zipDownloadStore';
import { useDownloadModalStore } from '../../store/downloadModalStore';
import type { EntityShareKind } from '../share/shareLink';
import { copyEntityShareLink } from '../share/copyEntityShareLink';
import { sanitizeFilename, shuffleArray } from './contextMenuHelpers';
import { songToTrack } from '../playback/songToTrack';
import { showToast } from '../ui/toast';

export async function copyShareLink(
  kind: EntityShareKind,
  id: string,
  t: (key: string) => string,
) {
  const ok = await copyEntityShareLink(kind, id);
  if (ok) showToast(t('contextMenu.shareCopied'));
  else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
}

export async function startRadio(
  artistId: string,
  artistName: string,
  playTrack: (track: Track, queue: Track[]) => void,
  seedTrack?: Track,
) {
  if (seedTrack) {
    const state = usePlayerStore.getState();
    if (state.currentTrack?.id === seedTrack.id) {
      if (!state.isPlaying) state.resume();
    } else {
      playTrack(seedTrack, [seedTrack]);
    }
    try {
      const [similar, top] = await Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)]);
      const similarTracks = shuffleArray(
        similar.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const })),
      );
      const radioTracks = similarTracks.length > 0
        ? similarTracks
        : shuffleArray(
            top.map(songToTrack).filter(t => t.id !== seedTrack.id).map(t => ({ ...t, radioAdded: true as const })),
          );
      if (radioTracks.length > 0) usePlayerStore.getState().enqueueRadio(radioTracks, artistId);
    } catch (e) {
      console.error('Failed to load radio queue', e);
    }
    return;
  }

  // Artist radio without seed
  const similarPromise = getSimilarSongs2(artistId).catch(() => [] as Awaited<ReturnType<typeof getSimilarSongs2>>);
  try {
    const top = await getTopSongs(artistName);
    const topTracks = shuffleArray(
      top.map(t => ({ ...songToTrack(t), radioAdded: true as const })),
    );
    if (topTracks.length === 0) {
      const similar = await similarPromise;
      const fallback = shuffleArray(
        similar.map(t => ({ ...songToTrack(t), radioAdded: true as const })),
      );
      if (fallback.length === 0) return;
      const state = usePlayerStore.getState();
      if (state.currentTrack) {
        state.enqueueRadio(fallback, artistId);
      } else {
        state.setRadioArtistId(artistId);
        playTrack(fallback[0], fallback);
      }
      return;
    }
    const state = usePlayerStore.getState();
    if (state.currentTrack) {
      state.enqueueRadio([topTracks[0]], artistId);
    } else {
      state.setRadioArtistId(artistId);
      playTrack(topTracks[0], [topTracks[0]]);
    }
    similarPromise.then(similar => {
      const similarTracks = shuffleArray(
        similar
          .map(t => ({ ...songToTrack(t), radioAdded: true as const }))
          .filter(t => t.id !== topTracks[0].id),
      );
      if (similarTracks.length === 0) return;
      const { queue, queueIndex } = usePlayerStore.getState();
      const pendingRadio = queue.slice(queueIndex + 1).filter(t => t.radioAdded);
      usePlayerStore.getState().enqueueRadio([...pendingRadio, ...similarTracks], artistId);
    });
  } catch (e) {
    console.error('Failed to start radio', e);
  }
}

export async function startInstantMix(
  song: Track,
  t: (key: string) => string,
) {
  usePlayerStore.getState().reseedQueueForInstantMix(song);
  const serverId = useAuthStore.getState().activeServerId;
  try {
    const similar = await getSimilarSongs(song.id, 50);
    if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
    const mixCfg = getMixMinRatingsConfigFromAuth();
    const ratedFiltered = await filterSongsForLuckyMixRatings(
      similar.filter(s => s.id !== song.id),
      mixCfg,
    );
    const shuffled = shuffleArray(
      ratedFiltered.map(s => ({ ...songToTrack(s), radioAdded: true as const })),
    );
    if (shuffled.length > 0) {
      const aid = song.artistId?.trim() || undefined;
      usePlayerStore.getState().enqueueRadio(shuffled, aid);
    }
  } catch (e) {
    console.error('Instant mix failed', e);
    if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
    showToast(t('contextMenu.instantMixFailed'), 5000, 'error');
  }
}

export async function downloadAlbum(albumName: string, albumId: string) {
  const auth = useAuthStore.getState();
  const requestDownloadFolder = useDownloadModalStore.getState().requestFolder;
  const folder = auth.downloadFolder || await requestDownloadFolder();
  if (!folder) return;

  const filename = `${sanitizeFilename(albumName)}.zip`;
  const destPath = await join(folder, filename);
  const url = buildDownloadUrl(albumId);
  const id = crypto.randomUUID();

  const { start, complete, fail } = useZipDownloadStore.getState();
  start(id, filename);
  try {
    await invoke('download_zip', { id, url, destPath });
    complete(id);
  } catch (e) {
    fail(id);
    console.error('ZIP download failed:', e);
  }
}
