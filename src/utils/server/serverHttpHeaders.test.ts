import { describe, expect, it } from 'vitest';
import {
  headersForServerRequest,
  requestBaseUrlFromHttpUrl,
  validateCustomHeaders,
} from './serverHttpHeaders';

describe('requestBaseUrlFromHttpUrl', () => {
  it('strips /rest/ path and query from stream URLs', () => {
    expect(
      requestBaseUrlFromHttpUrl(
        'https://music.example.com/rest/stream.view?id=1&u=x&t=y&s=z',
      ),
    ).toBe('https://music.example.com');
  });

  it('strips /api/ Navidrome paths', () => {
    expect(requestBaseUrlFromHttpUrl('https://nd.local/api/album')).toBe('https://nd.local');
  });
});

describe('headersForServerRequest', () => {
  const profile = {
    url: 'https://music.example.com',
    alternateUrl: 'http://192.168.1.10:4533',
    customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'secret' }],
    customHeadersApplyTo: 'public' as const,
  };

  it('applies headers on public endpoint only when applyTo is public', () => {
    expect(headersForServerRequest(profile, 'https://music.example.com')).toEqual({
      'CF-Access-Client-Secret': 'secret',
    });
    expect(headersForServerRequest(profile, 'http://192.168.1.10:4533')).toEqual({});
  });

  it('returns empty for foreign base URL', () => {
    expect(headersForServerRequest(profile, 'https://other.example.com')).toEqual({});
  });
});

describe('validateCustomHeaders', () => {
  it('rejects blocked header names', () => {
    const result = validateCustomHeaders([{ name: 'Host', value: 'x' }]);
    expect(result.ok).toBe(false);
  });

  it('accepts valid rows', () => {
    expect(
      validateCustomHeaders([{ name: 'X-Custom', value: 'ok' }]),
    ).toEqual({ ok: true });
  });
});
