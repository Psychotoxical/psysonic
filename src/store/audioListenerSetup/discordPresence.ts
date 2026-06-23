import { invoke } from '@tauri-apps/api/core';
import { resolvePlaybackCoverScope } from '../../cover/ref';
import { resolveTrackCoverRefFromLibrary } from '../../cover/resolveEntryLibrary';
import { coverArtUrlForDiscord } from '../../cover/integrations/discord';
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
  let discordPrevTemplateDetails: string | null = null;
  let discordPrevTemplateState: string | null = null;
  let discordPrevTemplateLargeText: string | null = null;
  let discordPrevTemplateName: string | null = null;
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
      discordTemplateName,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevCoverSource = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        discordPrevTemplateName = null;
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
    const nameTemplateChanged = discordTemplateName !== discordPrevTemplateName;
    if (!trackChanged && !playingChanged && !coverSourceChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged && !nameTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevCoverSource = discordCoverSource;
    discordPrevTemplateDetails = discordTemplateDetails;
    discordPrevTemplateState = discordTemplateState;
    discordPrevTemplateLargeText = discordTemplateLargeText;
    discordPrevTemplateName = discordTemplateName;

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
        nameTemplate: discordTemplateName,
      }).catch(() => {});
    };

    if (discordCoverSource === 'server' && currentTrack.coverArt) {
      const cacheKey = currentTrack.coverArt;
      const cached = discordServerCoverCache.get(cacheKey);
      if (cached !== undefined) {
        sendPresence(cached);
      } else {
        void resolveTrackCoverRefFromLibrary(
          {
            id: currentTrack.id,
            albumId: currentTrack.albumId,
            coverArt: currentTrack.coverArt,
            discNumber: (currentTrack as { discNumber?: number }).discNumber,
          },
          resolvePlaybackCoverScope(),
        ).then(ref => {
          if (!ref) {
            sendPresence(null);
            return;
          }
          return coverArtUrlForDiscord(ref)
            .then(url => {
              discordServerCoverCache.set(cacheKey, url);
              sendPresence(url);
            })
            .catch(() => {
              discordServerCoverCache.set(cacheKey, null);
              sendPresence(null);
            });
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
