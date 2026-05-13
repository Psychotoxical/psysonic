/**
 * Orbit — multi-user listen-together feature.
 *
 * This file is a re-export shim. Implementation lives under `utils/orbit/`:
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
 *
 * Importers everywhere else in the codebase keep using `'../utils/orbit'`;
 * this shim re-exports every public symbol unchanged.
 */

export {
  ORBIT_HEARTBEAT_ALIVE_MS,
  ORBIT_ORPHAN_TTL_MS,
  ORBIT_REMOVED_TTL_MS,
  ORBIT_SHUFFLE_INTERVAL_MS,
} from './orbit/constants';
export {
  generateSessionId,
  OrbitStateTooLarge,
  serialiseOrbitState,
  suggestionKey,
} from './orbit/helpers';
export {
  applyOutboxSnapshotsToState,
  computeOrbitDriftMs,
  effectiveShuffleIntervalMs,
  maybeShuffleQueue,
  patchOrbitState,
} from './orbit/stateMath';
export {
  findSessionPlaylistId,
  readOrbitState,
  writeOrbitHeartbeat,
  writeOrbitState,
} from './orbit/remote';
export {
  buildOrbitShareLink,
  parseOrbitShareLink,
  type OrbitShareLink,
} from './orbit/shareLink';
export {
  endOrbitSession,
  hostEnqueueToOrbit,
  startOrbitSession,
  triggerOrbitShuffleNow,
  updateOrbitSettings,
  type StartOrbitArgs,
} from './orbit/host';
export {
  kickOrbitParticipant,
  removeOrbitParticipant,
  setOrbitSuggestionBlocked,
} from './orbit/moderation';
export {
  approveOrbitSuggestion,
  declineOrbitSuggestion,
  evaluateOrbitSuggestGate,
  joinOrbitSession,
  leaveOrbitSession,
  OrbitJoinError,
  OrbitSuggestBlockedError,
  suggestOrbitTrack,
  type OrbitSuggestGateReason,
} from './orbit/guest';
export { sweepGuestOutboxes } from './orbit/sweep';
export { cleanupOrphanedOrbitPlaylists } from './orbit/cleanup';
