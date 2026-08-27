import { describe, expect, it } from 'vitest';
import { canonicalNavidromeCoverIdbKey } from './navidromeCanonicalIdb';

const LEGACY = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL = '6VHl3uR4kss6sUPKA8Cwnk';

describe('canonicalNavidromeCoverIdbKey', () => {
  it('parses around the cover and final tier delimiters', () => {
    expect(canonicalNavidromeCoverIdbKey(
      `music.test:4533:cover:album:dc-${LEGACY}:2:800`,
      'music.test:4533',
    )).toBe(`music.test:4533:cover:album:dc-${CANONICAL}:2:800`);
  });

  it('preserves unrelated or malformed keys', () => {
    expect(canonicalNavidromeCoverIdbKey('other.test:cover:album:x:800', 'music.test')).toBeNull();
    expect(canonicalNavidromeCoverIdbKey('music.test:cover:video:x:800', 'music.test')).toBeNull();
    expect(canonicalNavidromeCoverIdbKey('music.test:cover:album:x', 'music.test')).toBeNull();
  });
});
