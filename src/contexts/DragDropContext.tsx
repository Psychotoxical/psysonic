/**
 * Mouse-event-based Drag & Drop system.
 *
 * Replaces the HTML5 Drag & Drop API for cross-component drags (song → queue,
 * album → queue) because WebKitGTK on Linux always shows a "forbidden" cursor
 * during native HTML5 DnD and there is no way to fix it at the GTK level
 * without breaking DnD entirely.
 *
 * This system uses mousedown / mousemove / mouseup which keeps cursor control
 * in CSS and avoids the native DnD subsystem completely.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

// ── Types ─────────────────────────────────────────────────────────
export interface DragPayload {
  /** Serialised JSON identical to what was previously in dataTransfer */
  data: string;
  /** Label shown on the ghost element */
  label: string;
  /** Optional cover URL for the ghost */
  coverUrl?: string;
}

interface DragState {
  payload: DragPayload | null;
  position: { x: number; y: number };
}

interface DragDropContextValue {
  /** Begin a drag.  Called from mousedown (after threshold). */
  startDrag: (payload: DragPayload, x: number, y: number) => void;
  /** Current drag payload (null when idle). */
  payload: DragPayload | null;
  /** Whether a drag is in progress. */
  isDragging: boolean;
}

const Ctx = createContext<DragDropContextValue>({
  startDrag: () => {},
  payload: null,
  isDragging: false,
});

export const useDragDrop = () => useContext(Ctx);

// ── Ghost overlay ─────────────────────────────────────────────────
function DragGhost({ state }: { state: DragState }) {
  if (!state.payload) return null;
  const { label, coverUrl } = state.payload;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: state.position.x + 12,
        top: state.position.y - 20,
        pointerEvents: 'none',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--bg-card, #1e1e2e)',
        border: '1px solid var(--border, rgba(255,255,255,0.1))',
        borderRadius: 8,
        padding: '6px 12px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        color: 'var(--text-primary, #fff)',
        fontSize: 13,
        fontWeight: 500,
        maxWidth: 280,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        opacity: 0.95,
        userSelect: 'none',
      }}
    >
      {coverUrl && (
        <img
          src={coverUrl}
          alt=""
          style={{
            width: 28,
            height: 28,
            borderRadius: 4,
            objectFit: 'cover',
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
    </div>,
    document.body,
  );
}

// ── Provider ──────────────────────────────────────────────────────
export function DragDropProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DragState>({
    payload: null,
    position: { x: 0, y: 0 },
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const startDrag = useCallback(
    (payload: DragPayload, x: number, y: number) => {
      // Clear any text selection the browser may have started during the
      // threshold detection phase (mousedown → mousemove before startDrag).
      window.getSelection()?.removeAllRanges();
      setState({ payload, position: { x, y } });
    },
    [],
  );

  // Global mousemove + mouseup listeners (only while dragging)
  useEffect(() => {
    if (!state.payload) return;

    let ended = false;

    const onMove = (e: MouseEvent) => {
      // preventDefault stops the browser from treating the mouse movement as
      // a text-selection drag, which causes element highlighting and
      // horizontal auto-scroll in grid containers.
      e.preventDefault();
      setState((prev) => ({ ...prev, position: { x: e.clientX, y: e.clientY } }));
    };

    /** End drag; optionally fire `psy-drop` at the last known cursor position. */
    const endDrag = (dispatchDrop: boolean) => {
      if (ended || !stateRef.current.payload) return;
      ended = true;

      window.getSelection()?.removeAllRanges();

      if (dispatchDrop) {
        const evt = new CustomEvent('psy-drop', {
          bubbles: true,
          detail: stateRef.current.payload,
        });
        const el = document.elementFromPoint(
          stateRef.current.position.x,
          stateRef.current.position.y,
        );
        if (el) el.dispatchEvent(evt);
      }

      setState({ payload: null, position: { x: 0, y: 0 } });
    };

    const onUp = () => endDrag(true);
    /** Wayland: webview may not get `mouseup` when the pointer leaves the surface — clear the ghost without a drop. */
    const onBlur = () => endDrag(false);
    const onVisibility = () => {
      if (document.hidden) endDrag(false);
    };
    const onPointerCancel = () => endDrag(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endDrag(false);
      }
    };

    document.addEventListener('mousemove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKeyDown, true);

    document.body.classList.add('psy-dragging');

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.classList.remove('psy-dragging');
    };
  }, [state.payload]);

  const ctxValue: DragDropContextValue = {
    startDrag,
    payload: state.payload,
    isDragging: state.payload !== null,
  };

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      <DragGhost state={state} />
    </Ctx.Provider>
  );
}

// ── useDragSource hook ────────────────────────────────────────────
const DRAG_THRESHOLD = 5; // px before drag starts

/**
 * Returns an onMouseDown handler for a draggable element.
 * Usage:  <div {...useDragSource(payload)} />
 */
export function useDragSource(getPayload: () => DragPayload) {
  const { startDrag } = useDragDrop();
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const payloadRef = useRef(getPayload);
  payloadRef.current = getPayload;

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only left-click
      if (e.button !== 0) return;
      // Prevent the browser from starting a text-selection drag during the
      // threshold detection phase (mousedown → mousemove before startDrag).
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      startPosRef.current = { x: startX, y: startY };

      const onMove = (me: MouseEvent) => {
        if (!startPosRef.current) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          startPosRef.current = null;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          startDrag(payloadRef.current(), me.clientX, me.clientY);
        }
      };

      const onUp = () => {
        startPosRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [startDrag],
  );

  return { onMouseDown };
}
