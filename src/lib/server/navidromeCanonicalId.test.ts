import { describe, expect, it } from 'vitest';
import {
  canonicalNavidromeArtworkId,
  canonicalNavidromeId,
} from './navidromeCanonicalId';

const LEGACY_HEX = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL_HEX = '6VHl3uR4kss6sUPKA8Cwnk';
const LEGACY_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const CANONICAL_UUID = '7rke2SAWaicSeSYzkhww6R';
const U128_MAX_BASE62 = '7N42dgm5tFLK9N8MT7fHC7';
const U128_OVERFLOW_BASE62 = '7N42dgm5tFLK9N8MT7fHC8';
const OVERFLOWING_BASE62 = 'zzzzzzzzzzzzzzzzzzzzzz';
const HASHED_BASE62 = '3LyqmwQBm5IRqlVjNYASwb';

describe('canonicalNavidromeId', () => {
  it.each([
    ['5cLJPkLA5DK2BADhoeotPk', '5cLJPkLA5DK2BADhoeotPk'],
    ['0000000000000000000000', '0000000000000000000000'],
    [U128_MAX_BASE62, U128_MAX_BASE62],
    [U128_OVERFLOW_BASE62, '4lNKf50OxNrXbwJuGRpSfD'],
    [OVERFLOWING_BASE62, HASHED_BASE62],
    [LEGACY_HEX, CANONICAL_HEX],
    ['E3B7FC2AE9447BBEC37A13BF916E3CF6', CANONICAL_HEX],
    ['00000000000000000000000000000000', '0000000000000000000000'],
    ['ffffffffffffffffffffffffffffffff', U128_MAX_BASE62],
    [LEGACY_UUID, CANONICAL_UUID],
    ['F47AC10B-58CC-4372-A567-0E02B2C3D479', CANONICAL_UUID],
  ])('canonicalizes supported input %s', (input, expected) => {
    expect(canonicalNavidromeId(input)).toBe(expected);
  });

  it.each([
    '',
    'track-123',
    'not_base62_but_22_chars',
    'e3b7fc2ae9447bbec37a13bf916e3cfg',
    'f47ac10b58cc-4372-a567-0e02b2c3d479',
    'f47ac10b-58cc-4372-a567-0e02b2c3d47z',
    'musicbrainz:f47ac10b-58cc-4372-a567-0e02b2c3d479',
  ])('preserves invalid or arbitrary value %s', (value) => {
    expect(canonicalNavidromeId(value)).toBe(value);
  });

  it.each([
    '5cLJPkLA5DK2BADhoeotPk',
    OVERFLOWING_BASE62,
    LEGACY_HEX,
    LEGACY_UUID,
    'track-123',
  ])('is idempotent for %s', (value) => {
    const once = canonicalNavidromeId(value);
    expect(canonicalNavidromeId(once)).toBe(once);
  });
});

describe('canonicalNavidromeArtworkId', () => {
  it.each(['mf-', 'al-', 'ar-', 'pl-', 'ra-', 'tr-'])(
    'rewrites the %s payload with and without an update token',
    (prefix) => {
      expect(canonicalNavidromeArtworkId(`${prefix}${LEGACY_HEX}`))
        .toBe(`${prefix}${CANONICAL_HEX}`);
      expect(canonicalNavidromeArtworkId(`${prefix}${LEGACY_HEX}_60fc987f`))
        .toBe(`${prefix}${CANONICAL_HEX}_60fc987f`);
    },
  );

  it('preserves the dc- disc suffix and optional hexadecimal update token', () => {
    expect(canonicalNavidromeArtworkId(`dc-${LEGACY_HEX}:2`))
      .toBe(`dc-${CANONICAL_HEX}:2`);
    expect(canonicalNavidromeArtworkId(`dc-${LEGACY_HEX}:2_60fc987f`))
      .toBe(`dc-${CANONICAL_HEX}:2_60fc987f`);
  });

  it.each([
    'mbz-f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'external-radio-f47ac10b-58cc-4372-a567-0e02b2c3d479',
    `dc-${LEGACY_HEX}`,
    'tr-track-123_not-hex',
  ])('preserves unknown or malformed structured value %s', (value) => {
    expect(canonicalNavidromeArtworkId(value)).toBe(value);
  });

  it.each([
    `mf-${LEGACY_HEX}_60fc987f`,
    `tr-${OVERFLOWING_BASE62}`,
    `dc-${LEGACY_UUID}:12_FF00`,
    'ar-opaque-id',
  ])('is idempotent for %s', (value) => {
    const once = canonicalNavidromeArtworkId(value);
    expect(canonicalNavidromeArtworkId(once)).toBe(once);
  });
});
