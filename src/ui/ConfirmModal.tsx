import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /**
   * Cancel button label. Omit (together with `onCancel`) to render the
   * modal as a single-button info dialog — Esc / outside-click / X then
   * also resolve via `onConfirm`.
   */
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const dismiss = onCancel ?? onConfirm;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismiss, onConfirm]);

  if (!open) return null;

  const confirmStyle = danger
    ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
    : undefined;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={dismiss}
      role="dialog"
      aria-modal="true"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '380px' }}
      >
        <button className="modal-close" onClick={dismiss} aria-label={cancelLabel ?? confirmLabel}>
          <X size={18} />
        </button>
        <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>{title}</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          {cancelLabel && onCancel && (
            <button className="btn btn-ghost" onClick={onCancel} autoFocus>
              {cancelLabel}
            </button>
          )}
          <button className="btn btn-primary" style={confirmStyle} onClick={onConfirm} autoFocus={!cancelLabel}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
