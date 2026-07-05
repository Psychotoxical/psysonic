/**
 * Concurrent-fetch guard for the infinite-queue feature. Stops a second
 * `buildInfiniteQueueCandidates` request from running while the first
 * is still pending — without it, switching tracks quickly while the
 * infinite tail is loading would race two enqueue actions and the
 * second would clobber the first's results.
 */

let infiniteQueueFetching = false;

export function isInfiniteQueueFetching(): boolean {
  return infiniteQueueFetching;
}

export function setInfiniteQueueFetching(value: boolean): void {
  infiniteQueueFetching = value;
}

/** Test-only: reset the guard. */
export function _resetInfiniteQueueStateForTest(): void {
  infiniteQueueFetching = false;
}
