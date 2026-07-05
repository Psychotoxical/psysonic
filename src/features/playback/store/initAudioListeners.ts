import { setupAudioEngineListeners } from '@/features/playback/store/audioListenerSetup/audioEngineListeners';
import { runInitialAudioSync } from '@/features/playback/store/audioListenerSetup/initialAudioSync';
import { setupAuthSync } from '@/features/playback/store/audioListenerSetup/authSyncListener';
import { setupMprisSync } from '@/features/playback/store/audioListenerSetup/mprisSync';
import { setupRadioMprisMetadata } from '@/features/playback/store/audioListenerSetup/radioMprisMetadata';
import { setupDiscordPresence } from '@/features/playback/store/audioListenerSetup/discordPresence';
import { setupEqDeviceSync } from '@/features/playback/store/audioListenerSetup/eqDeviceSync';

/**
 * Set up Tauri event listeners for the Rust audio engine.
 * Returns a cleanup function — pass it to useEffect's return value so that
 * React StrictMode (which double-invokes effects in dev) tears down the first
 * set of listeners before creating the second, avoiding duplicate handlers.
 *
 * Each concern lives in its own module under `audioListenerSetup/`; this
 * function just composes them in the original setup / teardown order.
 */
export function initAudioListeners(): () => void {
  const stopEngineListeners = setupAudioEngineListeners();
  runInitialAudioSync();
  const stopAuthSync = setupAuthSync();
  const stopMprisSync = setupMprisSync();
  const stopRadioMprisMetadata = setupRadioMprisMetadata();
  const stopDiscordPresence = setupDiscordPresence();
  const stopEqDeviceSync = setupEqDeviceSync();

  return () => {
    stopAuthSync();
    stopMprisSync();
    stopDiscordPresence();
    stopEngineListeners();
    stopRadioMprisMetadata();
    stopEqDeviceSync();
  };
}
