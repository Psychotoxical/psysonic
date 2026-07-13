// The NETWORK code is the transport catch-all — a DNS failure, a broken TLS
// handshake and an unrecognised provider API error all land on it, so its
// translated string alone tells a reporter (and us) nothing. These tests pin
// that the underlying cause travels with it, and only with it: every other code
// already names its failure and must stay clean.

import { describe, expect, it } from 'vitest';
import { MusicNetworkError, errorDetail, errorI18nKey } from './errors';

describe('errorI18nKey', () => {
  it('maps a code to its namespaced key', () => {
    expect(errorI18nKey('NETWORK')).toBe('musicNetwork.errors.NETWORK');
  });
});

describe('errorDetail', () => {
  it('returns the transport message for a NETWORK error', () => {
    const e = new MusicNetworkError('NETWORK', 'error sending request for url (https://ws.audioscrobbler.com/2.0/)');
    expect(errorDetail(e)).toBe('error sending request for url (https://ws.audioscrobbler.com/2.0/)');
  });

  it('trims surrounding whitespace', () => {
    expect(errorDetail(new MusicNetworkError('NETWORK', '  dns error  '))).toBe('dns error');
  });

  it('caps an overlong message so it cannot blow up the form', () => {
    const detail = errorDetail(new MusicNetworkError('NETWORK', 'x'.repeat(500)));
    expect(detail).toHaveLength(200);
  });

  it('stays empty for codes whose own message is already specific', () => {
    expect(errorDetail(new MusicNetworkError('AUTH_SESSION_INVALID', 'Audioscrobbler 9 Invalid session key'))).toBe('');
    expect(errorDetail(new MusicNetworkError('AUTH_TIMEOUT', 'Authorization timed out'))).toBe('');
    expect(errorDetail(new MusicNetworkError('CUSTOM_URL_INVALID', 'bad url'))).toBe('');
  });
});
