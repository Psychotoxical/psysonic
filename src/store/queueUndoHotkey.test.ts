/**
 * Smoke + behaviour tests for the queue-undo hotkey installer. Verifies
 * idempotency (the second call is a no-op), Ctrl+Z → undo, Ctrl+Shift+Z
 * → redo, and the editable-field guard that lets the browser keep
 * native text undo inside input/textarea/contenteditable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  windowKindMock: vi.fn(() => 'main' as 'main' | 'mini'),
  undoMock: vi.fn(() => true),
  redoMock: vi.fn(() => true),
}));

vi.mock('../app/windowKind', () => ({ getWindowKind: hoisted.windowKindMock }));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: () => ({
      undoLastQueueEdit: hoisted.undoMock,
      redoLastQueueEdit: hoisted.redoMock,
    }),
  },
}));

import { _resetQueueUndoHotkeyForTest, installQueueUndoHotkey } from './queueUndoHotkey';

beforeEach(() => {
  hoisted.windowKindMock.mockReturnValue('main');
  hoisted.undoMock.mockReset();
  hoisted.undoMock.mockReturnValue(true);
  hoisted.redoMock.mockReset();
  hoisted.redoMock.mockReturnValue(true);
  _resetQueueUndoHotkeyForTest();
});

afterEach(() => {
  _resetQueueUndoHotkeyForTest();
});

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}, target?: HTMLElement): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    code: 'Key' + key.toUpperCase(),
    bubbles: true,
    cancelable: true,
    composed: true,
    ...opts,
  });
  (target ?? document.body).dispatchEvent(event);
  return event.defaultPrevented;
}

describe('installQueueUndoHotkey', () => {
  it('is a no-op when window kind is mini', () => {
    hoisted.windowKindMock.mockReturnValue('mini');
    installQueueUndoHotkey();
    fireKey('z', { ctrlKey: true });
    expect(hoisted.undoMock).not.toHaveBeenCalled();
  });

  it('fires undoLastQueueEdit on Ctrl+Z', () => {
    installQueueUndoHotkey();
    const prevented = fireKey('z', { ctrlKey: true });
    expect(hoisted.undoMock).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('fires redoLastQueueEdit on Ctrl+Shift+Z', () => {
    installQueueUndoHotkey();
    fireKey('z', { ctrlKey: true, shiftKey: true });
    expect(hoisted.redoMock).toHaveBeenCalledTimes(1);
    expect(hoisted.undoMock).not.toHaveBeenCalled();
  });

  it('honours Cmd+Z (metaKey) on macOS', () => {
    installQueueUndoHotkey();
    fireKey('z', { metaKey: true });
    expect(hoisted.undoMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — second install attaches no second listener', () => {
    installQueueUndoHotkey();
    installQueueUndoHotkey();
    fireKey('z', { ctrlKey: true });
    expect(hoisted.undoMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT preventDefault when undoLastQueueEdit returns false', () => {
    hoisted.undoMock.mockReturnValueOnce(false);
    installQueueUndoHotkey();
    const prevented = fireKey('z', { ctrlKey: true });
    expect(prevented).toBe(false);
  });

  it('skips when the target is an INPUT element (native text undo)', () => {
    installQueueUndoHotkey();
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      fireKey('z', { ctrlKey: true }, input);
      expect(hoisted.undoMock).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  it('skips when the target is a TEXTAREA', () => {
    installQueueUndoHotkey();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    try {
      fireKey('z', { ctrlKey: true }, ta);
      expect(hoisted.undoMock).not.toHaveBeenCalled();
    } finally {
      ta.remove();
    }
  });

  it('does nothing for keys other than Z', () => {
    installQueueUndoHotkey();
    fireKey('a', { ctrlKey: true });
    expect(hoisted.undoMock).not.toHaveBeenCalled();
  });

  it('does nothing without Ctrl / Cmd modifier', () => {
    installQueueUndoHotkey();
    fireKey('z');
    expect(hoisted.undoMock).not.toHaveBeenCalled();
  });
});
