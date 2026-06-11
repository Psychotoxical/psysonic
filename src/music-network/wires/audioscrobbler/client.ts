// Audioscrobbler v2 — transport client.
//
// Thin wrapper over the Rust `audioscrobbler_request` command. Classifies
// failures into MusicNetworkError (auth-session-invalid vs network) but does NOT
// touch any store — session-error state is owned by the runtime, which clears it
// on a successful signed call and sets it on AUTH_SESSION_INVALID.

import { invoke } from '@tauri-apps/api/core';
import { MusicNetworkError } from '../../core/errors';

export interface AudioscrobblerEndpoint {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Auth/session detection. The generic transport prefixes Audioscrobbler errors
// with "Audioscrobbler <code> <message>". Real auth failures are matched by
// MESSAGE, not by numeric code: the codes collide across providers (Last.fm
// code 4 = "Authentication Failed", but Rocksky code 4 = a server-side "Failed
// to parse scrobbles" / 500 that must NOT flip the account to a reconnect
// state). Codes 9/14 are Last.fm/GNU FM session-key/token failures with no
// ambiguous message.
const SESSION_INVALID_CODE = /^Audioscrobbler (9|14)\b/;
const SESSION_INVALID_MESSAGE = /authentication failed|invalid (session|token)/i;

/**
 * Calls the Audioscrobbler endpoint. `sign` adds an api_sig; `get` uses GET
 * instead of a form POST. Throws MusicNetworkError on failure.
 */
export async function audioscrobblerCall(
  ep: AudioscrobblerEndpoint,
  params: Record<string, string>,
  sign = false,
  get = false,
): Promise<any> {
  const entries = Object.entries(params) as [string, string][];
  try {
    return await invoke('audioscrobbler_request', {
      baseUrl: ep.baseUrl,
      params: entries,
      sign,
      get,
      apiKey: ep.apiKey,
      apiSecret: ep.apiSecret,
    });
  } catch (e) {
    const msg = errMsg(e);
    if (sign && (SESSION_INVALID_CODE.test(msg) || SESSION_INVALID_MESSAGE.test(msg))) {
      throw new MusicNetworkError('AUTH_SESSION_INVALID', msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
