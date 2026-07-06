import { useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/playerStore';

/**
 * Volume with a mute toggle that restores the pre-mute level. Unlike a ref set
 * only at mute time, this continuously remembers the last non-zero volume, so
 * unmuting after the user dragged the slider to 0 (rather than clicking mute)
 * still restores a sensible level instead of a stale one.
 */
export function useVolumeToggle() {
  const volume = usePlayerStore(s => s.volume);
  const setVolume = usePlayerStore(s => s.setVolume);

  const lastNonZeroRef = useRef(volume > 0 ? volume : 1);
  useEffect(() => {
    if (volume > 0) lastNonZeroRef.current = volume;
  }, [volume]);

  const muted = volume <= 0;
  const toggleMute = useCallback(() => {
    if (muted) setVolume(lastNonZeroRef.current || 1);
    else setVolume(0);
  }, [muted, setVolume]);

  return { volume, setVolume, muted, toggleMute };
}
