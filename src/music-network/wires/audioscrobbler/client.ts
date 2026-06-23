// Audioscrobbler v2 — transport client.
//
// Thin wrapper over the Rust `audioscrobbler_request` command. Classifies
// failures into MusicNetworkError (auth-session-invalid vs network) but does NOT
// touch any store — session-error state is owned by the runtime, which clears it
// on a successful signed call and sets it on AUTH_SESSION_INVALID.

import { invokeTransport } from '../shared/invokeTransport';

export interface AudioscrobblerEndpoint {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
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
 *
 * Returns the raw decoded JSON. Last.fm / Audioscrobbler responses are
 * deeply-nested, loosely-documented and vary per method; the wire narrows and
 * coerces fields at each use, so precisely typing every response is not
 * tractable for this external API we do not control.
 */
export async function audioscrobblerCall(
  ep: AudioscrobblerEndpoint,
  params: Record<string, string>,
  sign = false,
  get = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- external Last.fm JSON, shape not under our control (see doc above)
): Promise<any> {
  const entries = Object.entries(params) as [string, string][];
  return invokeTransport(
    'audioscrobbler_request',
    {
      baseUrl: ep.baseUrl,
      params: entries,
      sign,
      get,
      apiKey: ep.apiKey,
      apiSecret: ep.apiSecret,
    },
    {
      // Only signed calls carry a session key, so an unsigned failure is never
      // an auth-session problem.
      match: msg => sign && (SESSION_INVALID_CODE.test(msg) || SESSION_INVALID_MESSAGE.test(msg)),
      code: 'AUTH_SESSION_INVALID',
    },
  );
}
