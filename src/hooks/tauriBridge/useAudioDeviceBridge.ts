import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';

/** Audio output device lifecycle: device switches (Bluetooth headphones, USB
 * DAC, …) and pinned-device-unplugged fallbacks emitted by the Rust
 * device-watcher. */
export function useAudioDeviceBridge() {
  // Audio output device changed (Bluetooth headphones, USB DAC, etc.)
  // The Rust device-watcher has already reopened the stream on the new device
  // and dropped the old Sink, so we just need to restart playback.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-changed', () => {
      const { currentTrack, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        // Paused: clear warm-pause flag so the next resume uses the cold path
        // (audio_play + seek) which creates a new Sink on the new device.
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Pinned output device was unplugged — Rust already fell back to system default.
  // Clear the stored device so the Settings dropdown resets to "System Default".
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-reset', () => {
      useAuthStore.getState().setAudioOutputDevice(null);
      const { currentTrack, currentTime, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);
}
