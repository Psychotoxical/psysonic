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

/**
 * The provider answered, but with something that is not JSON — almost always an
 * HTML interstitial: a block page shown to a VPN exit node or datacentre IP, a
 * proxy/captive-portal login, or a CDN challenge. The Rust side decodes straight
 * to JSON without inspecting the status or content type, so all we get back is
 * reqwest's decode error; matching it here is the only signal available.
 *
 * Worth distinguishing because the fix is on the user's side (different exit
 * node, disable the proxy) while a plain NETWORK error reads as "the app or the
 * service is broken". A miss is harmless: the error falls through to NETWORK,
 * which is where it landed before.
 */
const NON_JSON_RESPONSE = /error decoding response body|expected value at line \d+ column \d+/i;

export interface TransportAuthRule {
  /** True when the error message indicates an auth/key failure for this wire. */
  match: (msg: string) => boolean;
  /** Code thrown when `match` hits (e.g. AUTH_SESSION_INVALID, MALOJA_BAD_KEY). */
  code: MusicNetworkErrorCode;
}

/**
 * Invoke a provider transport command. On failure, throws the auth-class
 * MusicNetworkError when `auth.match` recognises the message, RESPONSE_NOT_JSON
 * when the provider answered with a non-JSON body, otherwise NETWORK.
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
    if (NON_JSON_RESPONSE.test(msg)) {
      throw new MusicNetworkError('RESPONSE_NOT_JSON', msg, { cause: e });
    }
    throw new MusicNetworkError('NETWORK', msg, { cause: e });
  }
}
