import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import TooltipPortal from '@/ui/TooltipPortal';

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

  it('shows the tooltip only after the 1s open delay', () => {
    renderWithProviders(<Fixture />);
    const btn = screen.getByText('play');

    fireEvent.mouseOver(btn);
    expect(screen.queryByText('Play this album')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(999);
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
      vi.advanceTimersByTime(500);
    });
    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByText('Play this album')).toBeNull();
  });

  it('hides immediately on mousedown', () => {
    renderWithProviders(<Fixture />);
    const btn = screen.getByText('play');

    fireEvent.mouseOver(btn);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Play this album')).toBeInTheDocument();

    fireEvent.mouseDown(btn);
    expect(screen.queryByText('Play this album')).toBeNull();
  });

  it('shows immediately on click when data-tooltip-click is set', () => {
    renderWithProviders(
      <>
        <TooltipPortal />
        <button data-tooltip="Server version" data-tooltip-click="">info</button>
      </>,
    );
    const btn = screen.getByText('info');

    fireEvent.click(btn);
    expect(screen.getByText('Server version')).toBeInTheDocument();
  });

  it('does not hide click-mode tooltips on mousedown', () => {
    renderWithProviders(
      <>
        <TooltipPortal />
        <button data-tooltip="Server version" data-tooltip-click="">info</button>
      </>,
    );
    const btn = screen.getByText('info');

    fireEvent.click(btn);
    expect(screen.getByText('Server version')).toBeInTheDocument();

    fireEvent.mouseDown(btn);
    expect(screen.getByText('Server version')).toBeInTheDocument();
  });

  it('toggles off when the click anchor is clicked again', () => {
    renderWithProviders(
      <>
        <TooltipPortal />
        <button data-tooltip="Server version" data-tooltip-click="">info</button>
      </>,
    );
    const btn = screen.getByText('info');

    fireEvent.click(btn);
    expect(screen.getByText('Server version')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(screen.queryByText('Server version')).toBeNull();
  });

  it('keeps click-opened tooltips visible after mouseout', () => {
    renderWithProviders(
      <>
        <TooltipPortal />
        <button data-tooltip="Server version" data-tooltip-click="">info</button>
      </>,
    );
    const btn = screen.getByText('info');

    fireEvent.click(btn);
    expect(screen.getByText('Server version')).toBeInTheDocument();

    fireEvent.mouseOut(btn, { relatedTarget: document.body });
    expect(screen.getByText('Server version')).toBeInTheDocument();
  });
});
