import { describe, expect, it } from 'vitest';
import { playlistPathId, trackToSyncInfo, withPlaylistPathIds } from './deviceSyncHelpers';

const playlist = (id: string, name: string) => ({ type: 'playlist', id, name });

describe('playlistPathId', () => {
  it('preserves the legacy folder for a unique playlist name', () => {
    const source = playlist('one', 'Road Trip');
    expect(playlistPathId(source, [source])).toBeUndefined();
  });

  it('disambiguates identical and sanitization-equivalent names', () => {
    const sources = [
      playlist('one', 'Road/Trip'),
      playlist('two', 'Road:Trip'),
    ];
    expect(playlistPathId(sources[0], sources)).toBe('one');
    expect(playlistPathId(sources[1], sources)).toBe('two');
  });

  it('passes the discriminator into track sync data', () => {
    const info = trackToSyncInfo(
      {
        id: 'track',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        albumId: 'album',
        duration: 180,
      },
      '',
      { id: 'playlist', name: 'Mix', index: 1 },
    );
    expect(info.playlistId).toBe('playlist');
  });

  it('keeps a collision discriminator after the other playlist is removed', () => {
    const sources = withPlaylistPathIds([
      playlist('one', 'Road/Trip'),
      playlist('two', 'Road:Trip'),
    ]);
    expect(playlistPathId(sources[0], [sources[0]])).toBe('one');
  });
});
