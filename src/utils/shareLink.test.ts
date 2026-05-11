import { describe, expect, it } from 'vitest';
import {
  PSYSONIC_SHARE_PREFIX,
  decodeOrbitSharePayloadFromText,
  decodeSharePayloadFromText,
  encodeSharePayload,
  findServerIdForShareUrl,
  normalizeShareServerUrl,
} from './shareLink';
import { decodeServerMagicString, encodeServerMagicString, SERVER_MAGIC_STRING_PREFIX } from './serverMagicString';
import { makeServer } from '@/test/helpers/factories';

describe('shareLink vs serverMagicString', () => {
  it('uses the same psysonic* prefix family as server invites (distinct digit)', () => {
    expect(SERVER_MAGIC_STRING_PREFIX).toBe('psysonic1-');
    expect(PSYSONIC_SHARE_PREFIX).toBe('psysonic2-');
    expect(SERVER_MAGIC_STRING_PREFIX.slice(0, 8)).toBe(PSYSONIC_SHARE_PREFIX.slice(0, 8));
    expect(SERVER_MAGIC_STRING_PREFIX).not.toBe(PSYSONIC_SHARE_PREFIX);
  });

  it('does not decode a server magic string as an entity share', () => {
    const serverLine = encodeServerMagicString({
      url: 'https://music.example.com',
      username: 'u',
      password: 'p',
    });
    expect(decodeSharePayloadFromText(serverLine)).toBeNull();
    expect(decodeSharePayloadFromText(`intro ${serverLine}`)).toBeNull();
  });

  it('does not decode an entity share as server magic', () => {
    const share = encodeSharePayload({
      srv: 'https://music.example.com',
      k: 'track',
      id: 'tr-1',
    });
    expect(share.startsWith(PSYSONIC_SHARE_PREFIX)).toBe(true);
    expect(decodeServerMagicString(share)).toBeNull();
  });

  it('round-trips entity payload embedded in surrounding text', () => {
    const encoded = encodeSharePayload({
      srv: 'https://nd.example/rest',
      k: 'album',
      id: 'al-99',
    });
    const pasted = `Check this:\n${encoded}\n`;
    expect(decodeSharePayloadFromText(pasted)).toEqual({
      srv: 'https://nd.example/rest',
      k: 'album',
      id: 'al-99',
    });
  });

  it('round-trips queue payload in order', () => {
    const ids = ['a', 'b', 'c'];
    const encoded = encodeSharePayload({
      srv: 'https://x.example',
      k: 'queue',
      ids,
    });
    expect(decodeSharePayloadFromText(encoded)).toEqual({
      srv: 'https://x.example',
      k: 'queue',
      ids: ['a', 'b', 'c'],
    });
    expect(decodeServerMagicString(encoded)).toBeNull();
  });
});

describe('normalizeShareServerUrl', () => {
  it('returns empty string for whitespace input', () => {
    expect(normalizeShareServerUrl('   ')).toBe('');
    expect(normalizeShareServerUrl('')).toBe('');
  });

  it('strips trailing slashes', () => {
    expect(normalizeShareServerUrl('https://x.example/')).toBe('https://x.example');
    expect(normalizeShareServerUrl('https://x.example')).toBe('https://x.example');
  });

  it('prepends http:// when no scheme is given', () => {
    expect(normalizeShareServerUrl('192.168.1.10:4533')).toBe('http://192.168.1.10:4533');
    expect(normalizeShareServerUrl('music.local')).toBe('http://music.local');
  });

  it('leaves https URLs unchanged (modulo trailing slash)', () => {
    expect(normalizeShareServerUrl('https://music.example.com')).toBe('https://music.example.com');
  });
});

describe('encodeSharePayload — entity kinds', () => {
  it('round-trips a track share', () => {
    const encoded = encodeSharePayload({ srv: 'https://x.example', k: 'track', id: 't-1' });
    expect(decodeSharePayloadFromText(encoded)).toEqual({
      srv: 'https://x.example',
      k: 'track',
      id: 't-1',
    });
  });

  it('round-trips an artist share', () => {
    const encoded = encodeSharePayload({ srv: 'https://x.example', k: 'artist', id: 'ar-1' });
    expect(decodeSharePayloadFromText(encoded)).toEqual({
      srv: 'https://x.example',
      k: 'artist',
      id: 'ar-1',
    });
  });

  it('round-trips a composer share', () => {
    const encoded = encodeSharePayload({ srv: 'https://x.example', k: 'composer', id: 'co-1' });
    expect(decodeSharePayloadFromText(encoded)).toEqual({
      srv: 'https://x.example',
      k: 'composer',
      id: 'co-1',
    });
  });

  it('trims whitespace in queue ids and drops empty ones', () => {
    const encoded = encodeSharePayload({
      srv: 'https://x.example',
      k: 'queue',
      ids: [' a ', '', 'b', '   '],
    });
    expect(decodeSharePayloadFromText(encoded)).toEqual({
      srv: 'https://x.example',
      k: 'queue',
      ids: ['a', 'b'],
    });
  });
});

describe('decodeSharePayloadFromText — rejection paths', () => {
  it('rejects text with no prefix', () => {
    expect(decodeSharePayloadFromText('just text')).toBeNull();
  });

  it('rejects bare prefix with no token', () => {
    expect(decodeSharePayloadFromText(`a ${PSYSONIC_SHARE_PREFIX} b`)).toBeNull();
  });

  it('rejects a payload with the wrong version', () => {
    const body = JSON.stringify({ v: 2, srv: 'https://x.example', k: 'track', id: 't' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects a payload with non-string srv', () => {
    const body = JSON.stringify({ v: 1, srv: 42, k: 'track', id: 't' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects an unknown entity kind', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'playlist', id: 'pl-1' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects an entity payload with an empty id', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'track', id: '   ' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects a queue payload with no ids', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'queue', ids: [] });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects a queue payload where ids is not an array', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'queue', ids: 'a,b' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects a queue payload whose ids are all whitespace', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'queue', ids: ['  ', ''] });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects malformed base64', () => {
    expect(decodeSharePayloadFromText(`${PSYSONIC_SHARE_PREFIX}!!!notbase64!!!`)).toBeNull();
  });

  it('refuses to surface an orbit payload via the entity decoder', () => {
    const orbit = encodeSharePayload({ srv: 'https://x.example', k: 'orbit', sid: 'abcd1234' });
    expect(decodeSharePayloadFromText(orbit)).toBeNull();
  });
});

describe('decodeOrbitSharePayloadFromText', () => {
  it('round-trips an orbit invite', () => {
    const encoded = encodeSharePayload({ srv: 'https://x.example', k: 'orbit', sid: 'abcd1234' });
    expect(decodeOrbitSharePayloadFromText(`come to orbit: ${encoded}`)).toEqual({
      srv: 'https://x.example',
      k: 'orbit',
      sid: 'abcd1234',
    });
  });

  it('lowercases the session id', () => {
    const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'orbit', sid: 'ABCD1234' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeOrbitSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toEqual({
      srv: 'https://x.example',
      k: 'orbit',
      sid: 'abcd1234',
    });
  });

  it('rejects text with no prefix', () => {
    expect(decodeOrbitSharePayloadFromText('hello')).toBeNull();
  });

  it('rejects bare prefix with no token', () => {
    expect(decodeOrbitSharePayloadFromText(`a ${PSYSONIC_SHARE_PREFIX} b`)).toBeNull();
  });

  it('rejects a non-orbit payload kind', () => {
    const encoded = encodeSharePayload({ srv: 'https://x.example', k: 'track', id: 't' });
    expect(decodeOrbitSharePayloadFromText(encoded)).toBeNull();
  });

  it('rejects an invalid version', () => {
    const body = JSON.stringify({ v: 9, srv: 'https://x.example', k: 'orbit', sid: 'abcd1234' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeOrbitSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects an empty server', () => {
    const body = JSON.stringify({ v: 1, srv: '', k: 'orbit', sid: 'abcd1234' });
    const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeOrbitSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
  });

  it('rejects a session id that is not 8 hex characters', () => {
    const sids = ['', 'abcd', 'abcd1234e', 'zzzz1234'];
    for (const sid of sids) {
      const body = JSON.stringify({ v: 1, srv: 'https://x.example', k: 'orbit', sid });
      const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(decodeOrbitSharePayloadFromText(PSYSONIC_SHARE_PREFIX + b64)).toBeNull();
    }
  });

  it('rejects malformed base64', () => {
    expect(decodeOrbitSharePayloadFromText(`${PSYSONIC_SHARE_PREFIX}!!!`)).toBeNull();
  });
});

describe('findServerIdForShareUrl', () => {
  it('matches by normalized URL', () => {
    const a = makeServer({ id: 'a', url: 'https://music.example.com/' });
    const b = makeServer({ id: 'b', url: 'http://other.local' });
    expect(findServerIdForShareUrl([a, b], 'https://music.example.com')).toBe('a');
    expect(findServerIdForShareUrl([a, b], 'http://other.local/')).toBe('b');
  });

  it('returns null when no server matches', () => {
    const a = makeServer({ id: 'a', url: 'https://music.example.com' });
    expect(findServerIdForShareUrl([a], 'https://elsewhere.example')).toBeNull();
  });

  it('returns null on an empty server list', () => {
    expect(findServerIdForShareUrl([], 'https://x.example')).toBeNull();
  });
});
