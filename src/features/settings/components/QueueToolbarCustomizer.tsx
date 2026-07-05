import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Blend, Infinity as InfinityIcon, ListMusic, MoveRight, Share2, Shuffle, Trash2, Waves } from 'lucide-react';
import { useQueueToolbarStore, QueueToolbarButtonId } from '@/store/queueToolbarStore';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';

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

const REORDER_TYPE = 'queue_toolbar_reorder';

export function QueueToolbarCustomizer() {
  const { t } = useTranslation();
  const { buttons, setButtons, toggleButton } = useQueueToolbarStore();
  const buttonsRef = useRef(buttons);
  // React Compiler refs rule: ref kept in sync with the latest value for use in handlers; not render data.
  // eslint-disable-next-line react-hooks/refs
  buttonsRef.current = buttons;

  const apply = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const next = applyListReorderById(buttonsRef.current, draggedId, target);
    if (next) setButtons(next);
  }, [setButtons]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({ type: REORDER_TYPE, apply });

  return (
    <div ref={setContainer} onMouseMove={onMouseMove} style={{ padding: '4px 0' }}>
      {buttons.map((btn) => {
        const Icon = QUEUE_TOOLBAR_BUTTON_ICONS[btn.id];
        const label = t(QUEUE_TOOLBAR_LABEL_KEYS[btn.id]);
        const edge = isDragging ? dropEdge(btn.id) : null;
        return (
          <div
            key={btn.id}
            data-reorder-id={btn.id}
            className="sidebar-customizer-row"
            style={{
              borderTop:    edge === 'before' ? '2px solid var(--accent)' : undefined,
              borderBottom: edge === 'after'  ? '2px solid var(--accent)' : undefined,
            }}
          >
            <ReorderGripHandle id={btn.id} type={REORDER_TYPE} label={label} />
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
