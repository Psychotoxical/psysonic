import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { _resetNormalizationIpcDedupeForTest } from '@/features/playback/store/normalizationIpcDedupe';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

// Scenario: normalization mode × track change. When the runtime (re)binds the
// current track, `updateReplayGainForCurrentTrack` derives the live normalization
// mode from the auth setting and pushes the matching gain to the engine:
//  - off        → engine 'off',        no ReplayGain pushed;
//  - replaygain → engine 'replaygain', the track's tag dB pushed;
//  - loudness   → engine 'loudness',   target LUFS surfaced, no ReplayGain.
// Observable = the store's normalizationEngineLive + the audio_update_replay_gain
// payload.

const TRACK_GAIN_DB = -6;

function lastReplayGainCall(): { replayGainDb: number | null; loudnessGainDb: number | null } | undefined {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'audio_update_replay_gain');
  return calls.length
    ? (calls[calls.length - 1][1] as { replayGainDb: number | null; loudnessGainDb: number | null })
    : undefined;
}

beforeEach(() => {
  resetAllStores();
  _resetNormalizationIpcDedupeForTest();
  onInvoke('audio_update_replay_gain', () => undefined);
  seedQueue([makeTrack({ id: 'cur', replayGainTrackDb: TRACK_GAIN_DB })], { index: 0 });
});

describe('normalization mode × track change', () => {
  it('off → engine off, no gain pushed', () => {
    useAuthStore.setState({ normalizationEngine: 'off' });
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
    expect(usePlayerStore.getState().normalizationEngineLive).toBe('off');
    expect(lastReplayGainCall()?.replayGainDb).toBeNull();
  });

  it('replaygain → engine replaygain, the track tag dB pushed', () => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
      replayGainMode: 'auto',
      replayGainPreGainDb: 0,
    });
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
    expect(usePlayerStore.getState().normalizationEngineLive).toBe('replaygain');
    expect(lastReplayGainCall()?.replayGainDb).toBe(TRACK_GAIN_DB);
  });

  it('replaygain mode but disabled → engine off, no gain', () => {
    useAuthStore.setState({ normalizationEngine: 'replaygain', replayGainEnabled: false });
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
    expect(usePlayerStore.getState().normalizationEngineLive).toBe('off');
    expect(lastReplayGainCall()?.replayGainDb).toBeNull();
  });

  it('loudness → engine loudness, target LUFS surfaced, no ReplayGain', () => {
    useAuthStore.setState({ normalizationEngine: 'loudness', loudnessTargetLufs: -14 });
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
    expect(usePlayerStore.getState().normalizationEngineLive).toBe('loudness');
    expect(usePlayerStore.getState().normalizationTargetLufs).toBe(-14);
    // No ReplayGain in loudness mode; loudness gain comes from the cache (unseeded → null).
    expect(lastReplayGainCall()?.replayGainDb).toBeNull();
    expect(lastReplayGainCall()?.loudnessGainDb).toBeNull();
  });
});
