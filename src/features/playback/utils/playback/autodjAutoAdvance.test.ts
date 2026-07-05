import { describe, expect, it } from 'vitest';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import {
  autodjJsTriggerAtSec,
  computeAutodjJsOverlap,
  nextQueueRefForTransition,
  shouldJsDriveAutodjTransition,
} from '@/features/playback/utils/playback/autodjAutoAdvance';

describe('shouldJsDriveAutodjTransition', () => {
  it('drives loud→loud even when overlap is shorter than crossfadeSecs', () => {
    expect(shouldJsDriveAutodjTransition(0, 2, 8, false)).toBe(true);
  });

  it('defers to engine when A rides its own fade and overlap fits engine window', () => {
    expect(shouldJsDriveAutodjTransition(0, 5, 8, true)).toBe(false);
  });

  it('drives when trailing silence should be skipped early', () => {
    expect(shouldJsDriveAutodjTransition(0.5, 1, 8, true)).toBe(true);
  });

  it('drives when content overlap exceeds the engine crossfade window', () => {
    expect(shouldJsDriveAutodjTransition(0, 10, 8, true)).toBe(true);
  });
});

describe('computeAutodjJsOverlap', () => {
  it('uses standard blend for hard loud→loud', () => {
    expect(computeAutodjJsOverlap(0.5, false)).toEqual({
      overlapSec: 2,
      outgoingFadeSec: 2,
    });
  });

  it('does not fade A when it rides its own outro', () => {
    expect(computeAutodjJsOverlap(6, true)).toEqual({
      overlapSec: 6,
      outgoingFadeSec: 0,
    });
  });
});

describe('autodjJsTriggerAtSec', () => {
  it('ends the blend at A content end', () => {
    expect(autodjJsTriggerAtSec(200, 3, 2)).toBe(195);
  });
});

describe('nextQueueRefForTransition', () => {
  const ref = (id: string): QueueItemRef => ({ trackId: id, serverId: 's1' });

  it('returns the next slot when one exists', () => {
    const items = [ref('a'), ref('b')];
    expect(nextQueueRefForTransition(items, 0, 'off')).toBe(items[1]);
  });

  it('returns null on the queue tail without repeat-all', () => {
    const items = [ref('a'), ref('b')];
    expect(nextQueueRefForTransition(items, 1, 'off')).toBeNull();
  });

  it('wraps to the head on repeat-all', () => {
    const items = [ref('a'), ref('b')];
    expect(nextQueueRefForTransition(items, 1, 'all')).toBe(items[0]);
  });

  it('returns null for repeat-one', () => {
    const items = [ref('a'), ref('b')];
    expect(nextQueueRefForTransition(items, 0, 'one')).toBeNull();
  });
});
