import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { getPlaybackProgressSnapshot } from '@/features/playback/store/playbackProgress';
import { resolveServerCoverForDiscord } from '@/cover/integrations/discord';
import { serverShareBaseUrl } from '@/lib/server/serverEndpoint';
import { playbackServerDiffersFromActive } from '@/features/playback/utils/playback/playbackServer';

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
  let discordPrevShareBase: string | null = null;

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
      servers,
      activeServerId,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevCoverSource = null;
        discordPrevShareBase = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        discordPrevTemplateName = null;
        commands.discordClearPresence().catch(() => {});
      }
      return;
    }

    // Computed unconditionally (cheap: one array find + a URL normalize) so a
    // profile edit (fixing a LAN-only address to a public one, say) is caught
    // by shareBaseChanged below even when track/play-state/cover-source/
    // templates are all unchanged — the 'server' branch further down needs
    // this value regardless, so there is no second `getState()` read for it.
    const profile = servers.find(s => s.id === activeServerId);
    const shareBase = profile ? serverShareBaseUrl(profile) : null;

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    const coverSourceChanged = discordCoverSource !== discordPrevCoverSource;
    const shareBaseChanged = discordCoverSource === 'server' && shareBase !== discordPrevShareBase;
    const detailsTemplateChanged = discordTemplateDetails !== discordPrevTemplateDetails;
    const stateTemplateChanged = discordTemplateState !== discordPrevTemplateState;
    const largeTextTemplateChanged = discordTemplateLargeText !== discordPrevTemplateLargeText;
    const nameTemplateChanged = discordTemplateName !== discordPrevTemplateName;
    if (!trackChanged && !playingChanged && !coverSourceChanged && !shareBaseChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged && !nameTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevCoverSource = discordCoverSource;
    discordPrevShareBase = shareBase;
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

    // 'apple' is resolved Rust-side via the fetchItunesCovers flag above.
    // 'none' shows just the app icon. 'server' resolves here via the
    // credential-blind getAlbumInfo2 resolver (cover/integrations/discord.ts)
    // — it never sees server auth, unlike the removed builder that leaked the
    // authenticated Subsonic getCoverArt URL (u/t/s) through Discord's public
    // external image proxy (PR #1246). The Rust command re-validates whatever
    // URL arrives here before it ever reaches Discord (defense in depth).
    //
    // getAlbumInfo2 always queries the *active* server (subsonicClient's api()
    // has no per-call server override), so a mixed-server queue whose playing
    // track isn't from the active server would otherwise ask the wrong server
    // for that album id. Skip the server lookup — and fall back to the app
    // icon — for that case rather than risk a wrong or 404ing cover.
    if (discordCoverSource === 'server' && currentTrack.albumId && !playbackServerDiffersFromActive()) {
      const trackId = currentTrack.id;
      void resolveServerCoverForDiscord(currentTrack.albumId, shareBase).then(url => {
        // Staleness guard: the resolve is async — drop it if playback moved on,
        // Rich Presence got disabled, or the cover source changed away from
        // 'server' while the request was in flight.
        const latest = useAuthStore.getState();
        if (usePlayerStore.getState().currentTrack?.id !== trackId) return;
        if (!latest.discordRichPresence || latest.discordCoverSource !== 'server') return;
        sendPresence(url);
      });
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
