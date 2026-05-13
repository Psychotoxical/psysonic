import { useCallback, useEffect, useRef, useState } from 'react';

/** Idle-fade system — flips `isIdle` true after 3 s of no user activity.
 *  Returns the boolean plus a mousemove handler that's throttled to one reset
 *  per ~200 ms so cleanup/start timers don't fire on every mouse pixel.
 *  Also resets on key presses and triggers `onEscape` when the user hits Esc. */
export function useFsIdleFade(onEscape: () => void) {
  const [isIdle, setIsIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIsIdle(true), 3000);
  }, []);

  const lastMoveTime = useRef(0);
  const handleMouseMove = useCallback(() => {
    const now = Date.now();
    if (now - lastMoveTime.current < 200) return;
    lastMoveTime.current = now;
    resetIdle();
  }, [resetIdle]);

  useEffect(() => {
    resetIdle();
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, [resetIdle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      resetIdle();
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape, resetIdle]);

  return { isIdle, handleMouseMove };
}
