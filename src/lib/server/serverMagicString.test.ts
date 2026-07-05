import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_MAGIC_STRING_PREFIX,
  DECODED_PASSWORD_VISUAL_MASK,
  copyTextToClipboard,
  decodeServerMagicString,
  decodeServerMagicStringFromText,
  encodeServerMagicString,
} from '@/lib/server/serverMagicString';

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

  it('rejects a payload with an unknown version', () => {
    // v: 3 is out of range; v1 + v2 are both accepted.
    const wrongVersion = btoa(JSON.stringify({ v: 3, url: 'https://x', u: 'u', w: 'p' }))
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

  // ─── v2 (dual-address) ──────────────────────────────────────────────────

  it('emits v1 for a single-address invite (backward-compatible)', () => {
    // No alternateUrl, no shareUsesLocalUrl → v1 wire format. Verified by
    // round-tripping through a v1-decode of the inner JSON.
    const encoded = encodeServerMagicString({
      url: 'https://music.example.com',
      username: 'alice',
      password: 'pw',
    });
    const b64 = encoded.slice(SERVER_MAGIC_STRING_PREFIX.length);
    const b64Std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64Std + '='.repeat((4 - (b64Std.length % 4)) % 4);
    const inner = JSON.parse(atob(padded));
    expect(inner.v).toBe(1);
    expect(inner.alt).toBeUndefined();
    expect(inner.shareLocal).toBeUndefined();
  });

  it('emits v2 when alternateUrl is set', () => {
    const encoded = encodeServerMagicString({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      username: 'alice',
      password: 'pw',
    });
    const b64 = encoded.slice(SERVER_MAGIC_STRING_PREFIX.length);
    const b64Std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64Std + '='.repeat((4 - (b64Std.length % 4)) % 4);
    const inner = JSON.parse(atob(padded));
    expect(inner.v).toBe(2);
    expect(inner.url).toBe('https://music.example.com');
    expect(inner.alt).toBe('http://192.168.0.10:4533');
    expect(inner.shareLocal).toBeUndefined();
  });

  it('emits v2 when only shareUsesLocalUrl is set (no alt)', () => {
    // Edge: the host has dropped the second address but kept the share flag
    // on. We still emit v2 so the receiver picks up the preference.
    const encoded = encodeServerMagicString({
      url: 'https://music.example.com',
      username: 'alice',
      password: 'pw',
      shareUsesLocalUrl: true,
    });
    const b64 = encoded.slice(SERVER_MAGIC_STRING_PREFIX.length);
    const b64Std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64Std + '='.repeat((4 - (b64Std.length % 4)) % 4);
    const inner = JSON.parse(atob(padded));
    expect(inner.v).toBe(2);
    expect(inner.alt).toBeUndefined();
    expect(inner.shareLocal).toBe(true);
  });

  it('round-trips v2 with alternateUrl + shareUsesLocalUrl + name', () => {
    const original = {
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      shareUsesLocalUrl: true,
      username: 'alice',
      password: 'pw',
      name: 'Home',
    };
    const encoded = encodeServerMagicString(original);
    expect(decodeServerMagicString(encoded)).toEqual(original);
  });

  it('round-trips v2 with alternateUrl only (default share flag absent)', () => {
    const original = {
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      username: 'alice',
      password: 'pw',
    };
    const decoded = decodeServerMagicString(encodeServerMagicString(original));
    expect(decoded).toEqual(original);
    // shareUsesLocalUrl must NOT be set on the decoded payload when the
    // host didn't flip the flag — kept absent rather than `false` so
    // existing zustand persist diffs stay clean.
    expect(decoded?.shareUsesLocalUrl).toBeUndefined();
  });

  it('decodes a v1 invite without alternateUrl / shareUsesLocalUrl', () => {
    // Hand-built v1 payload → verify backward-compat decode path leaves the
    // v2-only fields undefined.
    const v1 = btoa(JSON.stringify({ v: 1, url: 'https://x.example', u: 'u', w: 'p' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + v1);
    expect(decoded?.url).toBe('https://x.example');
    expect(decoded?.alternateUrl).toBeUndefined();
    expect(decoded?.shareUsesLocalUrl).toBeUndefined();
  });

  it('treats an empty alt field on v2 as absent (no alternateUrl)', () => {
    // Defensive — a misformed v2 invite with `alt: ''` should decode as if
    // no alternate were set, not as an empty-string alternateUrl that
    // would later fail isLanUrl / normalize checks.
    const v2 = btoa(JSON.stringify({
      v: 2, url: 'https://x.example', alt: '   ', u: 'u', w: 'p',
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeServerMagicString(SERVER_MAGIC_STRING_PREFIX + v2);
    expect(decoded?.alternateUrl).toBeUndefined();
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
