/**
 * Identity guarantees for the `audio:format` event (cucadmuh review, #4).
 *
 * The engine resolves a stream's real format asynchronously; by the time the
 * event reaches the frontend the user may have skipped, or a different server
 * may be serving a track that happens to share the same Subsonic id. The
 * resolved format must attach to the track it was resolved for — never to
 * whatever happens to be current when the event lands.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAudioFormat } from '@/features/playback/store/audioEventHandlers';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetPlayerStore, resetAuthStore } from '@/test/helpers/storeReset';
import type { Track } from '@/lib/media/trackTypes';

function track(id: string, serverId: string): Track {
  return {
    id, title: 't', artist: 'a', album: 'al', albumId: 'alid',
    duration: 100, suffix: 'flac', serverId,
  };
}

beforeEach(() => {
  resetPlayerStore();
  resetAuthStore();
});

describe('audio:format event identity', () => {
  it('attaches the format when it matches the current track', () => {
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({ trackId: 'a', serverId: 's1', codec: 'opus', lossless: false });
    expect(usePlayerStore.getState().resolvedStreamFormat?.trackId).toBe('a');
    expect(usePlayerStore.getState().resolvedStreamFormat?.codec).toBe('opus');
  });

  it('does NOT attach a format resolved for a since-skipped track', () => {
    // Event was resolved for track "a", but the user skipped to "b" first.
    usePlayerStore.setState({ currentTrack: track('b', 's1') });
    handleAudioFormat({ trackId: 'a', serverId: 's1', codec: 'opus', lossless: false });
    expect(usePlayerStore.getState().resolvedStreamFormat).toBeNull();
  });

  it('does NOT attach across servers that share a track id', () => {
    // Same Subsonic id "x", but the current track belongs to a different server.
    usePlayerStore.setState({ currentTrack: track('x', 's2') });
    handleAudioFormat({ trackId: 'x', serverId: 's1', codec: 'opus', lossless: false });
    expect(usePlayerStore.getState().resolvedStreamFormat).toBeNull();
  });

  it('uses the cap latched on the stream by the engine, not the live setting', () => {
    // The stream was opened with maxBitRate=320 (carried in the payload); the
    // user has since flipped the setting to 128. The badge must show 320.
    useAuthStore.getState().setStreamMaxBitRateKbps(128);
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', streamCapKbps: 320, codec: 'opus', lossless: false,
    });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(320);
    // A later settings change must not retroactively relabel the open stream.
    useAuthStore.getState().setStreamMaxBitRateKbps(64);
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(320);
  });

  it('falls back to a snapshot of the current setting for legacy events without a cap', () => {
    useAuthStore.getState().setStreamMaxBitRateKbps(192);
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({ trackId: 'a', serverId: 's1', codec: 'opus', lossless: false });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(192);
  });
});
