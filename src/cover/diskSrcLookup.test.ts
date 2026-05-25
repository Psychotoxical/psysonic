import { describe, expect, it } from 'vitest';
import { gridDiskSrcLookupOrder } from './diskSrcLookup';

describe('gridDiskSrcLookupOrder', () => {
  it('prefers 800 right after 512 when 512 is wanted', () => {
    expect(gridDiskSrcLookupOrder(512)).toEqual([512, 800, 256, 128]);
  });

  it('prefers 800 for 256 display tier', () => {
    expect(gridDiskSrcLookupOrder(256)[1]).toBe(800);
  });
});
