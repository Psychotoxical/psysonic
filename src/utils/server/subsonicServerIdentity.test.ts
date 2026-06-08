import { describe, expect, it } from 'vitest';
import {
  isNavidromeAudiomuseSoftwareEligible,
  isNavidromeServer,
  parseLeadingSemver,
} from './subsonicServerIdentity';

describe('parseLeadingSemver', () => {
  it('parses Navidrome-style version strings', () => {
    expect(parseLeadingSemver('0.62.0 (2026-06-08)')).toEqual([0, 62, 0]);
    expect(parseLeadingSemver('v0.61.2')).toEqual([0, 61, 2]);
  });

  it('returns null for unparseable input', () => {
    expect(parseLeadingSemver(undefined)).toBeNull();
    expect(parseLeadingSemver('unknown')).toBeNull();
  });
});

describe('isNavidromeServer', () => {
  it('matches the navidrome type case-insensitively', () => {
    expect(isNavidromeServer({ type: 'navidrome' })).toBe(true);
    expect(isNavidromeServer({ type: 'Navidrome' })).toBe(true);
    expect(isNavidromeServer({ type: 'gonic' })).toBe(false);
    expect(isNavidromeServer(undefined)).toBe(false);
  });
});

describe('isNavidromeAudiomuseSoftwareEligible', () => {
  it('is permissive until a typed ping arrives', () => {
    expect(isNavidromeAudiomuseSoftwareEligible(undefined)).toBe(true);
    expect(isNavidromeAudiomuseSoftwareEligible({})).toBe(true);
  });

  it('requires Navidrome ≥ 0.60 once metadata is known', () => {
    expect(isNavidromeAudiomuseSoftwareEligible({ type: 'navidrome', serverVersion: '0.60.0' })).toBe(true);
    expect(isNavidromeAudiomuseSoftwareEligible({ type: 'navidrome', serverVersion: '0.59.9' })).toBe(false);
    expect(isNavidromeAudiomuseSoftwareEligible({ type: 'gonic', serverVersion: '1.0.0' })).toBe(false);
  });
});
