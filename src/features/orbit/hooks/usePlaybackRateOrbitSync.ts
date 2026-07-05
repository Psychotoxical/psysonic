import { useEffect } from 'react';
import { useOrbitStore } from '@/features/orbit/store/orbitStore';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';

/** Re-sync playback rate when Orbit enters or leaves shared playback. */
export function usePlaybackRateOrbitSync() {
  const role = useOrbitStore(s => s.role);
  const phase = useOrbitStore(s => s.phase);

  useEffect(() => {
    usePlaybackRateStore.getState().syncToRust();
  }, [role, phase]);
}
