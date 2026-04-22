import { describe, expect, it } from 'vitest';
import {
  SERVER_MAGIC_STRING_PREFIX,
  DECODED_PASSWORD_VISUAL_MASK,
  decodeServerMagicString,
  decodeServerMagicStringFromText,
  encodeServerMagicString,
} from './serverMagicString';

describe('DECODED_PASSWORD_VISUAL_MASK', () => {
  it('has fixed length independent of real passwords', () => {
    expect(DECODED_PASSWORD_VISUAL_MASK.length).toBe(10);
  });
});

describe('serverMagicString', () => {
  it('round-trips url, username, password', () => {
    const original = {
      url: 'https://music.example.com',
      username: 'alice',
      password: 's3cret!',
    };
    const encoded = encodeServerMagicString(original);
    expect(encoded.startsWith(SERVER_MAGIC_STRING_PREFIX)).toBe(true);
    expect(decodeServerMagicString(encoded)).toEqual(original);
  });

  it('round-trips optional name', () => {
    const original = {
      url: 'http://127.0.0.1:4533',
      username: 'bob',
      password: 'x',
      name: 'Home',
    };
    const encoded = encodeServerMagicString(original);
    expect(decodeServerMagicString(encoded)).toEqual(original);
  });

  it('rejects invalid input', () => {
    expect(decodeServerMagicString('')).toBeNull();
    expect(decodeServerMagicString('nope')).toBeNull();
    expect(decodeServerMagicString(`${SERVER_MAGIC_STRING_PREFIX}%%%`)).toBeNull();
  });

  it('decodes invite embedded in surrounding text', () => {
    const original = {
      url: 'https://music.example.com',
      username: 'alice',
      password: 'pw',
    };
    const line = encodeServerMagicString(original);
    expect(decodeServerMagicStringFromText(`Copy:\n${line}\nThanks`)).toEqual(original);
    expect(decodeServerMagicStringFromText('no token')).toBeNull();
  });
});
