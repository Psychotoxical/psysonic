import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetScrobblePlaySessionForTest,
  beginScrobblePlay,
  scrobblePlayStartedAtMs,
} from './scrobblePlaySession';

describe('scrobble play session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    _resetScrobblePlaySessionForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the original play-start timestamp for the same track and server', () => {
    beginScrobblePlay('track-a', 'server-a');
    vi.setSystemTime(25_000);

    expect(scrobblePlayStartedAtMs('track-a', 'server-a', 15)).toBe(10_000);
  });

  it('derives a safe start timestamp when no matching session exists', () => {
    expect(scrobblePlayStartedAtMs('track-b', 'server-b', 4)).toBe(6_000);
  });
});
