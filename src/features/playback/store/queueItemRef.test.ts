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
});
