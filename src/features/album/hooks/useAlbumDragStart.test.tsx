import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const startDrag = vi.hoisted(() => vi.fn());
const acquireUrl = vi.hoisted(() => vi.fn());

vi.mock('@/lib/dnd/DragDropContext', () => ({
  useDragDrop: () => ({ startDrag, payload: null, isDragging: false }),
}));
vi.mock('@/cover', () => ({ acquireUrl }));

import { useAlbumDragStart } from './useAlbumDragStart';

const ALBUM = { id: 'al-1', name: 'A Record', serverId: 'srv-1' };

function Probe({ disabled = false, coverKey = 'cover-key' }: { disabled?: boolean; coverKey?: string }) {
  const onMouseDown = useAlbumDragStart(ALBUM, coverKey, disabled);
  return <div data-testid="source" onMouseDown={onMouseDown} />;
}

function press(target: HTMLElement, button = 0) {
  fireEvent.mouseDown(target, { button, clientX: 100, clientY: 100 });
}

function moveTo(x: number, y: number) {
  fireEvent.mouseMove(document, { clientX: x, clientY: y });
}

describe('useAlbumDragStart', () => {
  beforeEach(() => {
    startDrag.mockReset();
    acquireUrl.mockReset().mockReturnValue('blob:cover');
  });

  // The handler keeps its document listeners until the press resolves, so a
  // test that ends mid-press would leave them armed for the next one.
  afterEach(() => {
    fireEvent.mouseUp(document);
  });

  // A press that stays put is a click on the card or row — only travel turns it
  // into a drag, otherwise every album click would start one.
  it('ignores pointer travel below the threshold', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(104, 103);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('starts a drag carrying the album payload and its cached cover', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);

    expect(startDrag).toHaveBeenCalledTimes(1);
    const [payload, x, y] = startDrag.mock.calls[0];
    expect(JSON.parse(payload.data)).toEqual({
      type: 'album',
      id: 'al-1',
      name: 'A Record',
      serverId: 'srv-1',
    });
    expect(payload.label).toBe('A Record');
    expect(payload.coverUrl).toBe('blob:cover');
    expect([x, y]).toEqual([140, 100]);
  });

  it('stops listening once the drag has started', () => {
    render(<Probe />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    moveTo(180, 100);
    expect(startDrag).toHaveBeenCalledTimes(1);
  });

  it('does not drag while selection mode is on', () => {
    render(<Probe disabled />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('ignores non-primary buttons', () => {
    render(<Probe />);
    press(screen.getByTestId('source'), 2);
    moveTo(140, 100);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it('omits the cover when nothing is cached for it', () => {
    render(<Probe coverKey="" />);
    press(screen.getByTestId('source'));
    moveTo(140, 100);
    expect(acquireUrl).not.toHaveBeenCalled();
    expect(startDrag.mock.calls[0][0].coverUrl).toBeUndefined();
  });

  // Rows are virtualised and the list can be swapped under a held button, so a
  // press can lose its source before any mouseup arrives. Without cleanup the
  // listeners outlive the component and the next pointer travel drags an album
  // that is no longer there.
  it('drops its listeners when the source unmounts mid-press', () => {
    const { unmount } = render(<Probe />);
    press(screen.getByTestId('source'));
    unmount();
    moveTo(140, 100);
    expect(startDrag).not.toHaveBeenCalled();
  });

  // Selection mode can arrive while a press is armed. The effect cleanup runs on
  // the dependency change, so the press must not survive it and drag a row the
  // user is now trying to tick.
  it('resolves an armed press when it becomes disabled', () => {
    const { rerender } = render(<Probe />);
    press(screen.getByTestId('source'));
    rerender(<Probe disabled />);
    moveTo(140, 100);
    expect(startDrag).not.toHaveBeenCalled();
  });

  // Two presses without a release in between — the first must not stay armed
  // alongside the second and fire a second drag from a stale start point.
  it('supersedes a press that never resolved', () => {
    render(<Probe />);
    const source = screen.getByTestId('source');
    press(source);
    press(source);
    moveTo(140, 100);
    expect(startDrag).toHaveBeenCalledTimes(1);
  });
});
