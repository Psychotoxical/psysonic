import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Fixed popover anchored above a player-bar trigger (overflow menu / speed btn). */
export function usePlayerBarAnchoredPopover(width: number, zIndex = 10050) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const updatePopStyle = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const MARGIN = 8;
    const r = btn.getBoundingClientRect();
    const left = Math.min(
      Math.max(r.right - width, MARGIN),
      window.innerWidth - width - MARGIN,
    );
    setPopStyle({
      position: 'fixed',
      left,
      width,
      bottom: window.innerHeight - r.top + MARGIN,
      zIndex,
    });
  }, [width, zIndex]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePopStyle();
  }, [open, updatePopStyle]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePopStyle();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, updatePopStyle]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
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
