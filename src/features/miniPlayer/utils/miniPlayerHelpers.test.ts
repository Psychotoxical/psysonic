import { describe, expect, it } from 'vitest';
import { toMini } from '@/features/miniPlayer/utils/miniPlayerHelpers';
import type { Track } from '@/lib/media/trackTypes';

describe('miniPlayerHelpers', () => {
  it('preserves track ownership and artist refs in the mini transport mapper', () => {
    const track: Track = {
      id: 'track-1',
      title: 'Track',
      artist: 'Primary',
      artists: [{ id: 'artist-1', name: 'Primary' }, { id: 'artist-2', name: 'Guest' }],
      artistId: 'artist-1',
      album: 'Album',
      albumId: 'album-1',
      duration: 120,
      serverId: 'srv-owner',
    };

    expect(toMini(track)).toEqual(expect.objectContaining({
      id: 'track-1',
      artistId: 'artist-1',
      serverId: 'srv-owner',
      artists: track.artists,
    }));
  });

  it('keeps a legacy flat credit (no structured artists) intact for the mini to split', () => {
    // Legacy flat track: the bulk initial-sync path stores only the joined
    // artist string plus the primary artistId — no structured `artists` array.
    // The credit reaches the mini flat, where the render-time fallback path
    // (resolveTrackArtistRefs) splits it into individual artist links.
    const track: Track = {
      id: 'track-2',
      title: 'Legacy Track',
      artist: 'Primary feat. Guest',
      artistId: 'artist-1',
      album: 'Album',
      albumId: 'album-1',
      duration: 120,
      serverId: 'srv-owner',
    };

    expect(toMini(track)).toEqual(expect.objectContaining({
      id: 'track-2',
      artist: 'Primary feat. Guest',
      artistId: 'artist-1',
      serverId: 'srv-owner',
    }));
    // No structured performers on the source → the mini transport carries no
    // `artists` array, so the joined string survives for client-side splitting.
    expect(toMini(track).artists).toBeUndefined();
  });
});
