/**
 * Orbit utils aggregator — re-exports every public symbol from the sibling
 * `utils/*` modules under one specifier. Orbit's own components/hooks import
 * from here; the rest of the app goes through the feature barrel (`index.ts`).
 *
 *   - `constants.ts`   — cadence + TTL ms values.
 *   - `helpers.ts`     — pure utilities (id gen, serialisation, key fns).
 *   - `stateMath.ts`   — pure state transforms (shuffle, drift, sweep merge).
 *   - `remote.ts`      — Navidrome playlist comment I/O.
 *   - `shareLink.ts`   — invite magic-string encode/decode.
 *   - `host.ts`        — host session lifecycle (start, end, settings, enqueue).
 *   - `moderation.ts`  — host kicks / soft-removes / mutes.
 *   - `guest.ts`       — guest join/leave + suggestion pipeline + host
 *                        approve/decline reactions.
 *   - `sweep.ts`       — host-side outbox sweep loop.
 *   - `cleanup.ts`     — app-start orphan playlist sweep.
 */

export {
  ORBIT_HEARTBEAT_ALIVE_MS,
  ORBIT_ORPHAN_TTL_MS,
  ORBIT_REMOVED_TTL_MS,
  ORBIT_SHUFFLE_INTERVAL_MS,
} from './constants';
export {
  generateSessionId,
  makeCoalescedRunner,
  OrbitStateTooLarge,
  serialiseOrbitState,
  suggestionKey,
} from './helpers';
export { isOrbitPlaybackSyncActive } from './sessionActive';
export {
  applyOutboxSnapshotsToState,
  computeOrbitDriftMs,
  effectiveShuffleIntervalMs,
  maybeShuffleQueue,
  patchOrbitState,
} from './stateMath';
export {
  findSessionPlaylistId,
  readOrbitState,
  writeOrbitHeartbeat,
  writeOrbitState,
} from './remote';
export {
  readOrbitTransitionSettings,
  applyOrbitTransitionSettings,
  saveGuestTransitionsOnce,
  restoreGuestTransitions,
} from './transitions';
export {
  buildOrbitShareLink,
  parseOrbitShareLink,
  type OrbitShareLink,
} from './shareLink';
export {
  endOrbitSession,
  hostEnqueueToOrbit,
  startOrbitSession,
  triggerOrbitShuffleNow,
  updateOrbitSettings,
  type StartOrbitArgs,
} from './host';
export {
  kickOrbitParticipant,
  removeOrbitParticipant,
  setOrbitSuggestionBlocked,
} from './moderation';
export {
  approveOrbitSuggestion,
  declineOrbitSuggestion,
  ensureTrackInOutbox,
  evaluateOrbitSuggestGate,
  joinOrbitSession,
  leaveOrbitSession,
  OrbitJoinError,
  OrbitSuggestBlockedError,
  suggestOrbitTrack,
  type OrbitSuggestGateReason,
} from './guest';
export {
  forgetPendingSuggestion,
  planPendingResends,
  resetPendingResendState,
} from './pendingResend';
export { sweepGuestOutboxes } from './sweep';
export { cleanupOrphanedOrbitPlaylists } from './cleanup';
