import { useRef } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QueueServerSlice } from '@/features/queue/utils/queueServerSlices';
import { useModalFocus } from '@/lib/hooks/useModalFocus';

interface Props {
  action: 'save' | 'share';
  slices: QueueServerSlice[];
  selectedServerId: string;
  onSelect: (serverId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function QueueServerSliceDialog({
  action,
  slices,
  selectedServerId,
  onSelect,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const titleId = `queue-server-slice-${action}-title`;
  const descriptionId = `queue-server-slice-${action}-description`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLInputElement>(null);

  useModalFocus({
    open: true,
    containerRef: dialogRef,
    onEscape: onCancel,
    initialFocusRef: selectedRef,
  });

  return (
    <div className="modal-overlay queue-server-slice-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="modal-content queue-server-slice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={onCancel} aria-label={t('queue.close')}>
          <X size={18} />
        </button>
        <h3 id={titleId} style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
          {t(action === 'save' ? 'queue.serverSliceSaveTitle' : 'queue.serverSliceShareTitle')}
        </h3>
        <p id={descriptionId} style={{ margin: '0 0 1rem', color: 'var(--text-muted)' }}>
          {t('queue.serverSliceDescription')}
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
            {t('queue.serverSliceLegend')}
          </legend>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {slices.map(slice => (
              <label
                key={slice.server.id}
                style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
              >
                <input
                  ref={selectedServerId === slice.server.id ? selectedRef : undefined}
                  type="radio"
                  name={`queue-server-slice-${action}`}
                  value={slice.server.id}
                  checked={selectedServerId === slice.server.id}
                  onChange={() => onSelect(slice.server.id)}
                />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: 'block' }}>{slice.server.name || slice.server.url}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{slice.server.url}</span>
                </span>
                <span aria-label={t('queue.serverSliceCount', { count: slice.trackIds.length })}>
                  {t('queue.serverSliceCount', { count: slice.trackIds.length })}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '1rem' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t('queue.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={!selectedServerId}>
            {t(action === 'save' ? 'queue.serverSliceSaveConfirm' : 'queue.serverSliceShareConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
