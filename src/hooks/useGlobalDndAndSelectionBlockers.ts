import { useEffect } from 'react';

/**
 * Globally tame Linux/WebKitGTK + Wayland behaviour that the page-level
 * CSS / Tauri config can't reach:
 *
 *  - dragover/dragenter: WebKitGTK shows a permanent "forbidden" cursor
 *    for external drops unless we preventDefault and force dropEffect.
 *  - drop on document: block so an OS-file-manager drag doesn't navigate
 *    the webview away from the app.
 *  - dragstart (capture): cancel native drags from in-page elements (e.g.
 *    SVG grips) — on Wayland these can leave a stuck GTK drag-proxy.
 *    In-app moves go through psy-drag (mouse events), unaffected.
 *  - Ctrl/Cmd+A: WebKit ignores `user-select: none` for keyboard
 *    shortcuts. Still allow select-all inside real text fields.
 *  - selectstart: same story for mouse-drag selection. Allow inside
 *    inputs / textareas / contentEditable and explicit `[data-selectable]`
 *    regions (cover info, etc.).
 *
 * Harmless on Windows/macOS.
 */
export function useGlobalDndAndSelectionBlockers(): void {
  useEffect(() => {
    const allow = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const blockDrop = (e: DragEvent) => { e.preventDefault(); };

    const blockSelectAll = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
      }
    };

    const blockSelectStart = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if ((target as HTMLElement).closest('[data-selectable]')) return;
      e.preventDefault();
    };

    const blockDragStart = (e: DragEvent) => {
      e.preventDefault();
    };

    document.addEventListener('dragover', allow);
    document.addEventListener('dragenter', allow);
    document.addEventListener('drop', blockDrop);
    document.addEventListener('dragstart', blockDragStart, true);
    document.addEventListener('keydown', blockSelectAll, true);
    document.addEventListener('selectstart', blockSelectStart);

    return () => {
      document.removeEventListener('dragover', allow);
      document.removeEventListener('dragenter', allow);
      document.removeEventListener('drop', blockDrop);
      document.removeEventListener('dragstart', blockDragStart, true);
      document.removeEventListener('keydown', blockSelectAll, true);
      document.removeEventListener('selectstart', blockSelectStart);
    };
  }, []);
}
