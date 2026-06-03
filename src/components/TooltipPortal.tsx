import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  text: string;
  anchorRect: DOMRect;
  preferBottom: boolean;
  wrap: boolean;
}

/** Pointer must rest on an anchor this long before the tooltip appears. */
const TOOLTIP_OPEN_DELAY_MS = 1000;

export default function TooltipPortal() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  // Anchor counting down to show, plus its pending timer.
  const pendingAnchorRef = useRef<HTMLElement | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  // Anchor whose tooltip is currently visible.
  const shownAnchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearPending = () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      pendingAnchorRef.current = null;
    };

    const hide = () => {
      clearPending();
      shownAnchorRef.current = null;
      setTooltip(null);
    };

    const showAnchor = (anchor: HTMLElement) => {
      const text = anchor.getAttribute('data-tooltip');
      if (!text) return;
      shownAnchorRef.current = anchor;
      // Fresh rect: layout may have shifted during the open delay.
      setTooltip({
        text,
        anchorRect: anchor.getBoundingClientRect(),
        preferBottom: anchor.getAttribute('data-tooltip-pos') === 'bottom',
        wrap: anchor.hasAttribute('data-tooltip-wrap'),
      });
    };

    const onOver = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('[data-tooltip]') as HTMLElement | null;
      if (!anchor) return;
      // Already visible or already counting down for this anchor — leave it running.
      if (anchor === shownAnchorRef.current || anchor === pendingAnchorRef.current) return;
      // Moved onto a different anchor: drop old state and re-arm the delay.
      clearPending();
      if (shownAnchorRef.current) {
        shownAnchorRef.current = null;
        setTooltip(null);
      }
      pendingAnchorRef.current = anchor;
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        pendingAnchorRef.current = null;
        showAnchor(anchor);
      }, TOOLTIP_OPEN_DELAY_MS);
    };
    const onOut = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('[data-tooltip]') as HTMLElement | null;
      if (!anchor) return;
      if (anchor !== shownAnchorRef.current && anchor !== pendingAnchorRef.current) return;
      // Moving within the same anchor (e.g. onto a child icon) must not cancel the delay.
      const to = e.relatedTarget as Node | null;
      if (to && anchor.contains(to)) return;
      hide();
    };
    const onMove = (e: MouseEvent) => {
      if (!pendingAnchorRef.current && !shownAnchorRef.current) return;
      const anchor = (e.target as HTMLElement).closest('[data-tooltip]');
      if (!anchor) hide();
    };
    /** Clicking a tooltip anchor (e.g. opening a dropdown) keeps the cursor inside the element, so mouseout never runs — hide immediately. */
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-tooltip]')) hide();
    };
    /** Wheel interactions (e.g. volume on overflow button) should suppress tooltip immediately. */
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-tooltip]')) hide();
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      clearPending();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('wheel', onWheel, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip || !boxRef.current) { setStyle({ opacity: 0 }); return; }

    const box = boxRef.current.getBoundingClientRect();
    const { anchorRect, preferBottom } = tooltip;
    const GAP = 7;
    const MARGIN = 8;

    // Decide top or bottom
    const spaceAbove = anchorRect.top - GAP - box.height;
    const useBottom = preferBottom || spaceAbove < MARGIN;

    let top = useBottom
      ? anchorRect.bottom + GAP
      : anchorRect.top - GAP - box.height;

    // Clamp vertically
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));

    // Centre horizontally, clamp to viewport
    let left = anchorRect.left + anchorRect.width / 2 - box.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));

    setStyle({ opacity: 1, top, left });
  }, [tooltip]);

  if (!tooltip) return null;

  return createPortal(
    <div
      ref={boxRef}
      style={{
        position: 'fixed',
        zIndex: 99999,
        background: 'var(--bg-card)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: '4px 8px',
        fontSize: '12px',
        fontWeight: 500,
        boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
        pointerEvents: 'none',
        whiteSpace: tooltip.wrap ? 'pre-line' : 'nowrap',
        maxWidth: tooltip.wrap ? '220px' : undefined,
        transition: 'opacity 0.15s ease',
        ...style,
      }}
    >
      {tooltip.text}
    </div>,
    document.body
  );
}
