import { describe, expect, it } from 'vitest';
import {
  classifyNavidromeCanonicalVersion,
  NAVIDROME_CANONICAL_PROVISIONAL_LEGACY_MAX,
} from './navidromeCanonicalVersion';

describe('classifyNavidromeCanonicalVersion', () => {
  it('marks non-Navidrome successful pings as not applicable', () => {
    expect(classifyNavidromeCanonicalVersion({ type: 'Jellyfin', serverVersion: '10.11.0' }))
      .toBe('not-applicable');
    expect(classifyNavidromeCanonicalVersion({ type: undefined, serverVersion: undefined }))
      .toBe('not-applicable');
  });

  it.each([
    '0.1.0',
    NAVIDROME_CANONICAL_PROVISIONAL_LEGACY_MAX,
    ' v0.63.2 ',
    '0.63.2 (1b46b977)',
  ])('classifies stable %s as legacy', (serverVersion) => {
    expect(classifyNavidromeCanonicalVersion({ type: 'Navidrome', serverVersion }))
      .toBe('legacy');
  });

  it.each([
    '0.63.3',
    '0.64.0',
    ' v1.0.0 (0123456789abcdef) ',
  ])('classifies stable %s as canonical', (serverVersion) => {
    expect(classifyNavidromeCanonicalVersion({ type: 'navidrome', serverVersion }))
      .toBe('canonical');
  });

  it.each([
    undefined,
    '',
    '0.64',
    '00.64.0',
    '0.64.0-rc.1',
    '0.64.0+custom',
    '0.64.0 (dirty)',
    '0.64.0 abcdef12',
    'custom-build',
  ])('keeps Navidrome version %s retryable', (serverVersion) => {
    expect(classifyNavidromeCanonicalVersion({ type: 'navidrome', serverVersion }))
      .toBe('retryable');
  });
});
