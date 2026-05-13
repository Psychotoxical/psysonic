import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Manages the open-state, refs, and fixed positioning of the portaled
 *  mini-player volume popover. The trigger sits inside a short window, so the
 *  popover flips above when there's not enough room below. Closes on outside
 *  click or Escape. */
export function useMiniVolumePopover() {
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [volumePopStyle, setVolumePopStyle] = useState<React.CSSProperties>({});
  const volumeBtnRef = useRef<HTMLButtonElement>(null);
  const volumePopRef = useRef<HTMLDivElement>(null);

  const updateVolumePopStyle = () => {
    if (!volumeBtnRef.current) return;
    const rect = volumeBtnRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const POP_W = 40;
    const POP_H = 150;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < POP_H && spaceAbove > spaceBelow;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - POP_W / 2, 6),
      window.innerWidth - POP_W - 6,
    );
    setVolumePopStyle({
      position: 'fixed',
      left,
      width: POP_W,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!volumeOpen) return;
    updateVolumePopStyle();
  }, [volumeOpen]);

  useEffect(() => {
    if (!volumeOpen) return;
    const onReposition = () => updateVolumePopStyle();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [volumeOpen]);

  useEffect(() => {
    if (!volumeOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !volumeBtnRef.current?.contains(target) &&
        !volumePopRef.current?.contains(target)
      ) setVolumeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVolumeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [volumeOpen]);

  return { volumeOpen, setVolumeOpen, volumePopStyle, volumeBtnRef, volumePopRef };
}
