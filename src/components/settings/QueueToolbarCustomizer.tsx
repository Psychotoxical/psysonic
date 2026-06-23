import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Blend, GripVertical, Infinity as InfinityIcon, ListMusic, MoveRight, Share2, Shuffle, Trash2, Waves } from 'lucide-react';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { useQueueToolbarStore, QueueToolbarButtonId } from '../../store/queueToolbarStore';

type QueueToolbarDropTarget = { idx: number; before: boolean } | null;

const QUEUE_TOOLBAR_BUTTON_ICONS: Record<QueueToolbarButtonId, typeof Shuffle | null> = {
  shuffle: Shuffle,
  playlist: ListMusic,
  share: Share2,
  clear: Trash2,
  separator: null, // No icon for separator
  gapless: MoveRight,
  crossfade: Waves,
  autodj: Blend,
  infinite: InfinityIcon,
};

const QUEUE_TOOLBAR_LABEL_KEYS: Record<QueueToolbarButtonId, string> = {
  shuffle:   'queue.shuffle',
  playlist:  'queue.playlist',
  share:     'queue.shareQueue',
  clear:     'queue.clear',
  separator: 'settings.queueToolbarSeparator',
  gapless:   'queue.gapless',
  crossfade: 'queue.crossfade',
  autodj:    'queue.autoDj',
  infinite:  'queue.infiniteQueue',
};

function QueueToolbarGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'queue_toolbar_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

export function QueueToolbarCustomizer() {
  const { t } = useTranslation();
  const { buttons, setButtons, toggleButton } = useQueueToolbarStore();
  const { isDragging: isPsyDragging } = useDragDrop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<QueueToolbarDropTarget>(null);
  const dropTargetRef = useRef<QueueToolbarDropTarget>(null);
  const buttonsRef = useRef(buttons);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  buttonsRef.current = buttons;

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'queue_toolbar_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...buttonsRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      setButtons(next);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [setButtons]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerRef.current) return;
    const rows = containerRef.current.querySelectorAll<HTMLElement>('[data-queue-toolbar-idx]');
    let target: QueueToolbarDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.queueToolbarIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  return (
    <div ref={containerRef} onMouseMove={handleMouseMove} style={{ padding: '4px 0' }}>
      {buttons.map((btn, idx) => {
        const Icon = QUEUE_TOOLBAR_BUTTON_ICONS[btn.id];
        const label = t(QUEUE_TOOLBAR_LABEL_KEYS[btn.id]);
        const isBefore = isPsyDragging && dropTarget?.idx === idx && dropTarget.before;
        const isAfter  = isPsyDragging && dropTarget?.idx === idx && !dropTarget.before;
        return (
          <div
            key={btn.id}
            data-queue-toolbar-idx={idx}
            className="sidebar-customizer-row"
            style={{
              borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
              borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
            }}
          >
            <QueueToolbarGripHandle idx={idx} label={label} />
            {Icon ? (
              <Icon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            ) : (
              // Reserve the same 16px icon column so the label lines up with the
              // other rows; the 1px rule is centred within it.
              <div style={{ width: 16, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                <div style={{ width: 1, height: 16, background: 'var(--border-subtle)' }} />
              </div>
            )}
            <span style={{ flex: 1, fontSize: 14 }}>{label}</span>
            <label className="toggle-switch" aria-label={label}>
              <input type="checkbox" checked={btn.visible} onChange={() => toggleButton(btn.id)} />
              <span className="toggle-track" />
            </label>
          </div>
        );
      })}
    </div>
  );
}
