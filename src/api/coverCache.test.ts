import { describe, expect, it } from 'vitest';
import { coverCacheRestHost } from './coverCache';

describe('coverCacheRestHost', () => {
  it('strips /rest for Rust cover fetch', () => {
    expect(coverCacheRestHost('http://music.example:4533')).toBe('http://music.example:4533');
    expect(coverCacheRestHost('http://music.example:4533/')).toBe('http://music.example:4533');
  });
});
