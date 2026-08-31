// Fans a playback event out to every enabled scrobble destination.
//
// Best-effort per destination: one failing never blocks the others. Filtering
// (master toggle, scrobbleEnabled, capability) happens in the facade so this
// stays a pure fan-out over the list it is given.
//
// Failure handling has one classifier, `deliver`, used by both the live path and
// the retry of an owed scrobble — so a queued play is judged exactly like a fresh
// one. A wire throwing AUTH_SESSION_INVALID flips that account's session-error
// flag (cleared on the next success).

import { MusicNetworkError } from '../core/errors';
import type { PersistedAccount } from '../core/accounts';
import type { ScrobbleEvent } from '../core/types';
import { getWire } from '../registry/wireRegistry';
import { resolveWireContext } from './contextResolver';

export interface OrchestratorDeps {
  /** Flip the persisted session-error flag for an account. */
  setSessionError(accountId: string, invalid: boolean): void;
  /**
   * Take custody of a play that failed on a transient error. Optional so the
   * now-playing path — which is worthless once late — can leave it unset.
   */
  onRetryable?(accountId: string, event: ScrobbleEvent): void;
}

type WireOp = 'scrobble' | 'updateNowPlaying';

/**
 * `retry` = the destination may accept this play later (transport-level trouble).
 * `drop` = it never will: a rejected session, an unsupported capability or a
 * misconfigured account. Queueing those would fill the queue with mail that can
 * never be delivered, so only transport failures are retryable.
 */
export type DeliveryOutcome = 'ok' | 'retry' | 'drop';

const RETRYABLE_CODES = new Set(['NETWORK', 'RESPONSE_NOT_JSON']);

/** Sends one event to one destination and classifies the outcome. */
export async function deliver(
  account: PersistedAccount,
  op: WireOp,
  event: ScrobbleEvent,
  deps: OrchestratorDeps,
): Promise<DeliveryOutcome> {
  const wire = getWire(account.wireId);
  if (!wire) return 'drop';
  try {
    await wire[op](resolveWireContext(account), event);
    if (account.sessionError) deps.setSessionError(account.id, false);
    return 'ok';
  } catch (e) {
    if (e instanceof MusicNetworkError) {
      if (e.code === 'AUTH_SESSION_INVALID') {
        deps.setSessionError(account.id, true);
        return 'drop';
      }
      return RETRYABLE_CODES.has(e.code) ? 'retry' : 'drop';
    }
    // An error the wires did not classify: treat as transport trouble rather
    // than discarding a play we cannot reproduce.
    return 'retry';
  }
}

async function dispatchOne(
  account: PersistedAccount,
  op: WireOp,
  event: ScrobbleEvent,
  deps: OrchestratorDeps,
): Promise<void> {
  const outcome = await deliver(account, op, event, deps);
  if (outcome === 'retry') deps.onRetryable?.(account.id, event);
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
  // No retry custody: a now-playing update is worthless by the time it lands.
  const { onRetryable: _drop, ...rest } = deps;
  await Promise.all(accounts.map(a => dispatchOne(a, 'updateNowPlaying', event, rest)));
}
