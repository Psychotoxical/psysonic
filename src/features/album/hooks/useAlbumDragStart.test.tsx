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
});
