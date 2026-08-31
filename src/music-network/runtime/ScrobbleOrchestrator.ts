// Fans a playback event out to every enabled scrobble destination.
//
// Best-effort per destination: one failing never blocks the others. Filtering
// (master toggle, scrobbleEnabled, capability) happens in the facade so this
// stays a pure fan-out over the list it is given.
//
// Failure handling has one classifier, `deliver`, used by both the live path and
// the retry of an owed scrobble — so a queued play is judged exactly like a fresh
// one.

import { MusicNetworkError } from '../core/errors';
import type { PersistedAccount } from '../core/accounts';
import type { ScrobbleEvent } from '../core/types';
import { getWire } from '../registry/wireRegistry';
import { resolveWireContext } from './contextResolver';

export interface OrchestratorDeps {
  /** Flip the persisted session-error flag for an account. */
  setSessionError(accountId: string, invalid: boolean): void;
  /**
   * Take custody of a play the destination could not receive yet. Optional so the
   * now-playing path — worthless once late — can leave it unset.
   */
  onRetryable?(account: PersistedAccount, event: ScrobbleEvent): void;
}

type WireOp = 'scrobble' | 'updateNowPlaying';

/**
 * `retry` = the destination may accept this play later. That covers transport
 * trouble and a rejected session: the session is repairable by reconnecting, and
 * the queue keys entries on the destination rather than the account id, so they
 * survive that repair.
 *
 * `drop` = it never will — an unsupported capability or a misconfigured account.
 * Queueing those would fill the queue with mail that can never be delivered.
 */
export type DeliveryOutcome = 'ok' | 'retry' | 'drop';

/**
 * Auth failures the user can repair by reconnecting. Both raise the session-error
 * flag that drives the reconnect prompt, and both keep the play: the queue is
 * keyed on the destination, so it survives the reconnect.
 *
 * MALOJA_BAD_KEY is any 401/403 from a Maloja instance — a rotated key, a
 * restart, or an auth gateway in front of it. Treating it as final discarded
 * every play silently while the card still read "Connected".
 */
const RECOVERABLE_AUTH_CODES = new Set(['AUTH_SESSION_INVALID', 'MALOJA_BAD_KEY']);

const RETRYABLE_CODES = new Set([...RECOVERABLE_AUTH_CODES, 'NETWORK', 'RESPONSE_NOT_JSON']);

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
      // Raise the flag that drives the reconnect prompt, and keep the play: the
      // flush skips a flagged account entirely, so nothing is re-sent while the
      // user has not reconnected yet.
      if (RECOVERABLE_AUTH_CODES.has(e.code)) deps.setSessionError(account.id, true);
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
  if (outcome === 'retry') deps.onRetryable?.(account, event);
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
