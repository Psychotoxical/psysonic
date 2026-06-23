// Music Network — shared wire transport helper.
//
// Every provider client (audioscrobbler / listenbrainz / maloja) wraps a Rust
// `*_request` command with the same boilerplate: invoke, and on failure classify
// the error message into an auth-class MusicNetworkError (per the wire's own
// heuristic) or a generic NETWORK one. That boilerplate lives here; each wire
// keeps its own arg shape and auth rule. No store access — the runtime owns
// session-error state.

import { invoke } from '@tauri-apps/api/core';
import { MusicNetworkError, type MusicNetworkErrorCode } from '../../core/errors';

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface TransportAuthRule {
  /** True when the error message indicates an auth/key failure for this wire. */
  match: (msg: string) => boolean;
  /** Code thrown when `match` hits (e.g. AUTH_SESSION_INVALID, MALOJA_BAD_KEY). */
  code: MusicNetworkErrorCode;
}

/**
 * Invoke a provider transport command. On failure, throws the auth-class
 * MusicNetworkError when `auth.match` recognises the message, otherwise NETWORK.
 */
export async function invokeTransport<T = unknown>(
  command: string,
  args: Record<string, unknown>,
  auth?: TransportAuthRule,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    const msg = errMsg(e);
    if (auth?.match(msg)) {
      throw new MusicNetworkError(auth.code, msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
