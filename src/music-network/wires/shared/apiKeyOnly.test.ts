import { describe, expect, it } from 'vitest';
import { apiKeyOnlyStrategy } from './apiKeyOnly';
import { MusicNetworkError } from '../../core/errors';
import type { ConnectContext } from '../../contracts/ScrobbleWire';

function ctx(fields: Record<string, string>, baseUrl = ''): ConnectContext {
  return {
    presetId: 'listenbrainz',
    wireId: 'listenbrainz',
    authStrategy: 'api_key_only',
    baseUrl,
    authBase: '',
    apiKey: '',
    apiSecret: '',
    fields,
    openExternal: async () => {},
  };
}

describe('apiKeyOnlyStrategy', () => {
  it('maps the pasted token to the session key', async () => {
    const res = await apiKeyOnlyStrategy.connect(ctx({ token: '  abc-123  ', username: ' me ' }));
    expect(res.sessionKey).toBe('abc-123');
    expect(res.username).toBe('me');
  });

  it('throws AUTH_SESSION_INVALID when no token is given', async () => {
    await expect(apiKeyOnlyStrategy.connect(ctx({ token: '   ' }))).rejects.toMatchObject({
      code: 'AUTH_SESSION_INVALID',
    });
    await expect(apiKeyOnlyStrategy.connect(ctx({}))).rejects.toBeInstanceOf(MusicNetworkError);
  });

  it('prefers a field baseUrl over the context baseUrl', async () => {
    const res = await apiKeyOnlyStrategy.connect(
      ctx({ token: 't', baseUrl: 'https://maloja.example' }, 'https://fallback'),
    );
    expect(res.baseUrl).toBe('https://maloja.example');
  });

  it('falls back to the context baseUrl when no field given', async () => {
    const res = await apiKeyOnlyStrategy.connect(ctx({ token: 't' }, 'https://api.listenbrainz.org'));
    expect(res.baseUrl).toBe('https://api.listenbrainz.org');
  });
});
