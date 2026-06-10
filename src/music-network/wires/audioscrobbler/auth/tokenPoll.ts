// Audioscrobbler v2 — token-poll connect flow (Last.fm / GNU FM family).
//
// 1. Request a token (auth.getToken).
// 2. Open the provider's auth page so the user authorizes the token.
// 3. Poll auth.getSession until a session key is granted, or time out.
//
// Mirrors the legacy IntegrationsTab connect flow, but as a reusable strategy.

import { MusicNetworkError } from '../../../core/errors';
import type { AuthStrategy } from '../../../contracts/AuthStrategy';
import type { ConnectContext, ConnectResult } from '../../../contracts/ScrobbleWire';
import { audioscrobblerCall } from '../client';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new MusicNetworkError('AUTH_TIMEOUT', 'Connect cancelled'));
    }, { once: true });
  });
}

async function getToken(ctx: ConnectContext): Promise<string> {
  const data = await audioscrobblerCall(ctx, { method: 'auth.getToken' }, false, true);
  const token = data?.token as string | undefined;
  if (!token) throw new MusicNetworkError('NETWORK', 'No token returned');
  return token;
}

function authUrl(authBase: string, apiKey: string, token: string): string {
  // authBase example: https://www.last.fm/api/auth/
  const sep = authBase.includes('?') ? '&' : '?';
  return `${authBase}${sep}api_key=${apiKey}&token=${token}`;
}

async function getSession(
  ctx: ConnectContext,
  token: string,
): Promise<{ key: string; name: string } | null> {
  try {
    const data = await audioscrobblerCall(ctx, { method: 'auth.getSession', token }, true, false);
    const key = data?.session?.key as string | undefined;
    const name = data?.session?.name as string | undefined;
    if (key && name) return { key, name };
    return null;
  } catch (e) {
    // Pre-authorization the provider returns auth errors; keep polling until timeout.
    if (e instanceof MusicNetworkError && e.code === 'AUTH_SESSION_INVALID') return null;
    return null;
  }
}

export const tokenPollStrategy: AuthStrategy = {
  id: 'token_poll',

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    const token = await getToken(ctx);
    await ctx.openExternal(authUrl(ctx.authBase, ctx.apiKey, token));

    const deadline = POLL_TIMEOUT_MS;
    let waited = 0;
    while (waited < deadline) {
      await delay(POLL_INTERVAL_MS, ctx.signal);
      waited += POLL_INTERVAL_MS;
      const session = await getSession(ctx, token);
      if (session) {
        return { sessionKey: session.key, username: session.name };
      }
    }
    throw new MusicNetworkError('AUTH_TIMEOUT', 'Authorization timed out');
  },
};
