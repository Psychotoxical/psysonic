/**
 * Identity guarantees for the `audio:format` event.
 *
 * The engine resolves a stream's real format asynchronously; by the time the
 * event reaches the frontend the user may have skipped, a different server
 * may be serving a track that shares the same Subsonic id, or a superseded
 * playback of the same track may deliver late. The resolved format must
 * attach to the stream it was resolved for — never to whatever happens to be
 * current when the event lands.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handleAudioFormat } from '@/features/playback/store/audioEventHandlers';
import { usePlayerStore } from '@/features/playback/store/playerStore';
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

  it('rejects an older-generation event for the same track (out-of-order delivery)', () => {
    // Same track id + server (replay/repeat): a late event from the PREVIOUS
    // playback generation must not overwrite the current stream's format.
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 7, streamCapKbps: null, codec: 'flac', lossless: true,
    });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 5, streamCapKbps: 128, codec: 'opus', lossless: false,
    });
    const fmt = usePlayerStore.getState().resolvedStreamFormat;
    expect(fmt?.codec).toBe('flac');
  });

  it('treats an absent or explicit-null cap as a real "no cap"', () => {
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', streamCapKbps: null, codec: 'flac', lossless: true,
    });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(0);
  });
});
