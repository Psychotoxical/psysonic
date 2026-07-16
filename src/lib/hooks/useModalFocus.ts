import { type RefObject, useEffect, useEffectEvent } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalFocusOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function useModalFocus({
  open,
  containerRef,
  onEscape,
  initialFocusRef,
  restoreFocusRef,
}: ModalFocusOptions): void {
  const closeOnEscape = useEffectEvent(() => onEscape());

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const explicitRestoreTarget = restoreFocusRef?.current ?? null;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const fallback = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? container;
      (initialFocusRef?.current ?? fallback).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeOnEscape();
        const restoreTarget = explicitRestoreTarget ?? previouslyFocused;
        if (restoreTarget?.isConnected) requestAnimationFrame(() => restoreTarget.focus());
        return;
      }
      if (event.key !== 'Tab') return;

      const container = containerRef.current;
      if (!container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      const restoreTarget = explicitRestoreTarget ?? previouslyFocused;
      if (restoreTarget?.isConnected) requestAnimationFrame(() => restoreTarget.focus());
    };
  }, [containerRef, initialFocusRef, open, restoreFocusRef]);
}
