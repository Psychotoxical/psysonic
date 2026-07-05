/**
 * Wake a new full library cover pass (until catalog cursor exhausted).
 * Not used for periodic revalidate — that stays in `cover_revalidate_*`.
 */

const listeners = new Set<() => void>();

export function wakeLibraryCoverBackfill(): void {
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeLibraryCoverBackfillWake(handler: () => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}
