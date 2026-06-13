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

  it('returns the resolved API base (with suffix), not the raw field origin', async () => {
    // The runtime passes ctx.baseUrl already resolved to origin + selfHostedApiSuffix
    // (e.g. /apis/listenbrainz for Koito). The strategy must persist that, not the
    // bare fields.baseUrl — otherwise scrobbles miss the /apis/listenbrainz path.
    const res = await apiKeyOnlyStrategy.connect(
      ctx(
        { token: 't', baseUrl: 'https://koito.example' },
        'https://koito.example/apis/listenbrainz',
      ),
    );
    expect(res.baseUrl).toBe('https://koito.example/apis/listenbrainz');
  });

  it('falls back to the context baseUrl when no field given', async () => {
    const res = await apiKeyOnlyStrategy.connect(ctx({ token: 't' }, 'https://api.listenbrainz.org'));
    expect(res.baseUrl).toBe('https://api.listenbrainz.org');
  });
});
