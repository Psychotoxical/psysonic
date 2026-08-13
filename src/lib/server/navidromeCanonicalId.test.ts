import { describe, expect, it } from 'vitest';
import {
  canonicalNavidromeArtworkId,
  canonicalNavidromeId,
} from './navidromeCanonicalId';

describe('canonicalNavidromeId', () => {
  it.each([
    ['5cLJPkLA5DK2BADhoeotPk', '5cLJPkLA5DK2BADhoeotPk'],
    ['zzzzzzzzzzzzzzzzzzzzzz', '3LyqmwQBm5IRqlVjNYASwb'],
    ['e3b7fc2ae9447bbec37a13bf916e3cf6', '6VHl3uR4kss6sUPKA8Cwnk'],
    ['f47ac10b-58cc-4372-a567-0e02b2c3d479', '7rke2SAWaicSeSYzkhww6R'],
  ])('matches the upstream vector %s', (input, expected) => {
    expect(canonicalNavidromeId(input)).toBe(expected);
  });

  it('preserves structured artwork suffixes', () => {
    const oldId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const newId = '6VHl3uR4kss6sUPKA8Cwnk';
    expect(canonicalNavidromeArtworkId(`mf-${oldId}_60fc987f`))
      .toBe(`mf-${newId}_60fc987f`);
    expect(canonicalNavidromeArtworkId(`dc-${oldId}:2_60fc987f`))
      .toBe(`dc-${newId}:2_60fc987f`);
  });
});
