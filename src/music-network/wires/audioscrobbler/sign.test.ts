import { describe, expect, it } from 'vitest';
import { buildSignatureBaseString } from './sign';

describe('buildSignatureBaseString', () => {
  it('sorts params alphabetically and concatenates key+value with api_key', () => {
    const sig = buildSignatureBaseString(
      { method: 'track.scrobble', track: 'Y', artist: 'X' },
      'KEY',
    );
    // sorted: api_key, artist, method, track
    expect(sig).toBe('api_keyKEYartistXmethodtrack.scrobbletrackY');
  });

  it('excludes format and callback from the signature', () => {
    const withMeta = buildSignatureBaseString(
      { method: 'auth.getSession', token: 'T', format: 'json', callback: 'cb' },
      'KEY',
    );
    const withoutMeta = buildSignatureBaseString(
      { method: 'auth.getSession', token: 'T' },
      'KEY',
    );
    expect(withMeta).toBe(withoutMeta);
    expect(withMeta).not.toContain('json');
  });

  it('is deterministic regardless of input key order', () => {
    const a = buildSignatureBaseString({ b: '2', a: '1', c: '3' }, 'K');
    const b = buildSignatureBaseString({ c: '3', a: '1', b: '2' }, 'K');
    expect(a).toBe(b);
  });
});
