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
