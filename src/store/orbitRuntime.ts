// Orbit seam. The audio core must react to an active Orbit session — suppress
// local playback-rate, catch a guest up to the host's live position, gate bulk
// queue ops behind a confirm dialog — but must not import @/features/orbit (iron
// rule). The orbit feature registers its runtime here at boot (orbitBulkGuard.ts
// module init, evaluated via the @/features/orbit barrel the topbar imports); the
// audio core reads this neutral surface.
//
// Default (unregistered) = no session: snapshot is neutral and bulkGuard allows —
// identical to today's behavior outside an Orbit session. A session can only start
// through the topbar, which loads the barrel (→ registers) before any session
// exists, so the registered runtime is always in place when it matters.
import type { OrbitRole, OrbitPhase, OrbitState } from '@/features/orbit'; // type-only (erased at runtime)

export interface OrbitSnapshot {
  role: OrbitRole | null;
  phase: OrbitPhase;
  state: OrbitState | null;
}

const NEUTRAL: OrbitSnapshot = { role: null, phase: 'idle', state: null };

export interface OrbitRuntime {
  getSnapshot(): OrbitSnapshot;
  bulkGuard(count: number): Promise<boolean>;
}

let runtime: OrbitRuntime | null = null;

/** Orbit feature installs its store-backed snapshot + confirm-modal gate here. */
export function registerOrbitRuntime(rt: OrbitRuntime): void {
  runtime = rt;
}

/** True once the orbit feature installs its runtime. For the boot-registration smoke guard. */
export function isOrbitRuntimeRegistered(): boolean {
  return runtime !== null;
}

export function orbitSnapshot(): OrbitSnapshot {
  return runtime?.getSnapshot() ?? NEUTRAL;
}

/**
 * Ask before dropping many tracks into a shared Orbit queue. Resolves `true` when
 * there's no session, `count <= 1`, or the user accepted; `false` only when an
 * active-Orbit user cancelled. Default (no runtime registered) = allow.
 */
export function orbitBulkGuard(count: number): Promise<boolean> {
  return runtime ? runtime.bulkGuard(count) : Promise.resolve(true);
}

// Pure derivations mirrored from the orbit feature (sessionActive.ts /
// orbitSession.ts / api/orbit.ts). Duplicated here so the audio core needs no
// feature import; the feature keeps its own copies (incl. the UI arg-form of
// isOrbitPlaybackSyncActive). Keep in sync if the orbit lifecycle phases change.
function isSyncingPhase(role: OrbitRole | null, phase: OrbitPhase): boolean {
  if (role !== 'host' && role !== 'guest') return false;
  return phase === 'active' || phase === 'joining' || phase === 'starting';
}

export function isInOrbitSession(): boolean {
  const { role, phase } = orbitSnapshot();
  return isSyncingPhase(role, phase);
}

export function isOrbitPlaybackSyncActive(): boolean {
  const { role, phase } = orbitSnapshot();
  return isSyncingPhase(role, phase);
}

export function estimateLivePosition(state: OrbitState, nowMs: number): number {
  return state.isPlaying ? state.positionMs + (nowMs - state.positionAt) : state.positionMs;
}
