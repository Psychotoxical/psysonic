import { describe, expect, it } from 'vitest';
import {
  autodjJsTriggerAtSec,
  computeAutodjJsOverlap,
  shouldJsDriveAutodjTransition,
} from './autodjAutoAdvance';

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
