import { useEffect } from 'react';
import { useOrbitStore } from '../store/orbitStore';

/**
 * Mirror the live Orbit role + phase onto `<html data-orbit-active>` and
 * `<html data-orbit-role>` so global CSS can hide controls that conflict
 * with an active Orbit session (e.g. track preview steps on shared
 * playback) or style host-vs-guest UI states (read-only guest seekbar).
 * Covers any pre-`active` phase so the marker spans the join lifecycle.
 */
export function useOrbitBodyAttrs(): void {
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);
  useEffect(() => {
    const inOrbit = (orbitRole === 'host' || orbitRole === 'guest')
      && (orbitPhase === 'active' || orbitPhase === 'joining' || orbitPhase === 'starting');
    if (inOrbit) {
      document.documentElement.setAttribute('data-orbit-active', 'true');
      document.documentElement.setAttribute('data-orbit-role', orbitRole as string);
    } else {
      document.documentElement.removeAttribute('data-orbit-active');
      document.documentElement.removeAttribute('data-orbit-role');
    }
  }, [orbitRole, orbitPhase]);
}
