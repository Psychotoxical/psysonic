import { describe, expect, it } from 'vitest';
import { encodeServerMagicString } from '@/lib/server/serverMagicString';
import { encodeSharePayload } from '@/lib/share/shareLink';
import { parseShareSearchText, sharePayloadTotal } from '@/lib/share/shareSearch';

describe('share search parsing', () => {
  it('detects track share links as queueable', () => {
    const link = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'track',
      id: 'song-1',
    });

    expect(parseShareSearchText(link)).toEqual({
      type: 'queueable',
      payload: {
        srv: 'https://music.example.com',
        k: 'track',
        id: 'song-1',
      },
    });
  });

  it('detects queue share links as queueable and counts their tracks', () => {
    const link = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'queue',
      ids: ['a', 'b', 'c'],
    });
    const match = parseShareSearchText(`try this ${link}`);

    expect(match).toEqual({
      type: 'queueable',
      payload: {
        srv: 'https://music.example.com',
        k: 'queue',
        ids: ['a', 'b', 'c'],
      },
    });
    if (match?.type === 'queueable') {
      expect(sharePayloadTotal(match.payload)).toBe(3);
    }
  });

  it('does not treat server magic strings as share-search links', () => {
    const invite = encodeServerMagicString({
      url: 'https://music.example.com',
      username: 'user',
      password: 'pass',
    });

    expect(parseShareSearchText(invite)).toBeNull();
  });

  it('detects album share links as album search results', () => {
    const album = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'album',
      id: 'album-1',
    });

    expect(parseShareSearchText(album)).toEqual({
      type: 'album',
      payload: {
        srv: 'https://music.example.com',
        k: 'album',
        id: 'album-1',
      },
    });
  });

  it('detects artist share links as artist search results', () => {
    const artist = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'artist',
      id: 'artist-1',
    });

    expect(parseShareSearchText(artist)).toEqual({
      type: 'artist',
      payload: {
        srv: 'https://music.example.com',
        k: 'artist',
        id: 'artist-1',
      },
    });
  });

  it('detects composer share links as composer search results', () => {
    const composer = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'composer',
      id: 'composer-1',
    });

    expect(parseShareSearchText(composer)).toEqual({
      type: 'composer',
      payload: {
        srv: 'https://music.example.com',
        k: 'composer',
        id: 'composer-1',
      },
    });
  });

  it('returns unsupported for invalid psysonic2 payloads', () => {
    expect(parseShareSearchText('psysonic2-not-valid-base64!!!')).toEqual({ type: 'unsupported' });
  });

  it('counts a single track in sharePayloadTotal', () => {
    expect(
      sharePayloadTotal({ srv: 'https://music.example.com', k: 'track', id: 'song-1' }),
    ).toBe(1);
  });

  it('marks orbit invites as unsupported in search', () => {
    const orbit = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'orbit',
      sid: '1234abcd',
    });

    expect(parseShareSearchText(orbit)).toEqual({ type: 'unsupported' });
  });
});
