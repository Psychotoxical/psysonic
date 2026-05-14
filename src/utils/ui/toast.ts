/**
 * Lightweight DOM-based toast notification.
 * Uses the app's CSS custom properties so it respects the active theme.
 * Multiple toasts stack vertically above each other.
 */

const TOAST_GAP = 8;
const TOAST_BOTTOM_ANCHOR = 100;

function getActiveToasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.psysonic-toast'));
}

function reflow(): void {
  const toasts = getActiveToasts();
  let bottom = TOAST_BOTTOM_ANCHOR;
  for (let i = toasts.length - 1; i >= 0; i--) {
    toasts[i].style.bottom = `${bottom}px`;
    bottom += toasts[i].offsetHeight + TOAST_GAP;
  }
}

export type ToastVariant = 'error' | 'info' | 'warning' | 'success';

export function showToast(text: string, durationMs = 4000, variant: ToastVariant = 'info'): void {
  const isError = variant === 'error';
  const isWarning = variant === 'warning';
  const isSuccess = variant === 'success';

  const toast = document.createElement('div');
  toast.className = 'psysonic-toast';

  const icon = document.createElement('span');
  icon.textContent = isError ? '✕' : isWarning ? '!' : isSuccess ? '✓' : 'ℹ';
  icon.style.cssText = `
    flex-shrink: 0;
    font-size: ${isSuccess ? '10px' : '11px'};
    font-weight: 700;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${isError ? 'var(--danger)' : isWarning ? 'var(--warning, #f59e0b)' : isSuccess ? 'var(--success, #10b981)' : 'var(--accent)'};
    color: var(--bg-app);
    line-height: 1;
  `;

  const msg = document.createElement('span');
  msg.textContent = text;
  msg.style.cssText = `flex: 1; min-width: 0;`;

  const getBorderColor = () => {
    if (isError) return 'var(--danger)';
    if (isWarning) return 'var(--warning, #f59e0b)';
    if (isSuccess) return 'var(--success, #10b981)';
    return 'var(--accent)';
  };

  const getBoxShadow = () => {
    const base = '0 4px 24px rgba(0,0,0,0.45)';
    if (isError) return `${base}, 0 0 0 1px color-mix(in srgb, var(--danger) 20%, transparent)`;
    if (isWarning) return `${base}, 0 0 0 1px color-mix(in srgb, var(--warning, #f59e0b) 20%, transparent)`;
    return base;
  };

  toast.style.cssText = `
    position: fixed;
    bottom: ${TOAST_BOTTOM_ANCHOR}px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg-card);
    color: var(--text-primary);
    border: 1px solid ${getBorderColor()};
    border-left: 3px solid ${getBorderColor()};
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 13.5px;
    font-weight: 500;
    z-index: 999999;
    pointer-events: none;
    box-shadow: ${getBoxShadow()};
    white-space: normal;
    word-break: break-word;
    transition: bottom 150ms ease;
    max-width: 480px;
    width: max-content;
  `;

  toast.appendChild(icon);
  toast.appendChild(msg);
  document.body.appendChild(toast);
  reflow();

  setTimeout(() => {
    toast.remove();
    reflow();
  }, durationMs);
}
