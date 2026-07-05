import type { OrbitPhase, OrbitRole } from '@/features/orbit/store/orbitStore';
import { useOrbitStore } from '@/features/orbit/store/orbitStore';

/**
 * True while this client is in an Orbit session on the shared playback path
 * (host/guest during start, join, or active play). Matches previewStore guard.
 */
export function isOrbitPlaybackSyncActive(
  role: OrbitRole | null = useOrbitStore.getState().role,
  phase: OrbitPhase = useOrbitStore.getState().phase,
): boolean {
  if (role !== 'host' && role !== 'guest') return false;
  return phase === 'active' || phase === 'joining' || phase === 'starting';
}
