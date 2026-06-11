// Fans a playback event out to every enabled scrobble destination.
//
// Best-effort: one destination failing never blocks the others. A wire that
// throws AUTH_SESSION_INVALID flips that account's session-error flag (cleared
// on the next success); other errors are swallowed (the wires already log).
// Filtering (master toggle, scrobbleEnabled, capability) happens in the facade
// so this stays a pure fan-out over the list it is given.

import { MusicNetworkError } from '../core/errors';
import type { PersistedAccount } from '../core/accounts';
import type { ScrobbleEvent } from '../core/types';
import { getWire } from '../registry/wireRegistry';
import { resolveWireContext } from './contextResolver';

export interface OrchestratorDeps {
  /** Flip the persisted session-error flag for an account. */
  setSessionError(accountId: string, invalid: boolean): void;
}

type WireOp = 'scrobble' | 'updateNowPlaying';

async function dispatchOne(
  account: PersistedAccount,
  op: WireOp,
  event: ScrobbleEvent,
  deps: OrchestratorDeps,
): Promise<void> {
  const wire = getWire(account.wireId);
  if (!wire) return;
  try {
    await wire[op](resolveWireContext(account), event);
    if (account.sessionError) deps.setSessionError(account.id, false);
  } catch (e) {
    if (e instanceof MusicNetworkError && e.code === 'AUTH_SESSION_INVALID') {
      deps.setSessionError(account.id, true);
    }
    // best-effort: swallow everything else
  }
}

export async function dispatchScrobble(
  accounts: PersistedAccount[],
  event: ScrobbleEvent,
  deps: OrchestratorDeps,
): Promise<void> {
  await Promise.all(accounts.map(a => dispatchOne(a, 'scrobble', event, deps)));
}

export async function dispatchNowPlaying(
  accounts: PersistedAccount[],
  event: ScrobbleEvent,
  deps: OrchestratorDeps,
): Promise<void> {
  await Promise.all(accounts.map(a => dispatchOne(a, 'updateNowPlaying', event, deps)));
}
