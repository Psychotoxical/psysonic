import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_MAGIC_STRING_PREFIX,
  DECODED_PASSWORD_VISUAL_MASK,
  copyTextToClipboard,
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

  it('drops a name that becomes empty after trim', () => {
    const encoded = encodeServerMagicString({
      url: 'https://x.example',
      username: 'u',
      password: 'p',
      name: '   ',
    });
    const decoded = decodeServerMagicString(encoded);
    expect(decoded?.name).toBeUndefined();
  });

  it('rejects invalid input', () => {
    expect(decodeServerMagicString('')).toBeNull();
    expect(decodeServerMagicString('nope')).toBeNull();
    expect(decodeServerMagicString(`${SERVER_MAGIC_STRING_PREFIX}%%%`)).toBeNull();
  });

  it('rejects an empty payload after the prefix', () => {
    expect(decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX)).toBeNull();
    expect(decodeServerMagicString(`${SERVER_MAGIC_STRING_PREFIX}   `)).toBeNull();
  });

  it('rejects a payload that is not JSON', () => {
    // valid base64url of "not-json" → JSON.parse throws
    const garbage = `${SERVER_MAGIC_STRING_PREFIX}bm90LWpzb24`;
    expect(decodeServerMagicString(garbage)).toBeNull();
  });

  it('rejects a payload with the wrong version', () => {
    const wrongVersion = btoa(JSON.stringify({ v: 2, url: 'https://x', u: 'u', w: 'p' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + wrongVersion)).toBeNull();
  });

  it('rejects a payload missing url or username', () => {
    const noUrl = btoa(JSON.stringify({ v: 1, url: '', u: 'u', w: 'p' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + noUrl)).toBeNull();
    const noUser = btoa(JSON.stringify({ v: 1, url: 'https://x', u: '', w: 'p' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + noUser)).toBeNull();
  });

  it('rejects a payload where url/username are not strings', () => {
    const wrongTypes = btoa(JSON.stringify({ v: 1, url: 42, u: ['a'], w: 'p' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + wrongTypes)).toBeNull();
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

  it('rejects text that contains only the bare prefix', () => {
    expect(decodeServerMagicStringFromText(`prefix only: ${SERVER_MAGIC_STRING_PREFIX} done`)).toBeNull();
  });
});

describe('copyTextToClipboard', () => {
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    // setup.ts already installs a clipboard mock — start each test fresh.
    vi.mocked(navigator.clipboard.writeText).mockResolvedValue();
  });

  afterEach(() => {
    document.execCommand = originalExecCommand;
  });

  it('uses the modern clipboard API on success', async () => {
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand("copy") when clipboard API rejects', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
    const ok = await copyTextToClipboard('fallback-text');
    expect(ok).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('returns false when both clipboard API and execCommand fail', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    document.execCommand = vi.fn(() => {
      throw new Error('not allowed');
    }) as unknown as typeof document.execCommand;
    const ok = await copyTextToClipboard('x');
    expect(ok).toBe(false);
  });

  it('returns the result of execCommand even when it returns false', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    const ok = await copyTextToClipboard('x');
    expect(ok).toBe(false);
  });
});
