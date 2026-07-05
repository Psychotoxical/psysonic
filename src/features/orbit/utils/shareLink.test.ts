import { describe, expect, it } from 'vitest';

import { buildOrbitShareLink, parseOrbitShareLink } from '@/features/orbit/utils/shareLink';

describe('parseOrbitShareLink', () => {
  it('round-trips an https invite', () => {
    const link = buildOrbitShareLink('https://music.example.com', 'aaaa1111');
    expect(parseOrbitShareLink(link)).toEqual({
      serverBase: 'https://music.example.com',
      sid: 'aaaa1111',
    });
  });

  it('accepts a plain http server', () => {
    const link = buildOrbitShareLink('http://192.168.1.10:4533', 'bbbb2222');
    expect(parseOrbitShareLink(link)?.serverBase).toBe('http://192.168.1.10:4533');
  });

  it('rejects http-prefixed but non-http(s) schemes that slip past url normalization', () => {
    // normalizeShareServerUrl only prepends http:// when the string doesn't
    // already start with "http", so these reach the parser unchanged — the
    // protocol allow-list is what rejects them.
    for (const bad of ['httpx://evil.example', 'https-phish://evil.example']) {
      const link = buildOrbitShareLink(bad, 'cccc3333');
      expect(parseOrbitShareLink(link)).toBeNull();
    }
  });

  it('rejects a non-URL server and empty input', () => {
    expect(parseOrbitShareLink(buildOrbitShareLink('not a url', 'dddd4444'))).toBeNull();
    expect(parseOrbitShareLink('')).toBeNull();
    expect(parseOrbitShareLink('garbage-not-a-share-string')).toBeNull();
  });
});
