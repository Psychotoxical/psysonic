import { invoke } from '@tauri-apps/api/core';
import { getAlbumInfo2 } from '../../api/subsonicAlbumInfo';
import { useAuthStore } from '../authStore';
import { usePlayerStore } from '../playerStore';
import { getPlaybackProgressSnapshot } from '../playbackProgress';

/**
 * Discord Rich Presence sync. Updates on track change or play/pause toggle —
 * no per-tick updates needed, Discord auto-counts up the elapsed timer from the
 * start_timestamp we set. Returns a cleanup function.
 */
export function setupDiscordPresence(): () => void {
  let discordPrevTrackId: string | null = null;
  let discordPrevIsPlaying: boolean | null = null;
  let discordPrevFetchCovers: boolean | null = null;
  let discordPrevTemplateDetails: string | null = null;
  let discordPrevTemplateState: string | null = null;
  let discordPrevTemplateLargeText: string | null = null;
  let discordPrevCoverSource: string | null = null;
  const discordServerCoverCache = new Map<string, string | null>();

  function syncDiscord() {
    const { currentTrack, isPlaying } = usePlayerStore.getState();
    const currentTime = getPlaybackProgressSnapshot().currentTime;
    const {
      discordRichPresence,
      discordCoverSource,
      discordTemplateDetails,
      discordTemplateState,
      discordTemplateLargeText,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevFetchCovers = null;
        discordPrevCoverSource = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        invoke('discord_clear_presence').catch(() => {});
      }
      return;
    }

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    const coverSourceChanged = discordCoverSource !== discordPrevCoverSource;
    const detailsTemplateChanged = discordTemplateDetails !== discordPrevTemplateDetails;
    const stateTemplateChanged = discordTemplateState !== discordPrevTemplateState;
    const largeTextTemplateChanged = discordTemplateLargeText !== discordPrevTemplateLargeText;
    if (!trackChanged && !playingChanged && !coverSourceChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevFetchCovers = discordCoverSource === 'apple';
    discordPrevCoverSource = discordCoverSource;
    discordPrevTemplateDetails = discordTemplateDetails;
    discordPrevTemplateState = discordTemplateState;
    discordPrevTemplateLargeText = discordTemplateLargeText;

    const sendPresence = (coverArtUrl: string | null) => {
      invoke('discord_update_presence', {
        title: currentTrack.title,
        artist: currentTrack.artist ?? 'Unknown Artist',
        album: currentTrack.album ?? null,
        isPlaying,
        elapsedSecs: isPlaying ? currentTime : null,
        coverArtUrl,
        fetchItunesCovers: discordCoverSource === 'apple',
        detailsTemplate: discordTemplateDetails,
        stateTemplate: discordTemplateState,
        largeTextTemplate: discordTemplateLargeText,
      }).catch(() => {});
    };

    if (discordCoverSource === 'server' && currentTrack.albumId) {
      const cached = discordServerCoverCache.get(currentTrack.albumId);
      if (cached !== undefined) {
        sendPresence(cached);
      } else {
        getAlbumInfo2(currentTrack.albumId).then(info => {
          const url = info?.largeImageUrl || info?.mediumImageUrl || info?.smallImageUrl || null;
          discordServerCoverCache.set(currentTrack.albumId, url);
          sendPresence(url);
        });
      }
    } else {
      sendPresence(null);
    }
  }

  const unsubDiscordPlayer = usePlayerStore.subscribe(syncDiscord);
  const unsubDiscordAuth = useAuthStore.subscribe(syncDiscord);

  return () => {
    unsubDiscordPlayer();
    unsubDiscordAuth();
  };
}
