import { useEffect, useRef, useState } from 'react';
import type { Column, NavPos } from '../utils/componentHelpers/folderBrowserHelpers';

interface Args {
  columns: Column[];
  keyboardPos: NavPos | null;
  keyboardNavActive: boolean;
  setKeyboardNavActive: React.Dispatch<React.SetStateAction<boolean>>;
}

interface Result {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  columnsViewportWidth: number;
}

export function useFolderBrowserScrolling({
  columns, keyboardPos, keyboardNavActive, setKeyboardNavActive,
}: Args): Result {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [columnsViewportWidth, setColumnsViewportWidth] = useState(0);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
  }, [columns.length]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    setColumnsViewportWidth(el.clientWidth);
    const observer = new ResizeObserver(() => {
      setColumnsViewportWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!wrapperRef.current) return;
    requestAnimationFrame(() => {
      columns.forEach((col, colIndex) => {
        const selectedId = col.selectedId;
        if (!selectedId) return;
        const row = wrapperRef.current?.querySelector<HTMLElement>(
          `.folder-col[data-folder-col-index="${colIndex}"] .folder-col-row[data-item-id="${selectedId}"]`,
        );
        row?.scrollIntoView({ block: 'nearest' });
      });

      if (keyboardPos) {
        const kbdRow = wrapperRef.current?.querySelector<HTMLElement>(
          `.folder-col[data-folder-col-index="${keyboardPos.colIndex}"] .folder-col-row[data-row-index="${keyboardPos.rowIndex}"]`,
        );
        kbdRow?.scrollIntoView({ block: 'nearest' });
      }

      const fallbackColIndex = [...columns]
        .map((c, i) => (c.selectedId ? i : -1))
        .filter(i => i >= 0)
        .pop();
      const baseColIndex = keyboardPos?.colIndex ?? fallbackColIndex ?? Math.max(0, columns.length - 1);
      const focusColIndex = Math.min(Math.max(0, columns.length - 1), baseColIndex + 1);
      const focusCol = wrapperRef.current?.querySelector<HTMLElement>(
        `.folder-col[data-folder-col-index="${focusColIndex}"]`,
      );
      focusCol?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [columns, keyboardPos]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const hasRows = columns.some(c => !c.loading && !c.error && c.items.length > 0);
    if (!hasRows) return;
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
  }, [columns]);

  useEffect(() => {
    if (!keyboardNavActive) return;
    const onMouseMove = () => setKeyboardNavActive(false);
    window.addEventListener('mousemove', onMouseMove, { once: true });
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [keyboardNavActive, setKeyboardNavActive]);

  return { wrapperRef, columnsViewportWidth };
}
