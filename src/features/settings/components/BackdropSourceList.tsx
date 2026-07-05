import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useDragDrop, useDragSource } from '@/lib/dnd/DragDropContext';
import type { BackdropSource, BackdropSourcePref } from '@/cover/artistBackdrop';
import type { BackdropSurface } from '@/store/themeStore';
import { moveSourceTo, dropSourceBefore } from '@/features/settings/components/backdropReorder';

const DRAG_TYPE = 'backdrop-source';

interface RowPayload {
  type: typeof DRAG_TYPE;
  surface: BackdropSurface;
  index: number;
}

interface Props {
  surface: BackdropSurface;
  sources: BackdropSourcePref[];
  labelFor: (s: BackdropSource) => string;
  onChange: (next: BackdropSourcePref[]) => void;
  moveUpLabel: string;
  moveDownLabel: string;
}

/**
 * Ordered, individually-toggleable backdrop source list for one surface. Drag a
 * row by its grip to reorder (priority = top-to-bottom), or use the ↑/↓ buttons
 * for a keyboard-accessible reorder; the switch on each row drops a source out
 * of the resolution chain without losing its place. Uses the shared
 * `useDragSource` / `psy-drop` drag infrastructure (text/plain payloads).
 */
export function BackdropSourceList({ surface, sources, labelFor, onChange, moveUpLabel, moveDownLabel }: Props) {
  const { isDragging, payload } = useDragDrop();
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Is the in-flight drag a row from *this* list? (Don't react to other drags.)
  let draggingHere = false;
  if (isDragging && payload) {
    try {
      const p = JSON.parse(payload.data);
      draggingHere = p.type === DRAG_TYPE && p.surface === surface;
    } catch { /* not our payload */ }
  }

  const apply = (next: BackdropSourcePref[] | null) => { if (next) onChange(next); };
  const setEnabled = (i: number, enabled: boolean) =>
    onChange(sources.map((s, idx) => (idx === i ? { ...s, enabled } : s)));

  return (
    <ul className="backdrop-source-list" role="list">
      {sources.map((pref, i) => (
        <BackdropSourceRow
          key={pref.source}
          surface={surface}
          index={i}
          count={sources.length}
          label={labelFor(pref.source)}
          enabled={pref.enabled}
          isDropTarget={draggingHere && dropIdx === i}
          onHover={() => { if (draggingHere) setDropIdx(i); }}
          onDropFrom={(from) => { apply(dropSourceBefore(sources, from, i)); setDropIdx(null); }}
          onToggle={(en) => setEnabled(i, en)}
          onMoveUp={() => apply(moveSourceTo(sources, i, i - 1))}
          onMoveDown={() => apply(moveSourceTo(sources, i, i + 1))}
          moveUpLabel={moveUpLabel}
          moveDownLabel={moveDownLabel}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  surface: BackdropSurface;
  index: number;
  count: number;
  label: string;
  enabled: boolean;
  isDropTarget: boolean;
  onHover: () => void;
  onDropFrom: (fromIndex: number) => void;
  onToggle: (enabled: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  moveUpLabel: string;
  moveDownLabel: string;
}

function BackdropSourceRow({
  surface, index, count, label, enabled, isDropTarget,
  onHover, onDropFrom, onToggle, onMoveUp, onMoveDown, moveUpLabel, moveDownLabel,
}: RowProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const grip = useDragSource(() => ({
    data: JSON.stringify({ type: DRAG_TYPE, surface, index } satisfies RowPayload),
    label,
  }));

  // A `psy-drop` released over this row carries the dragged row's index.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      try {
        const d = JSON.parse((e as CustomEvent).detail?.data ?? '{}');
        if (d.type === DRAG_TYPE && d.surface === surface && typeof d.index === 'number' && d.index !== index) {
          onDropFrom(d.index);
        }
      } catch { /* malformed payload */ }
    };
    el.addEventListener('psy-drop', handler);
    return () => el.removeEventListener('psy-drop', handler);
  }, [surface, index, onDropFrom]);

  const cls = [
    'backdrop-source-row',
    isDropTarget ? 'backdrop-source-row--drop' : '',
    enabled ? '' : 'backdrop-source-row--off',
  ].filter(Boolean).join(' ');

  return (
    <li ref={rowRef} className={cls} onMouseMove={onHover}>
      <span className="backdrop-source-grip" {...grip} aria-hidden="true">
        <GripVertical size={16} />
      </span>
      <span className="backdrop-source-name">{label}</span>
      <span className="backdrop-source-actions">
        <button type="button" className="backdrop-source-move" onClick={onMoveUp} disabled={index === 0} aria-label={`${moveUpLabel}: ${label}`}>
          <ChevronUp size={15} />
        </button>
        <button type="button" className="backdrop-source-move" onClick={onMoveDown} disabled={index === count - 1} aria-label={`${moveDownLabel}: ${label}`}>
          <ChevronDown size={15} />
        </button>
        <label className="toggle-switch" aria-label={label}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span className="toggle-track" />
        </label>
      </span>
    </li>
  );
}
