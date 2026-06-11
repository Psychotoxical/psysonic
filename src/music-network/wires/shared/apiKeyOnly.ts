// Shared api_key_only connect strategy.
//
// Used by every paste-auth provider: ListenBrainz (user token), Maloja (API
// key), Rocksky (session key from `rocksky login`). There is no browser flow —
// the user supplies the credential directly. Validation happens in the wire's
// probe() right after connect, so this strategy only normalizes the inputs.
//
// Field convention (preset declares these in PresetManifest.fields):
//   token    — the credential (LB token / Maloja key / Rocksky session key)
//   username — optional display/account name
//   baseUrl  — optional, for self-hosted instances

import { MusicNetworkError } from '../../core/errors';
import type { AuthStrategy } from '../../contracts/AuthStrategy';
import type { ConnectContext, ConnectResult } from '../../contracts/ScrobbleWire';

export const apiKeyOnlyStrategy: AuthStrategy = {
  id: 'api_key_only',

  async connect(ctx: ConnectContext): Promise<ConnectResult> {
    const token = (ctx.fields.token ?? '').trim();
    if (!token) {
      throw new MusicNetworkError('AUTH_SESSION_INVALID', 'A token or API key is required', {
        providerId: ctx.presetId,
      });
    }
    const baseUrl = (ctx.fields.baseUrl ?? '').trim() || ctx.baseUrl;
    return {
      sessionKey: token,
      username: (ctx.fields.username ?? '').trim(),
      baseUrl: baseUrl || undefined,
    };
  },
};
