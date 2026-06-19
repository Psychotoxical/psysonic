/** UI hint: user switched browse server; manual pull is suggested until sync. */

let queueHandoffPending = false;

export function markQueueHandoffPending(): void {
  queueHandoffPending = true;
}

export function clearQueueHandoffPending(): void {
  queueHandoffPending = false;
}

export function isQueueHandoffPending(): boolean {
  return queueHandoffPending;
}

/** Test-only reset. */
export function _resetQueueSyncUiForTest(): void {
  queueHandoffPending = false;
}
