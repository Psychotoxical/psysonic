// Maloja native — transport client.
//
// Thin wrapper over the Rust `maloja_request` command (native /apis/mlj_1 JSON).
// Classifies failures into MusicNetworkError; no store access.

import { invoke } from '@tauri-apps/api/core';
import { MusicNetworkError } from '../../core/errors';

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
): Promise<any> {
  try {
    return await invoke('maloja_request', {
      baseUrl: ep.baseUrl,
      path,
      query,
      jsonBody: jsonBody ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (BAD_KEY.test(msg)) {
      throw new MusicNetworkError('MALOJA_BAD_KEY', msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
