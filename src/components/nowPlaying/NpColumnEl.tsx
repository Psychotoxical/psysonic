import React, { useEffect, useRef } from 'react';
import type { NpCardId, NpColumn } from '../../store/nowPlayingLayoutStore';

interface NpColumnProps {
  col: NpColumn;
  children: React.ReactNode;
  empty: boolean;
  emptyLabel: string;
  isDndActive: boolean;
  draggingCardId: NpCardId | null;
  onHover: (col: NpColumn, idx: number) => void;
  isOverHere: boolean;
}

export default function NpColumnEl({ col, children, empty, emptyLabel, isDndActive, draggingCardId, onHover, isOverHere }: NpColumnProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!draggingCardId) return;
    const el = ref.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      // Use only the x-axis to decide "which column". This keeps the whole
      // vertical strip above / below the last card part of the drop zone,
      // so the user can drop "at the very bottom" of either column.
      if (e.clientX < rect.left || e.clientX > rect.right) return;
      const wrappers = Array.from(el.querySelectorAll<HTMLElement>('[data-np-wrapper]'))
        .filter(w => w.getAttribute('data-np-card-id') !== draggingCardId);
      let idx = wrappers.length;
      for (let i = 0; i < wrappers.length; i++) {
        const r = wrappers[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { idx = i; break; }
      }
      onHover(col, idx);
    };

    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [draggingCardId, col, onHover]);

  return (
    <div
      ref={ref}
      className={`np-dash-col${isOverHere ? ' is-drop-target' : ''}${isDndActive ? ' is-dnd-active' : ''}`}
    >
      {children}
      {empty && <div className="np-dash-col-empty">{emptyLabel}</div>}
    </div>
  );
}
