import { describe, expect, it } from 'vitest';
import {
  buildNavidromePublicCoverUrl,
  buildNavidromePublicShareM3uUrl,
  buildNavidromePublicStreamUrl,
  extractNavidromePublicShareFromText,
  parseNavidromePublicShareUrl,
} from '@/lib/share/navidromePublicShareUrl';

const SHARE_ID = 'Ab12Cd34Ef';

describe('parseNavidromePublicShareUrl', () => {
  it('parses a root-level share URL', () => {
    expect(parseNavidromePublicShareUrl(`https://music.example.com/share/${SHARE_ID}`)).toEqual({
      pageUrl: `https://music.example.com/share/${SHARE_ID}`,
      origin: 'https://music.example.com',
      basePath: '',
      shareId: SHARE_ID,
    });
  });

  it('parses a share URL with base path', () => {
    expect(parseNavidromePublicShareUrl(`https://music.example.com/navidrome/share/${SHARE_ID}/`)).toEqual({
      pageUrl: `https://music.example.com/navidrome/share/${SHARE_ID}`,
      origin: 'https://music.example.com',
      basePath: '/navidrome',
      shareId: SHARE_ID,
    });
  });

  it('rejects stream token URLs', () => {
    expect(parseNavidromePublicShareUrl('https://music.example.com/share/s/jwt.token.here')).toBeNull();
  });

  it('rejects m3u and image paths', () => {
    expect(parseNavidromePublicShareUrl(`https://music.example.com/share/${SHARE_ID}/m3u`)).toBeNull();
    expect(parseNavidromePublicShareUrl(`https://music.example.com/share/img/${SHARE_ID}`)).toBeNull();
  });

  it('rejects invalid share ids', () => {
    expect(parseNavidromePublicShareUrl('https://music.example.com/share/tooshort')).toBeNull();
    expect(parseNavidromePublicShareUrl('https://music.example.com/share/12345678901')).toBeNull();
  });
});

describe('extractNavidromePublicShareFromText', () => {
  it('finds a share URL embedded in text', () => {
    const url = `https://music.example.com/share/${SHARE_ID}`;
    expect(extractNavidromePublicShareFromText(`check this out: ${url}.`)).toEqual({
      pageUrl: url,
      origin: 'https://music.example.com',
      basePath: '',
      shareId: SHARE_ID,
    });
  });
});

describe('stream and m3u URL builders', () => {
  const ref = {
    pageUrl: `https://music.example.com/navidrome/share/${SHARE_ID}`,
    origin: 'https://music.example.com',
    basePath: '/navidrome',
    shareId: SHARE_ID,
  };

  it('builds public stream URLs', () => {
    expect(buildNavidromePublicStreamUrl(ref, 'jwt-token')).toBe(
      'https://music.example.com/navidrome/share/s/jwt-token',
    );
  });

  it('builds public cover URLs from track stream tokens', () => {
    expect(buildNavidromePublicCoverUrl(ref, 'jwt-token')).toBe(
      'https://music.example.com/navidrome/share/img/jwt-token?size=300',
    );
    expect(buildNavidromePublicCoverUrl(ref, 'jwt-token', 512)).toBe(
      'https://music.example.com/navidrome/share/img/jwt-token?size=512',
    );
  });

  it('builds m3u URLs', () => {
    expect(buildNavidromePublicShareM3uUrl(ref)).toBe(
      `https://music.example.com/navidrome/share/${SHARE_ID}/m3u`,
    );
  });
});
