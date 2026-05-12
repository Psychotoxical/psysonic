/**
 * Persists the QueuePanel visibility toggle to localStorage so it
 * survives reloads. Defaults to true on the first run (no stored value)
 * and on SSR / non-DOM contexts (`typeof window === 'undefined'`).
 *
 * Storage failures (quota, private-mode) are silently ignored — the UI
 * keeps the in-memory state and the user just loses the persisted
 * preference after the next restart.
 */

const QUEUE_VISIBILITY_STORAGE_KEY = 'psysonic_queue_visible';

export function readInitialQueueVisibility(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(QUEUE_VISIBILITY_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // ignore storage access failures and fall back to default
  }
  return true;
}

export function persistQueueVisibility(visible: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUEUE_VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // ignore storage access failures
  }
}
