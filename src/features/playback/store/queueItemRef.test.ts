import { describe, expect, it } from 'vitest';
import { toQueueItemRefs } from './queueItemRef';
import type { Track } from '@/lib/media/trackTypes';

describe('toQueueItemRefs', () => {
  it('uses per-track serverId when present', () => {
    const queue: Track[] = [
      { id: 't1', title: 'A', artist: '', album: '', albumId: '', duration: 1, serverId: 'srv-a' },
      { id: 't2', title: 'B', artist: '', album: '', albumId: '', duration: 1, serverId: 'srv-b' },
    ];
    const refs = toQueueItemRefs('fallback', queue);
    expect(refs[0].serverId).not.toBe(refs[1].serverId);
    expect(refs[0].trackId).toBe('t1');
    expect(refs[1].trackId).toBe('t2');
  });

  it('persists Navidrome public share direct URLs on refs', () => {
    const queue: Track[] = [{
      id: 'ndshare:Ab12:0',
      title: 'A',
      artist: '',
      album: '',
      albumId: '',
      duration: 1,
      directStreamUrl: 'https://music.example.com/share/s/jwt-a',
      directCoverArtUrl: 'https://music.example.com/share/img/jwt-a?size=300',
    }];
    const refs = toQueueItemRefs('navidrome-public-share', queue);
    expect(refs[0]?.directStreamUrl).toBe('https://music.example.com/share/s/jwt-a');
    expect(refs[0]?.directCoverArtUrl).toBe('https://music.example.com/share/img/jwt-a?size=300');
  });
});
