import { describe, expect, it } from 'vitest';
import {
  decodeSharePayloadFromText,
  encodeSharePayload,
  PSYSONIC_SHARE_PREFIX,
} from './shareLink';
import { decodeServerMagicString, encodeServerMagicString, SERVER_MAGIC_STRING_PREFIX } from './serverMagicString';

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
