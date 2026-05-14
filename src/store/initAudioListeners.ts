import { setupAudioEngineListeners } from './audioListenerSetup/audioEngineListeners';
import { runInitialAudioSync } from './audioListenerSetup/initialAudioSync';
import { setupAuthSync } from './audioListenerSetup/authSyncListener';
import { setupMprisSync } from './audioListenerSetup/mprisSync';
import { setupRadioMprisMetadata } from './audioListenerSetup/radioMprisMetadata';
import { setupDiscordPresence } from './audioListenerSetup/discordPresence';

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

  return () => {
    stopAuthSync();
    stopMprisSync();
    stopDiscordPresence();
    stopEngineListeners();
    stopRadioMprisMetadata();
  };
}
