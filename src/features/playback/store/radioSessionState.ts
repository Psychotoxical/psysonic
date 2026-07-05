/**
 * Per-session bookkeeping for the radio-feature (auto-mix tail of
 * tracks based on a seed artist):
 *
 *  - **radioFetching** — concurrent-fetch guard. Stops two parallel
 *    `getSimilarSongs` / `getTopSongs` requests from racing each other
 *    when both `next()` and the proactive top-up path fire close
 *    together.
 *
 *  - **currentRadioArtistId** — the seed artist that started the
 *    current radio session. Survives track advances so subsequent
 *    top-ups can resolve a new tail even when the now-playing track
 *    has no `artistId` of its own.
 *
 *  - **radioSessionSeenIds** — every id the current radio session has
 *    enqueued so far, *including* entries that were trimmed off the
 *    front of the queue once it grew past `HISTORY_KEEP`. Without this
 *    set, the queue's own id-set wasn't enough to dedupe: a song
 *    played 8 tracks ago is gone from the queue and the next
 *    Last.fm / topSongs response could re-add it (issue #500). Reset
 *    on `setRadioArtistId(other)` and on `clearQueue()`.
 */

let radioFetching = false;
let currentRadioArtistId: string | null = null;
let radioSessionSeenIds = new Set<string>();

export function isRadioFetching(): boolean {
  return radioFetching;
}

export function setRadioFetching(value: boolean): void {
  radioFetching = value;
}

export function getCurrentRadioArtistId(): string | null {
  return currentRadioArtistId;
}

export function setCurrentRadioArtistId(id: string | null): void {
  currentRadioArtistId = id;
}

export function hasRadioSessionSeen(id: string): boolean {
  return radioSessionSeenIds.has(id);
}

export function addRadioSessionSeen(id: string): void {
  radioSessionSeenIds.add(id);
}

export function deleteRadioSessionSeen(id: string): void {
  radioSessionSeenIds.delete(id);
}

/** Drop every id the current session has remembered — call when the seed artist changes or the queue is cleared. */
export function clearRadioSessionSeenIds(): void {
  radioSessionSeenIds = new Set();
}

/** Test-only: reset all three pieces of state. */
export function _resetRadioSessionStateForTest(): void {
  radioFetching = false;
  currentRadioArtistId = null;
  radioSessionSeenIds = new Set();
}
