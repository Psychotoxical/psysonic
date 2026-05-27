import { describe, expect, it } from 'vitest';
import {
  allNormalizedAddresses,
  isLanUrl,
  normalizeServerBaseUrl,
  serverAddressEndpoints,
} from './serverEndpoint';

describe('normalizeServerBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeServerBaseUrl('https://music.example.com/')).toBe(
      'https://music.example.com',
    );
  });

  it('prefixes http:// for a bare host', () => {
    expect(normalizeServerBaseUrl('music.example.com')).toBe('http://music.example.com');
  });

  it('returns empty for empty input', () => {
    expect(normalizeServerBaseUrl('')).toBe('');
  });
});

describe('isLanUrl — IPv4', () => {
  it.each([
    'http://localhost',
    'http://localhost:4533',
    'http://musicbox.local',
    'http://127.0.0.1',
    'http://127.5.6.7',
    'http://10.0.0.5',
    'http://192.168.1.10',
    'http://172.16.0.1',
    'http://172.31.255.255',
  ])('classifies %s as LAN', url => {
    expect(isLanUrl(url)).toBe(true);
  });

  it.each([
    'http://172.15.0.1',
    'http://172.32.0.1',
    'https://example.com',
    'https://music.example.com',
    'http://8.8.8.8',
  ])('classifies %s as public', url => {
    expect(isLanUrl(url)).toBe(false);
  });
});

describe('isLanUrl — IPv6', () => {
  it.each([
    'http://[::1]',
    'http://[::1]:4533',
    'http://[fe80::1]',
    'http://[fe80::abcd:1]',
    'http://[fc00::1]',
    'http://[fd12:3456:789a::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.0.1]',
  ])('classifies %s as LAN', url => {
    expect(isLanUrl(url)).toBe(true);
  });

  it.each([
    'http://[2001:db8::1]',
    'http://[::ffff:8.8.8.8]',
    'http://[2606:4700:4700::1111]',
  ])('classifies %s as public', url => {
    expect(isLanUrl(url)).toBe(false);
  });
});

describe('isLanUrl — edge cases', () => {
  it('handles bare hosts without scheme', () => {
    expect(isLanUrl('192.168.0.1')).toBe(true);
    expect(isLanUrl('example.com')).toBe(false);
  });

  it('returns false on empty / malformed', () => {
    expect(isLanUrl('')).toBe(false);
    expect(isLanUrl('not a url at all  ')).toBe(false);
  });
});

describe('allNormalizedAddresses', () => {
  it('returns single entry for profile with only url', () => {
    expect(
      allNormalizedAddresses({ url: 'https://music.example.com' }),
    ).toEqual(['https://music.example.com']);
  });

  it('returns both addresses preserving order', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10:4533',
      }),
    ).toEqual(['https://music.example.com', 'http://192.168.0.10:4533']);
  });

  it('dedupes identical normalized addresses', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com/',
        alternateUrl: 'https://music.example.com',
      }),
    ).toEqual(['https://music.example.com']);
  });

  it('drops empty alternateUrl', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com',
        alternateUrl: '',
      }),
    ).toEqual(['https://music.example.com']);
  });
});

describe('serverAddressEndpoints', () => {
  it('returns a single local endpoint for a LAN-only profile', () => {
    expect(
      serverAddressEndpoints({ url: 'http://192.168.0.10' }),
    ).toEqual([{ url: 'http://192.168.0.10', kind: 'local' }]);
  });

  it('puts LAN before public when public is primary', () => {
    expect(
      serverAddressEndpoints({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toEqual([
      { url: 'http://192.168.0.10', kind: 'local' },
      { url: 'https://music.example.com', kind: 'public' },
    ]);
  });

  it('keeps LAN-first when LAN is already primary', () => {
    expect(
      serverAddressEndpoints({
        url: 'http://192.168.0.10',
        alternateUrl: 'https://music.example.com',
      }),
    ).toEqual([
      { url: 'http://192.168.0.10', kind: 'local' },
      { url: 'https://music.example.com', kind: 'public' },
    ]);
  });

  it('preserves original order among endpoints of the same kind', () => {
    expect(
      serverAddressEndpoints({
        url: 'http://10.0.0.5',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toEqual([
      { url: 'http://10.0.0.5', kind: 'local' },
      { url: 'http://192.168.0.10', kind: 'local' },
    ]);
  });
});
