import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_HOLD_MS = 1000;
const DEFAULT_ANIM_DELAY_MS = 100;

interface UseLongPressActionOptions {
  onShortPress: () => void;
  onLongPress: () => void;
  holdMs?: number;
  animDelayMs?: number;
}

/**
 * Short click runs `onShortPress`; hold runs `onLongPress` and suppresses the
 * synthetic click that follows pointer release.
 */
export function useLongPressAction({
  onShortPress,
  onLongPress,
  holdMs = DEFAULT_HOLD_MS,
  animDelayMs = DEFAULT_ANIM_DELAY_MS,
}: UseLongPressActionOptions) {
  const [isHolding, setIsHolding] = useState(false);
  const longPressTriggeredRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const animTimerRef = useRef<number | null>(null);
  const endListenerRef = useRef<(() => void) | null>(null);

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (animTimerRef.current != null) {
      window.clearTimeout(animTimerRef.current);
      animTimerRef.current = null;
    }
    if (endListenerRef.current) {
      document.removeEventListener('pointerup', endListenerRef.current);
      document.removeEventListener('pointercancel', endListenerRef.current);
      endListenerRef.current = null;
    }
    setIsHolding(false);
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation();
      longPressTriggeredRef.current = false;
      clearTimers();

      animTimerRef.current = window.setTimeout(() => {
        animTimerRef.current = null;
        setIsHolding(true);
      }, animDelayMs) as unknown as number;

      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        longPressTriggeredRef.current = true;
        onLongPress();
        setIsHolding(false);
      }, holdMs) as unknown as number;

      const end = () => clearTimers();
      endListenerRef.current = end;
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    },
    [animDelayMs, clearTimers, holdMs, onLongPress],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (longPressTriggeredRef.current) {
        longPressTriggeredRef.current = false;
        return;
      }
      onShortPress();
    },
    [onShortPress],
  );

  return {
    isHolding,
    pressBind: { onClick, onPointerDown },
  };
}
