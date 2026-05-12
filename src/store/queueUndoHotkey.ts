import { getWindowKind } from '../app/windowKind';
import { usePlayerStore } from './playerStore';

const QUEUE_UNDO_HOTKEY_FLAG = '__psyQueueUndoListenerInstalled';

/** True when the event path includes a real text field — skip queue undo so Ctrl+Z stays native there. */
function keyboardEventTargetIsEditableField(e: KeyboardEvent): boolean {
  for (const n of e.composedPath()) {
    if (!(n instanceof HTMLElement)) continue;
    const tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (n.isContentEditable) return true;
  }
  return false;
}

let installedHandler: ((e: KeyboardEvent) => void) | null = null;

/**
 * Ctrl+Z / Cmd+Z undo and Ctrl+Shift+Z / Cmd+Shift+Z redo for the queue —
 * document capture. Call once at startup (e.g. from bootstrap.ts);
 * idempotent via the window-scoped flag. Skips the mini-player window so
 * the host renderer owns queue history.
 */
export function installQueueUndoHotkey(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[QUEUE_UNDO_HOTKEY_FLAG]) return;
  if (getWindowKind() === 'mini') return;
  w[QUEUE_UNDO_HOTKEY_FLAG] = true;
  const handler = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.code !== 'KeyZ' && String(e.key || '').toLowerCase() !== 'z') return;
    if (keyboardEventTargetIsEditableField(e)) return;

    if (e.shiftKey) {
      if (usePlayerStore.getState().redoLastQueueEdit()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (usePlayerStore.getState().undoLastQueueEdit()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  installedHandler = handler;
  document.addEventListener('keydown', handler, true);
}

/** Test-only: remove the installed listener and clear the install flag. */
export function _resetQueueUndoHotkeyForTest(): void {
  if (typeof window === 'undefined') return;
  if (installedHandler) {
    document.removeEventListener('keydown', installedHandler, true);
    installedHandler = null;
  }
  const w = window as unknown as Record<string, unknown>;
  w[QUEUE_UNDO_HOTKEY_FLAG] = undefined;
}
