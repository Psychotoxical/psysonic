import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  /** Called on Escape, backdrop click, and the header close button. */
  onClose: () => void;
  title: ReactNode;
  /** Smaller line under the title (e.g. a version range). */
  subtitle?: ReactNode;
  /** Leading icon, aligned with the title line. */
  icon?: ReactNode;
  /** Action row pinned to the bottom, above the modal edge. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the header close (X) button. */
  hideClose?: boolean;
  /** Accessible label / tooltip for the close button. */
  closeLabel?: string;
  children: ReactNode;
}

/**
 * Reusable modal shell: a portal to `document.body` with an opaque, centered
 * card over a dimmed backdrop. Closes on Escape, backdrop click and the header
 * X. Deliberately uses **no `backdrop-filter`** — on WebKitGTK (some GPU stacks)
 * the blur bleeds onto the modal content, making text look unfocused. The other
 * hand-rolled modals migrate onto this over time.
 */
export default function Modal({
  open, onClose, title, subtitle, icon, footer, size = 'md', hideClose, closeLabel, children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="ui-modal-backdrop" onClick={onClose}>
      <div
        className={`ui-modal ui-modal--${size}`}
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <div className="ui-modal-header">
          {icon && <span className="ui-modal-icon">{icon}</span>}
          <div className="ui-modal-titles">
            <span className="ui-modal-title">{title}</span>
            {subtitle != null && <span className="ui-modal-subtitle">{subtitle}</span>}
          </div>
          {!hideClose && (
            <button
              type="button"
              className="ui-modal-close"
              onClick={onClose}
              aria-label={closeLabel ?? 'Close'}
              data-tooltip={closeLabel}
              data-tooltip-pos="bottom"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
