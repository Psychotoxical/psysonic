// ListenBrainz — transport client.
//
// Thin wrapper over the Rust `listenbrainz_request` command. Same wire serves
// the direct api.listenbrainz.org preset and the Maloja /apis/listenbrainz
// compat surface — only baseUrl differs. Classifies failures into
// MusicNetworkError; no store access (runtime owns session-error state).

import { invokeTransport } from '../shared/invokeTransport';

export interface ListenBrainzEndpoint {
  baseUrl: string;
  authToken: string;
}

// listenbrainz_request returns "ListenBrainz <status> <msg>" on non-2xx.
const INVALID_TOKEN = /^ListenBrainz 401\b/;

export async function listenBrainzCall(
  ep: ListenBrainzEndpoint,
  path: string,
  jsonBody?: unknown,
): Promise<unknown> {
  return invokeTransport(
    'listenbrainz_request',
    {
      baseUrl: ep.baseUrl,
      path,
      authToken: ep.authToken,
      jsonBody: jsonBody ?? null,
    },
    { match: msg => INVALID_TOKEN.test(msg), code: 'AUTH_SESSION_INVALID' },
  );
}
