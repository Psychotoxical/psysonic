/**
 * Persisted shuffle-mode state.
 *
 * Kept out of the main `psysonic-player` blob (which already carries the whole
 * queue and can hit the localStorage quota) — same reasoning as
 * `playerPrefsStorage` / `queueVisibilityStorage`.
 *
 * Shuffle physically reorders `queueItems`, so "next track" stays "the next one
 * in the list" for the gapless chain, the server play-queue and Orbit guests.
 * The price is that turning shuffle off has to put the queue back — hence the
 * original order, remembered as track ids and persisted alongside the flag so it
 * survives a restart while shuffle is still on.
 */

const STORAGE_KEY = 'psysonic_shuffle_mode';

export interface ShuffleModeSnapshot {
  enabled: boolean;
  /** Track ids in their pre-shuffle order; empty when shuffle is off. */
  originalOrder: string[];
}

const EMPTY: ShuffleModeSnapshot = { enabled: false, originalOrder: [] };

export function readShuffleModeSnapshot(): ShuffleModeSnapshot {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<ShuffleModeSnapshot>;
    const originalOrder = Array.isArray(parsed.originalOrder)
      ? parsed.originalOrder.filter((id): id is string => typeof id === 'string')
      : [];
    const enabled = parsed.enabled === true;
    // A flag without an order cannot be un-shuffled, and an order without the
    // flag is dead weight — treat either half alone as "off".
    if (!enabled || originalOrder.length === 0) return EMPTY;
    return { enabled, originalOrder };
  } catch {
    return EMPTY;
  }
}

export function persistShuffleModeSnapshot(snapshot: ShuffleModeSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    if (!snapshot.enabled) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // best-effort — the in-memory order still works for this session
  }
}
