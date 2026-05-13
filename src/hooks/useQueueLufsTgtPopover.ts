import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Manages the open/closed state, button + menu refs, and positioning of the
 *  LUFS-target listbox popover inside the queue panel's current-track header.
 *  The popover collapses automatically when the parent replay-gain expansion
 *  is toggled off. */
export function useQueueLufsTgtPopover(expandReplayGain: boolean) {
  const [lufsTgtOpen, setLufsTgtOpen] = useState(false);
  const [lufsTgtPopStyle, setLufsTgtPopStyle] = useState<React.CSSProperties>({});
  const lufsTgtBtnRef = useRef<HTMLButtonElement>(null);
  const lufsTgtMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lufsTgtOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        lufsTgtBtnRef.current?.contains(e.target as Node) ||
        lufsTgtMenuRef.current?.contains(e.target as Node)
      ) return;
      setLufsTgtOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [lufsTgtOpen]);

  const updateLufsTgtPopStyle = () => {
    if (!lufsTgtBtnRef.current) return;
    const rect = lufsTgtBtnRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const WIDTH = 160;
    const MAX_H = 220;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 120 && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(rect.right - WIDTH, 8),
      window.innerWidth - WIDTH - 8,
    );
    setLufsTgtPopStyle({
      position: 'fixed',
      left,
      width: WIDTH,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      maxHeight: Math.min(MAX_H, useAbove ? spaceAbove : spaceBelow),
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!lufsTgtOpen) return;
    updateLufsTgtPopStyle();
  }, [lufsTgtOpen]);

  useEffect(() => {
    if (!lufsTgtOpen) return;
    const onResize = () => updateLufsTgtPopStyle();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [lufsTgtOpen]);

  useEffect(() => {
    if (!expandReplayGain) setLufsTgtOpen(false);
  }, [expandReplayGain]);

  return {
    lufsTgtOpen,
    setLufsTgtOpen,
    lufsTgtPopStyle,
    lufsTgtBtnRef,
    lufsTgtMenuRef,
  };
}
