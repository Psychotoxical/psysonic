// Music Network — typed errors.
//
// Wires and the runtime throw MusicNetworkError with a stable code; the UI maps
// the code to an i18n key under `musicNetwork.errors.*` and shows a toast. The
// optional providerId / capability give the toast extra context.

import type { CapabilityId } from './capabilities';

export type MusicNetworkErrorCode =
  | 'AUTH_SESSION_INVALID'
  | 'AUTH_TIMEOUT'
  | 'PROBE_FAILED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'NETWORK'
  | 'MALOJA_BAD_KEY'
  | 'CUSTOM_URL_INVALID';

export class MusicNetworkError extends Error {
  readonly code: MusicNetworkErrorCode;
  readonly providerId?: string;
  readonly capability?: CapabilityId;
  readonly cause?: unknown;

  constructor(
    code: MusicNetworkErrorCode,
    message: string,
    opts: { providerId?: string; capability?: CapabilityId; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MusicNetworkError';
    this.code = code;
    this.providerId = opts.providerId;
    this.capability = opts.capability;
    this.cause = opts.cause;
  }
}

export function isMusicNetworkError(e: unknown): e is MusicNetworkError {
  return e instanceof MusicNetworkError;
}

/** Maps an error code to its i18n key under the `musicNetwork.errors` namespace. */
export function errorI18nKey(code: MusicNetworkErrorCode): string {
  return `musicNetwork.errors.${code}`;
}

/** Longest transport detail we append to a translated message. */
const DETAIL_MAX_LEN = 200;

/**
 * The transport detail behind a NETWORK error, for display next to the
 * translated message.
 *
 * NETWORK is the catch-all: a DNS failure, a TLS handshake broken by a proxy or
 * AV, a timeout and a provider API error the auth classifier did not recognise
 * all collapse into it. Its i18n string therefore cannot say what went wrong,
 * and a user report that quotes only that string is not actionable. Every other
 * code names its own failure, so it needs no detail.
 */
export function errorDetail(e: MusicNetworkError): string {
  if (e.code !== 'NETWORK') return '';
  return e.message.trim().slice(0, DETAIL_MAX_LEN);
}
