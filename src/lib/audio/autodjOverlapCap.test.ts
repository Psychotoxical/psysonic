import { describe, expect, it } from 'vitest';
import {
  autodjMaxOverlapCapSec,
  DEFAULT_AUTODJ_OVERLAP_CAP_SEC,
  sanitizeAutodjOverlapCapSec,
} from '@/lib/audio/autodjOverlapCap';

describe('autodjOverlapCap', () => {
  it('sanitizes cap seconds to 2–30', () => {
    expect(sanitizeAutodjOverlapCapSec(1)).toBe(2);
    expect(sanitizeAutodjOverlapCapSec(40)).toBe(30);
    expect(sanitizeAutodjOverlapCapSec(DEFAULT_AUTODJ_OVERLAP_CAP_SEC)).toBe(15);
  });

  it('uses 12 s in auto mode', () => {
    expect(autodjMaxOverlapCapSec({ autodjOverlapCapMode: 'auto', autodjOverlapCapSec: 20 })).toBe(12);
  });

  it('uses configured cap in limit mode', () => {
    expect(autodjMaxOverlapCapSec({ autodjOverlapCapMode: 'limit', autodjOverlapCapSec: 20 })).toBe(20);
  });
});
