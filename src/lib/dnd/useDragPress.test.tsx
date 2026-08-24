import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { useDragPress, useDragPressHandle, type ArmDragPressOptions } from './useDragPress';

const onStart = vi.fn();

function Probe({
  disabled = false,
  preventDefault,
  canStart,
  onResolved,
}: {
  disabled?: boolean;
  preventDefault?: boolean;
  canStart?: (e: React.MouseEvent) => boolean;
  onResolved?: () => void;
}) {
  const onMouseDown = useDragPress({ onStart, disabled, preventDefault, canStart, onResolved });
  return <div data-testid="source" onMouseDown={onMouseDown} />;
}

/** A list whose rows arm the press from a row callback rather than their own hook. */
function ListProbe({ rows, options }: { rows: number[]; options?: Partial<ArmDragPressOptions> }) {
  const dragPress = useDragPressHandle();
  return (
    <div>
      {rows.map(i => (
        <div
          key={i}
          data-testid={`row-${i}`}
          onMouseDown={e => dragPress.arm(e, { onStart: () => onStart(i), ...options })}
        />
      ))}
    </div>
  );
}

function press(target: HTMLElement, button = 0) {
  fireEvent.mouseDown(target, { button, clientX: 100, clientY: 100 });
}

function moveTo(x: number, y: number) {
  fireEvent.mouseMove(document, { clientX: x, clientY: y });
}

/** Dispatched on `document` so the capture-phase guards see it, like the real one. */
function raise(type: string) {
  fireEvent(document, new Event(type, { bubbles: true }));
}

describe('useDragPress', () => {
  beforeEach(() => {
    onStart.mockReset();
  });

  // A press that stays put is a click on the row — only travel turns it into a
  // drag, otherwise every click on a source would start one.
  it('ignores pointer travel below the threshold', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(104, 103);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
  });

  it('starts once the pointer leaves the threshold, carrying the move event', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);

    expect(onStart).toHaveBeenCalledTimes(1);
    const me = onStart.mock.calls[0][0] as MouseEvent;
    expect([me.clientX, me.clientY]).toEqual([140, 100]);
  });

  it('stops listening once the drag has started', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    moveTo(180, 100);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('ignores non-primary buttons', () => {
    render(<Probe />);
    press(screen.getByTestId('source'), 2);
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('leaves the press unarmed when the guard says no', () => {
    render(<Probe canStart={() => false} />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('does not arm while disabled', () => {
    render(<Probe disabled />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // Sources on a <button> need the browser's own handling, so the default is
  // only prevented when the call site asks for it.
  it('prevents the mousedown default unless the source opts out', () => {
    const { unmount } = render(<Probe />);
    const prevented = fireEvent.mouseDown(screen.getByTestId('source'), { button: 0, clientX: 1, clientY: 1 });
    expect(prevented).toBe(false);
    fireEvent.mouseUp(document);
    unmount();

    render(<Probe preventDefault={false} />);
    const notPrevented = fireEvent.mouseDown(screen.getByTestId('source'), { button: 0, clientX: 1, clientY: 1 });
    expect(notPrevented).toBe(true);
    fireEvent.mouseUp(document);
  });

  // Rows are virtualised and the list can be swapped under a held button, so a
  // press can lose its source before any mouseup arrives. Without the teardown
  // the listeners outlive the component and the next pointer travel drags an
  // entry that is no longer there.
  it('drops its listeners when the source unmounts mid-press', () => {
    const { unmount } = render(<Probe />);
    press(screen.getByTestId('source'));
    unmount();
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // Selection mode can arrive while a press is armed. The effect cleanup runs on
  // the dependency change, so the press must not survive it and drag a row the
  // user is now trying to tick.
  it('resolves an armed press when it becomes disabled', () => {
    const { rerender } = render(<Probe />);
    press(screen.getByTestId('source'));
    rerender(<Probe disabled />);
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // Two presses without a release in between — the first must not stay armed
  // alongside the second and fire a second drag from a stale start point.
  it('supersedes a press that never resolved', () => {
    render(<Probe />);
    const source = screen.getByTestId('source');
    press(source);
    press(source);
    moveTo(140, 100);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('resolves on mouseup', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    fireEvent.mouseUp(document);
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // The lost-release guards. `DragDropContext` already carries these for an
  // in-flight drag ("Wayland: webview may not get `mouseup` when the pointer
  // leaves the surface"); an armed press had none of them.
  it.each(['pointerup', 'pointercancel'])('resolves on %s', (type) => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    raise(type);
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // The sources that leave the mousedown default in place are the ones where a
  // native image drag can begin, which fires `pointercancel` and then suppresses
  // every further mouse event — so the press can never become a drag anyway and
  // must not stay armed waiting for one.
  it('resolves on pointercancel even when the default stands', () => {
    render(<Probe preventDefault={false} />);
    press(screen.getByTestId('source'));
    raise('pointercancel');
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('resolves when the window loses focus', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    fireEvent.blur(window);
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('resolves when the document becomes hidden', () => {
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(<Probe />);
    press(screen.getByTestId('source'));
    raise('visibilitychange');
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  // A tab switch that leaves the document visible is not a lost release — the
  // press stays armed so the drag the user is still holding survives it.
  it('keeps the press armed while the document stays visible', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    raise('visibilitychange');
    moveTo(140, 100);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // `onResolved` is part of the hook's options, so it has to reach the press —
  // forwarding only some of the options would accept it and silently drop it.
  it('forwards onResolved to the press', () => {
    const onResolved = vi.fn();
    render(<Probe onResolved={onResolved} />);
    press(screen.getByTestId('source'));
    expect(onResolved).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});

describe('useDragPressHandle', () => {
  beforeEach(() => {
    onStart.mockReset();
  });

  it('starts the drag of the row that armed the press', () => {
    render(<ListProbe rows={[0, 1, 2]} />);
    press(screen.getByTestId('row-1'));
    moveTo(140, 100);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(1);
  });

  // The virtualiser recycles rows out of the DOM while the button is held; the
  // list owns the press so it still resolves when the row is gone.
  it('drops its listeners when the list unmounts mid-press', () => {
    const { unmount } = render(<ListProbe rows={[0, 1, 2]} />);
    press(screen.getByTestId('row-1'));
    unmount();
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  // The case the list-level teardown alone does not reach: the virtualiser
  // recycles the pressed row out while the list itself stays mounted, so no
  // React cleanup fires. The press would otherwise still be armed and drag the
  // row's stale index once the pointer travels.
  it('resolves when the pressed row leaves the DOM under a live list', () => {
    const { rerender } = render(<ListProbe rows={[0, 1, 2]} />);
    press(screen.getByTestId('row-1'));
    rerender(<ListProbe rows={[0, 2]} />);
    expect(screen.queryByTestId('row-1')).toBeNull();
    moveTo(140, 100);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('supersedes a press from another row that never resolved', () => {
    render(<ListProbe rows={[0, 1, 2]} />);
    press(screen.getByTestId('row-0'));
    press(screen.getByTestId('row-2'));
    moveTo(140, 100);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(2);
  });

  // A press that never armed must leave the earlier one alone, which is what the
  // per-site copies did: they returned before touching anything.
  it('leaves an armed press alone when a later press does not arm', () => {
    render(<ListProbe rows={[0, 1]} />);
    press(screen.getByTestId('row-0'));
    press(screen.getByTestId('row-1'), 2);
    moveTo(140, 100);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(0);
  });

  // The handle wraps the caller's own `onResolved` to drop its reference to the
  // resolved press; wrapping must not swallow the caller's callback.
  it('still calls the row\'s own onResolved', () => {
    const onResolved = vi.fn();
    render(<ListProbe rows={[0]} options={{ onResolved }} />);
    press(screen.getByTestId('row-0'));
    expect(onResolved).not.toHaveBeenCalled();
    fireEvent.mouseUp(document);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});

describe('armDragPress', () => {
  // The resolver closes over the row payload and its DOM node, so whoever holds
  // it needs to learn when the press is over — otherwise a list pins the last
  // pressed row for as long as it lives.
  it.each([
    ['mouseup', () => fireEvent.mouseUp(document)],
    ['pointerup', () => raise('pointerup')],
    ['pointercancel', () => raise('pointercancel')],
    ['blur', () => fireEvent.blur(window)],
    ['a drag start', () => fireEvent.mouseMove(document, { clientX: 140, clientY: 100 })],
  ])('reports the press as resolved on %s', (_label, resolve) => {
    const onResolved = vi.fn();
    render(<ListProbe rows={[0]} options={{ onResolved }} />);
    press(screen.getByTestId('row-0'));
    resolve();
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('reports the press as resolved exactly once', () => {
    const onResolved = vi.fn();
    render(<ListProbe rows={[0]} options={{ onResolved }} />);
    press(screen.getByTestId('row-0'));
    fireEvent.mouseUp(document);
    raise('pointerup');
    fireEvent.blur(window);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});
