import { useCallback, useEffect, useRef, useState } from 'react';

const LONG_PRESS_MS = 550;
const MOVE_CANCEL_PX = 10;

/**
 * Long-press on play/pause opens the delay modal; short click toggles playback.
 */
export function usePlaybackDelayPress(togglePlay: () => void) {
  const [delayModalOpen, setDelayModalOpen] = useState(false);
  const ignoreNextClickRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });

  // Long-press sets ignoreNextClickRef so the synthetic click after opening does not toggle play.
  // Closing the modal from chips / Apply / overlay never hits this button's onClick, so clear the flag here.
  useEffect(() => {
    if (!delayModalOpen) ignoreNextClickRef.current = false;
  }, [delayModalOpen]);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startRef.current = { x: e.clientX, y: e.clientY };
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        ignoreNextClickRef.current = true;
        setDelayModalOpen(true);
      }, LONG_PRESS_MS) as unknown as number;
    },
    [clearTimer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (timerRef.current == null) return;
      if (
        Math.hypot(e.clientX - startRef.current.x, e.clientY - startRef.current.y) > MOVE_CANCEL_PX
      ) {
        clearTimer();
      }
    },
    [clearTimer],
  );

  const endPointer = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (ignoreNextClickRef.current) {
        ignoreNextClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      togglePlay();
    },
    [togglePlay],
  );

  const playPauseBind = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPointer,
    onPointerLeave: endPointer,
    onPointerCancel: endPointer,
    onClick,
  };

  return { delayModalOpen, setDelayModalOpen, playPauseBind };
}
