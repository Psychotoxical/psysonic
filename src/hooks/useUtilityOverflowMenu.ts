import React, { useEffect, useRef, useState } from 'react';

/** Wires the utility-overflow Ellipsis button + its portaled menu:
 *  - watches the player-bar width via ResizeObserver and flips `utilityOverflow`
 *    when it crosses the threshold (980 px floating / 1140 px docked)
 *  - owns the menu open state and the 'full' vs. 'volume' display mode
 *  - closes the menu on outside click or Escape
 *  - re-positions the menu (fixed, above the trigger) on resize/scroll
 *  - exposes a volumeWheelMenuTimerRef so the volume-wheel auto-hide handler
 *    can reuse the same timer. */
export function useUtilityOverflowMenu(
  playerBarRef: React.RefObject<HTMLElement | null>,
  floatingPlayerBar: boolean,
) {
  const [utilityOverflow, setUtilityOverflow] = useState(false);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [utilityMenuMode, setUtilityMenuMode] = useState<'full' | 'volume'>('full');
  const [utilityMenuStyle, setUtilityMenuStyle] = useState<React.CSSProperties>({});
  const [suppressOverflowTooltip, setSuppressOverflowTooltip] = useState(false);
  const utilityMenuRef = useRef<HTMLDivElement>(null);
  const utilityBtnRef = useRef<HTMLButtonElement>(null);
  const volumeWheelMenuTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const updateOverflow = () => {
      const width = playerBarRef.current?.clientWidth ?? window.innerWidth;
      const threshold = floatingPlayerBar ? 980 : 1140;
      setUtilityOverflow(width < threshold);
    };

    updateOverflow();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateOverflow)
      : null;
    const el = playerBarRef.current;
    if (ro && el) ro.observe(el);
    window.addEventListener('resize', updateOverflow);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updateOverflow);
    };
  }, [floatingPlayerBar, playerBarRef]);

  useEffect(() => {
    if (!utilityOverflow) setUtilityMenuOpen(false);
    if (!utilityOverflow && volumeWheelMenuTimerRef.current != null) {
      window.clearTimeout(volumeWheelMenuTimerRef.current);
      volumeWheelMenuTimerRef.current = null;
    }
  }, [utilityOverflow]);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (utilityBtnRef.current?.contains(target)) return;
      if (utilityMenuRef.current?.contains(target)) return;
      setUtilityMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUtilityMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [utilityMenuOpen]);

  useEffect(() => () => {
    if (volumeWheelMenuTimerRef.current != null) {
      window.clearTimeout(volumeWheelMenuTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!utilityMenuOpen) return;
    const MENU_WIDTH = 238;
    const MARGIN = 8;
    const updateMenuPos = () => {
      const btn = utilityBtnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const left = Math.min(
        Math.max(r.right - MENU_WIDTH, MARGIN),
        window.innerWidth - MENU_WIDTH - MARGIN,
      );
      setUtilityMenuStyle({
        position: 'fixed',
        left,
        width: MENU_WIDTH,
        bottom: window.innerHeight - r.top + 8,
        zIndex: 10050,
      });
    };
    updateMenuPos();
    window.addEventListener('resize', updateMenuPos);
    window.addEventListener('scroll', updateMenuPos, true);
    return () => {
      window.removeEventListener('resize', updateMenuPos);
      window.removeEventListener('scroll', updateMenuPos, true);
    };
  }, [utilityMenuOpen]);

  return {
    utilityOverflow,
    utilityMenuOpen,
    setUtilityMenuOpen,
    utilityMenuMode,
    setUtilityMenuMode,
    utilityMenuStyle,
    utilityMenuRef,
    utilityBtnRef,
    volumeWheelMenuTimerRef,
    suppressOverflowTooltip,
    setSuppressOverflowTooltip,
  };
}
