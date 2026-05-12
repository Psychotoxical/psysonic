/**
 * Playback-URL routing characterization. The non-trivial behaviour is
 * (a) the module-scoped `lastOpenedWithHttpTrackId` only persists for HTTP
 * URLs (offline / hot-cache plays clear it), (b) the rebind check matches
 * across the `stream:` / bare id forms, and (c) the source-kind classifier
 * picks 'offline' vs 'hot' only when the offline store actually has a local
 * URL for the track.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { offlineStoreState } = vi.hoisted(() => ({
  offlineStoreState: { localUrlByKey: new Map<string, string>() },
}));

vi.mock('./offlineStore', () => ({
  useOfflineStore: {
    getState: () => ({
      getLocalUrl: (trackId: string, serverId: string) =>
        offlineStoreState.localUrlByKey.get(`${serverId}:${trackId}`) ?? null,
    }),
  },
}));

vi.mock('../utils/resolvePlaybackUrl', () => ({
  resolvePlaybackUrl: vi.fn((trackId: string, serverId: string) => {
    if (offlineStoreState.localUrlByKey.has(`${serverId}:${trackId}`)) {
      return `psysonic-local://${serverId}/${trackId}`;
    }
    return `https://mock/${serverId}/${trackId}`;
  }),
}));

import {
  _resetPlaybackUrlRoutingForTest,
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
  shouldRebindPlaybackToHotCache,
} from './playbackUrlRouting';

beforeEach(() => {
  offlineStoreState.localUrlByKey.clear();
});

afterEach(() => {
  _resetPlaybackUrlRoutingForTest();
});

describe('playbackSourceHintForResolvedUrl', () => {
  it("classifies non-local URLs as 'stream'", () => {
    expect(playbackSourceHintForResolvedUrl('t1', 'srv', 'https://mock/srv/t1')).toBe('stream');
  });

  it("classifies psysonic-local:// as 'offline' when the offline store has the file", () => {
    offlineStoreState.localUrlByKey.set('srv:t1', 'file:///cache/t1.mp3');
    expect(playbackSourceHintForResolvedUrl('t1', 'srv', 'psysonic-local://srv/t1')).toBe('offline');
  });

  it("classifies psysonic-local:// as 'hot' when no offline copy exists", () => {
    expect(playbackSourceHintForResolvedUrl('t1', 'srv', 'psysonic-local://srv/t1')).toBe('hot');
  });
});

describe('recordEnginePlayUrl + shouldRebindPlaybackToHotCache', () => {
  it('records HTTP URLs and rebinds when the resolved URL later goes local', () => {
    recordEnginePlayUrl('t1', 'https://mock/srv/t1');
    offlineStoreState.localUrlByKey.set('srv:t1', 'file:///cache/t1.mp3');
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(true);
  });

  it('does not rebind when the recorded URL was already local', () => {
    recordEnginePlayUrl('t1', 'psysonic-local://srv/t1');
    offlineStoreState.localUrlByKey.set('srv:t1', 'file:///cache/t1.mp3');
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(false);
  });

  it('matches the recorded id across the stream: prefix', () => {
    recordEnginePlayUrl('stream:t1', 'https://mock/srv/stream:t1');
    offlineStoreState.localUrlByKey.set('srv:t1', 'file:///cache/t1.mp3');
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(true);
  });

  it('returns false for a different track id', () => {
    recordEnginePlayUrl('t1', 'https://mock/srv/t1');
    offlineStoreState.localUrlByKey.set('srv:t2', 'file:///cache/t2.mp3');
    expect(shouldRebindPlaybackToHotCache('t2', 'srv')).toBe(false);
  });

  it('returns false when serverId is empty', () => {
    recordEnginePlayUrl('t1', 'https://mock/srv/t1');
    expect(shouldRebindPlaybackToHotCache('t1', '')).toBe(false);
  });

  it('returns false when nothing has been recorded yet', () => {
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(false);
  });

  it('returns false when the resolved URL is still HTTP (no hot-cache entry)', () => {
    recordEnginePlayUrl('t1', 'https://mock/srv/t1');
    // No entry in offlineStoreState → resolvePlaybackUrl mock returns https://...
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(false);
  });
});

describe('_resetPlaybackUrlRoutingForTest', () => {
  it('clears the recorded id', () => {
    recordEnginePlayUrl('t1', 'https://mock/srv/t1');
    _resetPlaybackUrlRoutingForTest();
    offlineStoreState.localUrlByKey.set('srv:t1', 'file:///cache/t1.mp3');
    expect(shouldRebindPlaybackToHotCache('t1', 'srv')).toBe(false);
  });
});
