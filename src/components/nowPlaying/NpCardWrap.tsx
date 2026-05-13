import React from 'react';
import { useDragSource } from '../../contexts/DragDropContext';
import type { NpCardId } from '../../store/nowPlayingLayoutStore';

interface NpCardWrapProps {
  id: NpCardId;
  label: string;
  isDraggingThis: boolean;
  children: React.ReactNode;
}

export default function NpCardWrap({ id, label, isDraggingThis, children }: NpCardWrapProps) {
  const dragProps = useDragSource(() => ({
    data: JSON.stringify({ kind: 'np-card', id }),
    label,
  }));
  return (
    <div
      data-np-wrapper
      data-np-card-id={id}
      className={`np-dash-card-wrap${isDraggingThis ? ' is-dragging' : ''}`}
      {...dragProps}
    >
      {children}
    </div>
  );
}
