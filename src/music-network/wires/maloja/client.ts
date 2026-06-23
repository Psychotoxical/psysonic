// Maloja native — transport client.
//
// Thin wrapper over the Rust `maloja_request` command (native /apis/mlj_1 JSON).
// Classifies failures into MusicNetworkError; no store access.

import { invokeTransport } from '../shared/invokeTransport';

export interface MalojaEndpoint {
  baseUrl: string;
}

// maloja_request returns "Maloja <status> <msg>" on non-2xx.
const BAD_KEY = /^Maloja (401|403)\b/;

export async function malojaCall(
  ep: MalojaEndpoint,
  path: string,
  jsonBody?: unknown,
  query: [string, string][] = [],
): Promise<unknown> {
  return invokeTransport(
    'maloja_request',
    {
      baseUrl: ep.baseUrl,
      path,
      query,
      jsonBody: jsonBody ?? null,
    },
    { match: msg => BAD_KEY.test(msg), code: 'MALOJA_BAD_KEY' },
  );
}
