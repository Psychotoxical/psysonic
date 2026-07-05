import { describe, expect, it } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';
import { primaryTrackArtistRef, resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';

describe('resolveTrackArtistRefs', () => {
  it('prefers OpenSubsonic artists[] when present', () => {
    const refs = [{ id: 'a1', name: 'Dan Balan' }, { id: 'a2', name: 'Katerina Begu' }];
    expect(resolveTrackArtistRefs({
      artist: 'Dan Balan feat. Katerina Begu',
      artistId: 'legacy',
      artists: refs,
    })).toEqual(refs);
  });

  it('falls back to legacy artistId + artist', () => {
    expect(resolveTrackArtistRefs({
      artist: 'Solo',
      artistId: 'ar-solo',
    })).toEqual([{ id: 'ar-solo', name: 'Solo' }]);
  });

  it('returns name-only ref when no id', () => {
    expect(resolveTrackArtistRefs({ artist: 'Unknown' })).toEqual([{ name: 'Unknown' }]);
  });

  it('coerces a single-object OpenSubsonic artists payload', () => {
    expect(resolveTrackArtistRefs({
      artist: 'Joined',
      artistId: 'legacy',
      artists: { id: 'a1', name: 'Solo' } as unknown as Track['artists'],
    })).toEqual([{ id: 'a1', name: 'Solo' }]);
  });
});

describe('primaryTrackArtistRef', () => {
  it('returns the first structured ref', () => {
    expect(primaryTrackArtistRef({
      artist: 'A feat. B',
      artists: [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }],
    })).toEqual({ id: 'a1', name: 'A' });
  });
});
