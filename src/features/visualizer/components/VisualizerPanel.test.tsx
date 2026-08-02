/**
 * Expanded-overlay containment.
 *
 * The overlay is portalled to `<body>`, which moves the DOM node but *not* the
 * React tree — events still bubble to the component's React ancestors. On Now
 * Playing that ancestor is the card's mousedown-based drag source, so without
 * an explicit stop, dragging anywhere on a full-window visualizer starts
 * repositioning the card behind it (and the same swallow covers the window's
 * title bar, which is the only place the OS window can be dragged from).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

vi.mock('@/features/visualizer/components/VisualizerCanvas', () => ({
  default: () => <canvas data-testid="viz-canvas" />,
}));
vi.mock('@/features/visualizer/hooks/useVisualizerCoverArt', () => ({
  useVisualizerCoverArt: () => ({ artUrl: '', artKey: '' }),
}));

import VisualizerPanel from '@/features/visualizer/components/VisualizerPanel';
import { useVisualizerStore } from '@/features/visualizer/store/visualizerStore';

function reset(over: Record<string, unknown> = {}): void {
  useVisualizerStore.setState({
    enabled: true,
    mode: 'bars',
    expandedSurface: null,
    ...over,
  });
}

afterEach(() => cleanup());

describe('VisualizerPanel expanded overlay', () => {
  beforeEach(() => reset());

  it('renders inline when collapsed', () => {
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    expect(container.querySelector('.psy-viz-panel')).not.toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
  });

  it('renders a portalled overlay when expanded', () => {
    reset({ expandedSurface: 'nowPlaying' });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    // Portalled out of the card's DOM subtree, so it can escape clipped or
    // transformed ancestors.
    expect(container.querySelector('.psy-viz-overlay')).toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).not.toBeNull();
  });

  it('does not let a drag on the overlay reach the card behind it', () => {
    reset({ expandedSurface: 'nowPlaying' });
    const onMouseDown = vi.fn();
    renderWithProviders(
      <div onMouseDown={onMouseDown}>
        <VisualizerPanel surface="nowPlaying" />
      </div>,
    );

    const overlay = document.body.querySelector('.psy-viz-overlay')!;
    fireEvent.mouseDown(overlay, { button: 0, clientX: 10, clientY: 10 });

    // The Now Playing card wrapper's drag source listens on mousedown; a
    // full-window visualizer has no meaningful position to be dragged to.
    expect(onMouseDown).not.toHaveBeenCalled();
  });

  it('still swallows drags that start on the overlay\'s own controls', () => {
    reset({ expandedSurface: 'nowPlaying' });
    const onMouseDown = vi.fn();
    renderWithProviders(
      <div onMouseDown={onMouseDown}>
        <VisualizerPanel surface="nowPlaying" />
      </div>,
    );

    const button = document.body.querySelector('.psy-viz-overlay .psy-viz-btn')!;
    fireEvent.mouseDown(button, { button: 0 });
    expect(onMouseDown).not.toHaveBeenCalled();
  });

  it('keeps the overlay controls clickable', () => {
    reset({ expandedSurface: 'nowPlaying' });
    renderWithProviders(<VisualizerPanel surface="nowPlaying" />);

    // Collapse is the second control; stopping mousedown must not break clicks.
    const buttons = document.body.querySelectorAll('.psy-viz-overlay .psy-viz-btn');
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
  });

  it('lets a drag through when collapsed, so the card stays reorderable', () => {
    const onMouseDown = vi.fn();
    const { container } = renderWithProviders(
      <div onMouseDown={onMouseDown}>
        <VisualizerPanel surface="nowPlaying" />
      </div>,
    );

    fireEvent.mouseDown(container.querySelector('.psy-viz-panel')!, { button: 0 });
    expect(onMouseDown).toHaveBeenCalled();
  });

  it('renders nothing at all when the visualizer is disabled', () => {
    reset({ enabled: false });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    expect(container.querySelector('.psy-viz-panel')).toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
  });

  it('only expands the surface that owns the expansion', () => {
    reset({ expandedSurface: 'fullscreen' });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    // The other surface owns the overlay; this one stays inline.
    expect(container.querySelector('.psy-viz-panel')).not.toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
  });

  it('collapses on Escape', () => {
    reset({ expandedSurface: 'nowPlaying' });
    renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
  });
});
