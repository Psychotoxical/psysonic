/**
 * Identity guarantees for native stream-format and provenance events.
 *
 * The engine resolves a stream's real format asynchronously; by the time the
 * event reaches the frontend the user may have skipped, or a different server
 * may be serving a track that happens to share the same Subsonic id. The
 * resolved format must attach to the track it was resolved for — never to
 * whatever happens to be current when the event lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamCapMock = { kbps: 0 };
vi.mock('@/features/playback/utils/playback/streamQualityResolve', () => ({
  effectiveStreamCapKbps: () => streamCapMock.kbps,
}));
import {
  handleAudioFormat,
  handleAudioStreamProvenance,
} from '@/features/playback/store/audioEventHandlers';
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
  streamCapMock.kbps = 0;
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
    // current per-address setting has since changed to 128. Badge shows 320.
    streamCapMock.kbps = 128;
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', streamCapKbps: 320, codec: 'opus', lossless: false,
    });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(320);
    // A later settings change must not retroactively relabel the open stream.
    streamCapMock.kbps = 64;
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(320);
  });

  it('falls back to a snapshot of the current setting for legacy events without a cap', () => {
    streamCapMock.kbps = 192;
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({ trackId: 'a', serverId: 's1', codec: 'opus', lossless: false });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(192);
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

  it('rejects an old-generation event even after the format state was cleared (replay)', () => {
    // Same-track replay: playTrack clears resolvedStreamFormat, so the guard
    // must NOT depend on that object — the generation floor survives the clear.
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 7, streamCapKbps: null, codec: 'flac', lossless: true,
    });
    // Replay of the same track: format cleared, floor must persist.
    usePlayerStore.setState({ resolvedStreamFormat: null });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 5, streamCapKbps: 128, codec: 'opus', lossless: false,
    });
    expect(usePlayerStore.getState().resolvedStreamFormat).toBeNull();
  });

  it('does NOT relabel an uncapped stream when the engine sends an explicit null cap', () => {
    // Rust `None` serializes as null — that is a REAL "no cap", not a missing
    // legacy field. A current setting of 192 must not be stamped onto it.
    streamCapMock.kbps = 192;
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', streamCapKbps: null, codec: 'flac', lossless: true,
    });
    expect(usePlayerStore.getState().resolvedStreamFormat?.streamCapKbps).toBe(0);
  });
});

describe('audio:stream-provenance event identity', () => {
  it('merges provenance into the exact track/server/generation format', () => {
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 9, codec: 'mp3', lossless: false,
    });

    handleAudioStreamProvenance({
      trackId: 'a', serverId: 's1', generation: 9, provenance: 'transcoded',
    });

    expect(usePlayerStore.getState().resolvedStreamFormat?.provenance).toBe('transcoded');
  });

  it('rejects stale, cross-track, and cross-server provenance events', () => {
    usePlayerStore.setState({ currentTrack: track('a', 's1') });
    handleAudioFormat({
      trackId: 'a', serverId: 's1', generation: 9, codec: 'flac', lossless: true,
    });

    handleAudioStreamProvenance({
      trackId: 'a', serverId: 's1', generation: 8, provenance: 'transcoded',
    });
    handleAudioStreamProvenance({
      trackId: 'b', serverId: 's1', generation: 9, provenance: 'transcoded',
    });
    handleAudioStreamProvenance({
      trackId: 'a', serverId: 's2', generation: 9, provenance: 'transcoded',
    });

    expect(usePlayerStore.getState().resolvedStreamFormat?.provenance).toBeUndefined();
  });
});
