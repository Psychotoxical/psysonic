// ListenBrainz — transport client.
//
// Thin wrapper over the Rust `listenbrainz_request` command. Same wire serves
// the direct api.listenbrainz.org preset and the Maloja /apis/listenbrainz
// compat surface — only baseUrl differs. Classifies failures into
// MusicNetworkError; no store access (runtime owns session-error state).

import { invoke } from '@tauri-apps/api/core';
import { MusicNetworkError } from '../../core/errors';

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
): Promise<any> {
  try {
    return await invoke('listenbrainz_request', {
      baseUrl: ep.baseUrl,
      path,
      authToken: ep.authToken,
      jsonBody: jsonBody ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (INVALID_TOKEN.test(msg)) {
      throw new MusicNetworkError('AUTH_SESSION_INVALID', msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
