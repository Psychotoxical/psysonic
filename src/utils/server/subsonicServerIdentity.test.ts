import { describe, expect, it } from 'vitest';
import {
  isAudiomusePluginAutoManaged,
  isNavidromeSonicSimilarityEligible,
  parseLeadingSemver,
  resolveAudiomusePluginProbeUiStatus,
  showAudiomuseNavidromeServerSetting,
} from './subsonicServerIdentity';

describe('parseLeadingSemver', () => {
  it('parses Navidrome-style version strings', () => {
    expect(parseLeadingSemver('0.62.0 (2026-06-08)')).toEqual([0, 62, 0]);
    expect(parseLeadingSemver('v0.61.2')).toEqual([0, 61, 2]);
  });
});

describe('isNavidromeSonicSimilarityEligible', () => {
  it('is true for Navidrome ≥ 0.62', () => {
    expect(isNavidromeSonicSimilarityEligible({ type: 'navidrome', serverVersion: '0.62.0' })).toBe(true);
  });

  it('is false for Navidrome 0.61', () => {
    expect(isNavidromeSonicSimilarityEligible({ type: 'navidrome', serverVersion: '0.61.2' })).toBe(false);
  });

  it('is false for non-Navidrome servers', () => {
    expect(isNavidromeSonicSimilarityEligible({ type: 'gonic', serverVersion: '0.62.0' })).toBe(false);
  });
});

describe('showAudiomuseNavidromeServerSetting', () => {
  const nav062 = { type: 'navidrome', serverVersion: '0.62.0' };
  const nav061 = { type: 'navidrome', serverVersion: '0.61.2' };

  it('shows the status row on all Navidrome 0.62+ servers', () => {
    expect(showAudiomuseNavidromeServerSetting(nav062, undefined, 'present')).toBe(true);
    expect(showAudiomuseNavidromeServerSetting(nav062, 'ok', 'absent')).toBe(true);
    expect(showAudiomuseNavidromeServerSetting(nav062, undefined, 'probing')).toBe(true);
  });

  it('keeps legacy instant-mix probe gating on pre-0.62 Navidrome', () => {
    expect(showAudiomuseNavidromeServerSetting(nav061, 'ok', undefined)).toBe(true);
    expect(showAudiomuseNavidromeServerSetting(nav061, 'empty', undefined)).toBe(false);
  });
});

describe('isAudiomusePluginAutoManaged', () => {
  it('is true only for Navidrome ≥ 0.62', () => {
    expect(isAudiomusePluginAutoManaged({ type: 'navidrome', serverVersion: '0.62.0' })).toBe(true);
    expect(isAudiomusePluginAutoManaged({ type: 'navidrome', serverVersion: '0.61.2' })).toBe(false);
  });
});

describe('resolveAudiomusePluginProbeUiStatus', () => {
  it('maps probe results to UI status', () => {
    expect(resolveAudiomusePluginProbeUiStatus('present')).toBe('active');
    expect(resolveAudiomusePluginProbeUiStatus('probing')).toBe('checking');
    expect(resolveAudiomusePluginProbeUiStatus('absent')).toBe('not_detected');
    expect(resolveAudiomusePluginProbeUiStatus('error')).toBe('failed');
  });
});
