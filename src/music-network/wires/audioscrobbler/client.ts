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

// Last.fm / GNU FM error codes 4, 9, 14 = auth/session invalid.
const SESSION_INVALID = /^Last\.fm (4|9|14)\b/;

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
    if (sign && SESSION_INVALID.test(msg)) {
      throw new MusicNetworkError('AUTH_SESSION_INVALID', msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
