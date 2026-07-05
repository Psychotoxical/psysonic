import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Shared open-state, refs, and fixed positioning for a portaled mini-player
 *  popover anchored to a toolbar button. The trigger sits inside a short
 *  window, so the popover flips above when there's not enough room below.
 *  Closes on outside click or Escape. Volume + crossfade popovers share this. */
export function useMiniAnchoredPopover(popWidth: number, popHeight: number) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const updatePopStyle = () => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < popHeight && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - popWidth / 2, 6),
      window.innerWidth - popWidth - 6,
    );
    setPopStyle({
      position: 'fixed',
      left,
      width: popWidth,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePopStyle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePopStyle();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, setOpen, popStyle, btnRef, popRef };
}
