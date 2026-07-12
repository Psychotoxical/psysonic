import { describe, expect, it } from 'vitest';
import {
  fetchNavidromePublicShare,
  parseShareInfoFromHtml,
  parseShareInfoFromM3u,
} from '@/lib/share/fetchNavidromePublicShare';
import type { NavidromePublicShareRef } from '@/lib/share/navidromePublicShareUrl';

const ref: NavidromePublicShareRef = {
  pageUrl: 'https://music.example.com/share/Ab12Cd34Ef',
  origin: 'https://music.example.com',
  basePath: '',
  shareId: 'Ab12Cd34Ef',
};

const shareInfoJson = {
  id: 'Ab12Cd34Ef',
  description: 'Weekend mix',
  downloadable: true,
  tracks: [
    {
      id: 'stream-jwt-1',
      title: 'Track One',
      artist: 'Artist A',
      album: 'Album X',
      duration: 245,
    },
  ],
};

describe('parseShareInfoFromHtml', () => {
  it('extracts __SHARE_INFO__ JSON from HTML', () => {
    const html = `<html><script>window.__SHARE_INFO__ = ${JSON.stringify(shareInfoJson)}</script></html>`;
    expect(parseShareInfoFromHtml(html)).toEqual(shareInfoJson);
  });

  it('extracts Navidrome string-assigned __SHARE_INFO__ (escaped JSON in JS quotes)', () => {
    const html = `<html><script>window.__SHARE_INFO__ = ${JSON.stringify(JSON.stringify(shareInfoJson))}</script></html>`;
    expect(parseShareInfoFromHtml(html)).toEqual(shareInfoJson);
  });

  it('parses real Navidrome v0.63 HTML assignment shape', () => {
    const html = `<script>window.__SHARE_INFO__ = "{\\"id\\":\\"m4dSzkJhZc\\",\\"description\\":\\"testo\\",\\"downloadable\\":false,\\"tracks\\":[{\\"id\\":\\"jwt\\",\\"title\\":\\"Обман\\",\\"artist\\":\\"Ария\\",\\"album\\":\\"Колизей\\",\\"duration\\":310.15}]}"</script>`;
    expect(parseShareInfoFromHtml(html)).toEqual({
      id: 'm4dSzkJhZc',
      description: 'testo',
      downloadable: false,
      tracks: [{
        id: 'jwt',
        title: 'Обман',
        artist: 'Ария',
        album: 'Колизей',
        duration: 310.15,
      }],
    });
  });

  it('returns null when marker is missing', () => {
    expect(parseShareInfoFromHtml('<html></html>')).toBeNull();
  });
});

describe('parseShareInfoFromM3u', () => {
  it('parses extended m3u entries', () => {
    const body = [
      '#EXTM3U',
      '#EXTINF:245,Track One',
      'https://music.example.com/share/s/stream-jwt-1',
    ].join('\n');
    expect(parseShareInfoFromM3u(body)).toEqual([
      {
        id: 'stream-jwt-1',
        title: 'Track One',
        artist: '',
        album: '',
        duration: 0,
      },
    ]);
  });
});

describe('fetchNavidromePublicShare', () => {
  it('maps 404 to not-found', async () => {
    const result = await fetchNavidromePublicShare(ref, async () => new Response('', { status: 404 }));
    expect(result).toEqual({ type: 'error', reason: 'not-found' });
  });

  it('maps 410 to expired', async () => {
    const result = await fetchNavidromePublicShare(ref, async () => new Response('', { status: 410 }));
    expect(result).toEqual({ type: 'error', reason: 'expired' });
  });

  it('returns parsed HTML share info', async () => {
    const html = `<html><meta property="og:image" content="https://music.example.com/cover.jpg"><script>window.__SHARE_INFO__ = ${JSON.stringify(shareInfoJson)}</script></html>`;
    const result = await fetchNavidromePublicShare(ref, async () => new Response(html, { status: 200 }));
    expect(result).toEqual({
      type: 'ok',
      info: {
        ...shareInfoJson,
        imageUrl: 'https://music.example.com/share/img/stream-jwt-1?size=300',
      },
    });
  });

  it('falls back to m3u when HTML has no share info', async () => {
    const m3u = [
      '#EXTM3U',
      '#EXTINF:120,Fallback Track',
      'https://music.example.com/share/s/token-2',
    ].join('\n');
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/m3u')) return new Response(m3u, { status: 200 });
      return new Response('<html></html>', { status: 200 });
    };
    const result = await fetchNavidromePublicShare(ref, fetchImpl);
    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.info.tracks).toHaveLength(1);
      expect(result.info.tracks[0]?.title).toBe('Fallback Track');
      expect(result.info.imageUrl).toBe('https://music.example.com/share/img/token-2?size=300');
    }
  });
});
