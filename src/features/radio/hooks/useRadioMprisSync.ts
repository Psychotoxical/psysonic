import { useEffect, useRef } from 'react';
import { mprisSetMetadata } from '@/lib/api/mpris';
import type { InternetRadioStation } from '@/lib/api/subsonicTypes';
import type { RadioMetadata } from '@/features/radio/hooks/useRadioMetadata';

/**
 * Internet radio → OS media controls (MPRIS / SMTC / Now Playing).
 *
 * Internet-radio playback runs through the WebView `<audio>` element
 * (`radioPlayer.ts`). WebKitGTK auto-registers its **own** MPRIS player for that
 * element, and on Linux desktops the OS overlay shows *that* player — not the
 * souvlaki one we drive from Rust. With no metadata fed to it, it just shows the
 * app name ("Psysonic") and never updates per track (issue #816, verified via
 * D-Bus: the visible player is `org.mpris.MediaPlayer2.org.webkit.*`).
 *
 * The fix is to feed WebKit's player through the standard W3C
 * `navigator.mediaSession` API — the same channel browsers use to surface
 * `<audio>`/`<video>` metadata to the OS. We also mirror to the souvlaki
 * controls (`mpris_set_metadata`) so desktops that surface *that* player instead
 * stay correct too. `useRadioMetadata` already resolves per-track title/artist
 * for the in-app UI, so we just forward the same values.
 *
 * Mount exactly once (in the always-present `PlayerBar`). When the station
 * sends no track metadata, the station-name push from `mprisSync` is left in
 * place — no regression for metadata-less stations.
 */
export function useRadioMprisSync(
  radioMeta: RadioMetadata,
  currentRadio: InternetRadioStation | null,
): void {
  const lastPushedRef = useRef<string | null>(null);

  useEffect(() => {
    const ms: MediaSession | undefined =
      typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;

    if (!currentRadio) {
      lastPushedRef.current = null;
      return;
    }
    // No resolved track yet → keep the station-name push from mprisSync.
    if (radioMeta.source === 'none' || !radioMeta.currentTitle) return;

    const title = radioMeta.currentTitle;
    const artist = radioMeta.currentArtist || currentRadio.name;
    const album = radioMeta.currentAlbum || undefined;
    const artUrl = radioMeta.currentArt || undefined;

    const key = `${currentRadio.id}|${title}|${artist}|${artUrl ?? ''}`;
    if (lastPushedRef.current === key) return;
    lastPushedRef.current = key;

    // Primary path on Linux/WebKit: populate WebKit's own MPRIS player.
    if (ms && typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: artUrl ? [{ src: artUrl }] : undefined,
      });
      ms.playbackState = 'playing';
    }

    // Mirror to the souvlaki-backed controls for desktops that surface those.
    mprisSetMetadata({
      title,
      artist,
      album: album ?? null,
      coverUrl: artUrl ?? null,
      durationSecs: radioMeta.duration ?? null,
    }).catch(() => {});
  }, [
    currentRadio,
    radioMeta.source,
    radioMeta.currentTitle,
    radioMeta.currentArtist,
    radioMeta.currentAlbum,
    radioMeta.currentArt,
    radioMeta.duration,
  ]);
}
