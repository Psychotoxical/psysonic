import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarItemConfig } from '@/features/sidebar/store/sidebarStore';
import {
  applySidebarReorderById,
  isSidebarNavItemUserHideable,
  type SidebarNavDropTarget,
} from '@/features/sidebar/utils/sidebarNavReorder';
import {
  SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX,
  SIDEBAR_NAV_LONG_PRESS_MS,
  isPointerOutsideAsideSidebar,
} from '@/features/sidebar/utils/sidebarHelpers';

interface NavDndState {
  section: 'library' | 'system';
  draggedId: string;
}

interface Args {
  isCollapsed: boolean;
  sidebarItemsRef: React.MutableRefObject<SidebarItemConfig[]>;
  setSidebarItems: (items: SidebarItemConfig[]) => void;
}

interface Result {
  navDnd: NavDndState | null;
  navDropTarget: SidebarNavDropTarget | null;
  navDndTrashHint: { x: number; y: number } | null;
  suppressNavClickRef: React.MutableRefObject<boolean>;
  handleNavRowPointerDown: (e: React.PointerEvent, section: 'library' | 'system', id: string) => void;
  navDndRowClass: (section: 'library' | 'system', id: string) => string;
}

export function useSidebarNavDnd({
  isCollapsed, sidebarItemsRef, setSidebarItems,
}: Args): Result {
  const [navDnd, setNavDnd] = useState<NavDndState | null>(null);
  const [navDropTarget, setNavDropTarget] = useState<SidebarNavDropTarget | null>(null);
  const navDropTargetRef = useRef<SidebarNavDropTarget | null>(null);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  navDropTargetRef.current = navDropTarget;
  /** DOM timers are numeric; avoid NodeJS `Timeout` typing from `setTimeout`. */
  const longPressTimersRef = useRef<Map<number, number>>(new Map());
  const suppressNavClickRef = useRef(false);
  const lastPointerDuringNavDndRef = useRef({ x: 0, y: 0 });
  const [navDndTrashHint, setNavDndTrashHint] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => {
    longPressTimersRef.current.forEach(t => window.clearTimeout(t));
    longPressTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!navDnd) return;

    const updateDropFromPoint = (clientX: number, clientY: number) => {
      if (isPointerOutsideAsideSidebar(clientX, clientY)) {
        navDropTargetRef.current = null;
        setNavDropTarget(null);
        return;
      }
      const rows = document.querySelectorAll<HTMLElement>('.sidebar [data-sidebar-nav-dnd-row]');
      let target: SidebarNavDropTarget | null = null;
      for (const row of rows) {
        const section = row.dataset.sidebarSection as 'library' | 'system' | undefined;
        if (section !== navDnd.section) continue;
        const rect = row.getBoundingClientRect();
        const id = row.dataset.sidebarId;
        if (!id) continue;
        if (clientY < rect.top + rect.height / 2) {
          target = { id, before: true, section };
          break;
        }
        target = { id, before: false, section };
      }
      navDropTargetRef.current = target;
      setNavDropTarget(target);
    };

    const endDrag = (apply: boolean) => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
      setNavDndTrashHint(null);

      const currentDnd = navDnd;
      const drop = navDropTargetRef.current;
      setNavDnd(null);
      setNavDropTarget(null);
      navDropTargetRef.current = null;

      if (!apply || !currentDnd) return;

      const { x, y } = lastPointerDuringNavDndRef.current;
      if (isPointerOutsideAsideSidebar(x, y)) {
        const id = currentDnd.draggedId;
        if (id && isSidebarNavItemUserHideable(id)) {
          const nextItems: SidebarItemConfig[] = sidebarItemsRef.current.map(i =>
            i.id === id ? { ...i, visible: false } : i,
          );
          setSidebarItems(nextItems);
          suppressNavClickRef.current = true;
        }
        return;
      }

      const next = applySidebarReorderById(
        sidebarItemsRef.current,
        currentDnd.section,
        currentDnd.draggedId,
        drop,
      );
      if (next) {
        setSidebarItems(next);
        suppressNavClickRef.current = true;
      }
    };

    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      lastPointerDuringNavDndRef.current = { x: e.clientX, y: e.clientY };

      const outside = isPointerOutsideAsideSidebar(e.clientX, e.clientY);
      const draggedId = navDnd.draggedId;
      const canTrash = Boolean(draggedId && isSidebarNavItemUserHideable(draggedId));
      if (outside && canTrash) {
        setNavDndTrashHint({ x: e.clientX, y: e.clientY });
      } else {
        setNavDndTrashHint(null);
      }

      updateDropFromPoint(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      lastPointerDuringNavDndRef.current = { x: e.clientX, y: e.clientY };
      suppressNavClickRef.current = true;
      endDrag(true);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endDrag(false);
      }
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);

    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.userSelect = '';
      setNavDndTrashHint(null);
    };
  }, [navDnd, setSidebarItems, sidebarItemsRef]);

  const handleNavRowPointerDown = useCallback(
    (e: React.PointerEvent, section: 'library' | 'system', id: string) => {
      if (isCollapsed || navDnd) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const pid = e.pointerId;
      const sx = e.clientX;
      const sy = e.clientY;

      let cleaned = false;
      const cleanupEarly = () => {
        if (cleaned) return;
        cleaned = true;
        document.removeEventListener('pointermove', onEarlyMove);
        document.removeEventListener('pointerup', onEarlyUp, true);
        document.removeEventListener('pointercancel', onEarlyUp, true);
      };

      const onEarlyMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > SIDEBAR_NAV_LONG_PRESS_MOVE_CANCEL_PX) {
          const t = longPressTimersRef.current.get(pid);
          if (t != null) window.clearTimeout(t);
          longPressTimersRef.current.delete(pid);
          cleanupEarly();
        }
      };

      const onEarlyUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pid) return;
        const t = longPressTimersRef.current.get(pid);
        if (t != null) window.clearTimeout(t);
        longPressTimersRef.current.delete(pid);
        cleanupEarly();
      };

      const timer = window.setTimeout(() => {
        longPressTimersRef.current.delete(pid);
        cleanupEarly();
        window.getSelection()?.removeAllRanges();
        lastPointerDuringNavDndRef.current = { x: sx, y: sy };
        setNavDnd({ section, draggedId: id });
        navDropTargetRef.current = { id, before: true, section };
        setNavDropTarget({ id, before: true, section });
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(pid);
        } catch {
          /* ignore */
        }
      }, SIDEBAR_NAV_LONG_PRESS_MS) as unknown as number;

      longPressTimersRef.current.set(pid, timer);
      document.addEventListener('pointermove', onEarlyMove);
      document.addEventListener('pointerup', onEarlyUp, true);
      document.addEventListener('pointercancel', onEarlyUp, true);
    },
    [isCollapsed, navDnd],
  );

  const navDndRowClass = useCallback(
    (section: 'library' | 'system', id: string) => {
      const dragging = navDnd?.section === section && navDnd.draggedId === id;
      let drop = '';
      if (
        navDnd &&
        navDropTarget?.section === section &&
        navDropTarget.id === id &&
        !(navDnd.section === section && navDnd.draggedId === id)
      ) {
        drop = navDropTarget.before
          ? 'sidebar-nav-dnd-row--drop-before'
          : 'sidebar-nav-dnd-row--drop-after';
      }
      return `sidebar-nav-dnd-row${dragging ? ' sidebar-nav-dnd-row--dragging' : ''}${drop ? ` ${drop}` : ''}`.trim();
    },
    [navDnd, navDropTarget],
  );

  return {
    navDnd,
    navDropTarget,
    navDndTrashHint,
    suppressNavClickRef,
    handleNavRowPointerDown,
    navDndRowClass,
  };
}
