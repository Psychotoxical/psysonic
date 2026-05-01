import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipState {
  text: string;
  anchorRect: DOMRect;
  preferBottom: boolean;
  wrap: boolean;
}

export default function TooltipPortal() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  const tooltipRef = useRef<TooltipState | null>(null);
  tooltipRef.current = tooltip;

  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-tooltip]') as HTMLElement | null;
      if (!target) return;
      const text = target.getAttribute('data-tooltip');
      if (!text) return;
      setTooltip({
        text,
        anchorRect: target.getBoundingClientRect(),
        preferBottom: target.getAttribute('data-tooltip-pos') === 'bottom',
        wrap: target.hasAttribute('data-tooltip-wrap'),
      });
    };
    const onOut = () => setTooltip(null);
    const onMove = (e: MouseEvent) => {
      if (!tooltipRef.current) return;
      const target = (e.target as HTMLElement).closest('[data-tooltip]');
      if (!target) setTooltip(null);
    };
    /** Clicking a tooltip anchor (e.g. opening a dropdown) keeps the cursor inside the element, so mouseout never runs — hide immediately. */
    const onDown = (e: MouseEvent) => {
      const t = (e.target as HTMLElement).closest('[data-tooltip]');
      if (t) setTooltip(null);
    };
    /** Wheel interactions (e.g. volume on overflow button) should suppress tooltip immediately. */
    const onWheel = (e: WheelEvent) => {
      const t = (e.target as HTMLElement).closest('[data-tooltip]');
      if (t) setTooltip(null);
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
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
