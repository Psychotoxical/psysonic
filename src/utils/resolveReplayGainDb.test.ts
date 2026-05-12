/**
 * Pure-helper characterization for `resolveReplayGainDb`.
 *
 * Picks track vs album gain based on mode + adjacent queue neighbours.
 * Originally lived in `playerStore.ts`; extracted in M0 of the frontend
 * refactor (2026-05-12).
 */
import type { Track } from '../store/playerStoreTypes';
import { describe, expect, it } from 'vitest';
import { resolveReplayGainDb } from './resolveReplayGainDb';
describe('resolveReplayGainDb', () => {
  const t = (overrides: Partial<Track> = {}): Track => ({
    id: 'x',
    title: 'x',
    artist: 'x',
    album: 'a',
    albumId: 'a-1',
    duration: 100,
    ...overrides,
  });

  it('returns null when ReplayGain is disabled', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, false, 'track')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, false, 'album')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, false, 'auto')).toBeNull();
  });

  it('mode=track uses the track gain', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, true, 'track')).toBe(-6);
  });

  it('mode=album uses the album gain when present', () => {
    const track = t({ replayGainTrackDb: -6, replayGainAlbumDb: -7 });
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBe(-7);
  });

  it('mode=album falls back to track gain when album is missing', () => {
    const track = t({ replayGainTrackDb: -6 });
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBe(-6);
  });

  it('mode=auto picks album gain when the prev neighbour shares the albumId', () => {
    const track = t({ albumId: 'shared', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const prev = t({ albumId: 'shared' });
    expect(resolveReplayGainDb(track, prev, null, true, 'auto')).toBe(-8);
  });

  it('mode=auto picks album gain when the next neighbour shares the albumId', () => {
    const track = t({ albumId: 'shared', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const next = t({ albumId: 'shared' });
    expect(resolveReplayGainDb(track, null, next, true, 'auto')).toBe(-8);
  });

  it('mode=auto picks track gain when neither neighbour shares the albumId', () => {
    const track = t({ albumId: 'a-1', replayGainTrackDb: -6, replayGainAlbumDb: -8 });
    const other = t({ albumId: 'a-2' });
    expect(resolveReplayGainDb(track, other, other, true, 'auto')).toBe(-6);
  });

  it('mode=auto treats a missing albumId as no-album-match (returns track gain)', () => {
    const track = t({ albumId: '', replayGainTrackDb: -6, replayGainAlbumDb: -8 } as Track);
    const prev = t({ albumId: '' } as Track);
    expect(resolveReplayGainDb(track, prev, null, true, 'auto')).toBe(-6);
  });

  it('returns null when both gains are missing', () => {
    const track = t({});
    expect(resolveReplayGainDb(track, null, null, true, 'track')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, true, 'album')).toBeNull();
    expect(resolveReplayGainDb(track, null, null, true, 'auto')).toBeNull();
  });
});
