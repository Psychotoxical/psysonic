import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface DropdownRect {
  top: number;
  left: number;
  width: number;
}

interface Result {
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: DropdownRect;
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function useSidebarLibraryDropdown(): Result {
  const [libraryDropdownOpen, setLibraryDropdownOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DropdownRect>({ top: 0, left: 0, width: 0 });
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);

  const updateDropdownPosition = useCallback(() => {
    const el = libraryTriggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setDropdownRect({
      top: r.bottom + 4,
      left: r.left,
      width: r.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!libraryDropdownOpen) return;
    updateDropdownPosition();
    const onWin = () => updateDropdownPosition();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [libraryDropdownOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!libraryDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (libraryTriggerRef.current?.contains(t)) return;
      const panel = document.querySelector('.nav-library-dropdown-panel');
      if (panel?.contains(t)) return;
      setLibraryDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLibraryDropdownOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [libraryDropdownOpen]);

  return { libraryDropdownOpen, setLibraryDropdownOpen, dropdownRect, libraryTriggerRef };
}
