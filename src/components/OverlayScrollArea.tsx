import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computeOverlayScrollbarThumbMeta } from '../utils/overlayScrollbarMetrics';
import { bindOverlayScrollbarThumbDrag } from '../utils/overlayScrollbarThumb';

export type OverlayScrollRailInset = 'none' | 'mini' | 'panel';

export type OverlayScrollAreaProps = {
  children: React.ReactNode;
  /** Optional handler on the outer wrapper (e.g. mini queue DnD hit-testing). */
  onMouseMove?: React.MouseEventHandler<HTMLDivElement>;
  /** Classes on the outer wrapper (e.g. queue-list-wrap, mini-queue-wrap). */
  className?: string;
  /** Classes on the scrollable viewport (e.g. queue-list, mini-queue). */
  viewportClassName?: string;
  /** Serialized internally — triggers remeasure + ResizeObserver refresh. */
  measureDeps?: ReadonlyArray<unknown>;
  /** Vertical inset of the hit rail (align with viewport padding). */
  railInset?: OverlayScrollRailInset;
  /** e.g. during native DnD — scroll-behavior: auto on the viewport. */
  viewportScrollBehaviorAuto?: boolean;
  /** Ref to the scrollable element (querySelector, scrollIntoView, etc.). */
  viewportRef?: React.Ref<HTMLDivElement>;
  /** Optional id on the viewport (e.g. main app scroll for route pages). */
  viewportId?: string;
};

const RAIL_INSET_CLASS: Record<OverlayScrollRailInset, string> = {
  none: 'overlay-scroll--rail-inset-none',
  mini: 'overlay-scroll--rail-inset-mini',
  panel: 'overlay-scroll--rail-inset-panel',
};

function assignRef<T>(ref: React.Ref<T> | undefined, value: T) {
  if (ref == null) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: T | null }).current = value;
}

export default function OverlayScrollArea({
  children,
  onMouseMove,
  className = '',
  viewportClassName = '',
  measureDeps = [],
  railInset = 'none',
  viewportScrollBehaviorAuto = false,
  viewportRef: viewportRefProp,
  viewportId,
}: OverlayScrollAreaProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [meta, setMeta] = useState({ thumbH: 0, thumbT: 0, visible: false });

  const recompute = useCallback(() => {
    const vp = viewportRef.current;
    const wrap = wrapRef.current;
    const rail = wrap?.querySelector<HTMLElement>('.overlay-scroll__rail');
    const trackH =
      rail && rail.clientHeight > 0 ? rail.clientHeight : undefined;
    setMeta(computeOverlayScrollbarThumbMeta(vp, trackH));
  }, []);

  const measureKey = JSON.stringify(measureDeps ?? []);

  useLayoutEffect(() => {
    if (!meta.visible) return;
    const vp = viewportRef.current;
    const wrap = wrapRef.current;
    const rail = wrap?.querySelector<HTMLElement>('.overlay-scroll__rail');
    const th = rail?.clientHeight;
    if (!vp || !th || th <= 0) return;
    setMeta((prev) => {
      const next = computeOverlayScrollbarThumbMeta(vp, th);
      if (
        prev.thumbH === next.thumbH &&
        prev.thumbT === next.thumbT &&
        prev.visible === next.visible
      ) {
        return prev;
      }
      return next;
    });
  }, [meta.visible]);

  useEffect(() => {
    recompute();
    const wrap = wrapRef.current;
    const onWinResize = () => recompute();
    window.addEventListener('resize', onWinResize);
    const ro =
      typeof ResizeObserver !== 'undefined' && wrap
        ? new ResizeObserver(() => recompute())
        : null;
    if (ro && wrap) ro.observe(wrap);
    return () => {
      window.removeEventListener('resize', onWinResize);
      ro?.disconnect();
    };
  }, [recompute, measureKey]);

  const setViewportNode = (el: HTMLDivElement | null) => {
    viewportRef.current = el;
    assignRef(viewportRefProp, el);
  };

  const rootClass = [
    'overlay-scroll',
    RAIL_INSET_CLASS[railInset],
    viewportScrollBehaviorAuto ? 'overlay-scroll--viewport-scroll-auto' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const viewportClass = ['overlay-scroll__viewport', viewportClassName].filter(Boolean).join(' ');

  return (
    <div ref={wrapRef} className={rootClass} onMouseMove={onMouseMove}>
      <div
        id={viewportId}
        ref={setViewportNode}
        className={viewportClass}
        onScroll={recompute}
      >
        {children}
      </div>
      {meta.visible && (
        <div className="overlay-scroll__rail" aria-hidden>
          <div
            className="overlay-scroll__thumb"
            style={{
              height: `${meta.thumbH}px`,
              transform: `translateY(${meta.thumbT}px)`,
            }}
            onPointerDown={(ev) => bindOverlayScrollbarThumbDrag(ev, viewportRef.current)}
          />
        </div>
      )}
    </div>
  );
}
