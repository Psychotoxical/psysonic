import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import TooltipPortal from './TooltipPortal';

function Fixture() {
  return (
    <>
      <TooltipPortal />
      <button data-tooltip="Play this album">play</button>
    </>
  );
}

describe('TooltipPortal open delay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows the tooltip only after the 2s open delay', () => {
    renderWithProviders(<Fixture />);
    const btn = screen.getByText('play');

    fireEvent.mouseOver(btn);
    expect(screen.queryByText('Play this album')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.queryByText('Play this album')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('Play this album')).toBeInTheDocument();
  });

  it('cancels the pending tooltip when the pointer leaves before the delay', () => {
    renderWithProviders(<Fixture />);
    const btn = screen.getByText('play');

    fireEvent.mouseOver(btn);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText('Play this album')).toBeNull();
  });

  it('hides immediately on mousedown', () => {
    renderWithProviders(<Fixture />);
    const btn = screen.getByText('play');

    fireEvent.mouseOver(btn);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('Play this album')).toBeInTheDocument();

    fireEvent.mouseDown(btn);
    expect(screen.queryByText('Play this album')).toBeNull();
  });
});
