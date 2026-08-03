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
import { StrictMode, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { latestIntersectionObserver } from '@/test/mocks/browser';
import {
  TRANSIENT_UI_CLOSE_EVENT,
  prepareTransientUiOpen,
} from '@/lib/dom/transientUi';

const testState = vi.hoisted(() => ({ windowHidden: false }));
const canvasProps = vi.hoisted(() => vi.fn());

vi.mock('@/features/visualizer/components/VisualizerCanvas', () => ({
  default: (props: { paused?: boolean; className?: string; artUrl: string; artKey: string }) => {
    canvasProps(props);
    return (
      <canvas
        data-testid="viz-canvas"
        data-paused={props.paused ? 'true' : 'false'}
        data-art-url={props.artUrl}
        data-art-key={props.artKey}
        className={props.className}
      />
    );
  },
}));
vi.mock('@/features/visualizer/hooks/useVisualizerCoverArt', () => ({
  useVisualizerCoverArt: () => ({ artUrl: '', artKey: '' }),
}));
vi.mock('@/lib/hooks/useWindowVisibility', () => ({
  useWindowVisibility: () => testState.windowHidden,
}));

import VisualizerPanel from '@/features/visualizer/components/VisualizerPanel';
import { useVisualizerStore } from '@/features/visualizer/store/visualizerStore';

function TransientLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div data-visualizer-transport="shell">
        <button
          type="button"
          onClick={() => {
            prepareTransientUiOpen();
            setOpen(true);
          }}
        >
          Open transient menu
        </button>
      </div>
      {open && createPortal(
        <div role="dialog" aria-label="Transient menu">
          <button type="button">Transient action</button>
        </div>,
        document.body,
      )}
    </>
  );
}

function reset(over: Record<string, unknown> = {}): void {
  useVisualizerStore.setState({
    enabledNowPlaying: true,
    enabledFullscreen: true,
    mode: 'bars',
    expandedSurface: null,
    ...over,
  });
}

afterEach(async () => {
  cleanup();
  await Promise.resolve();
});

describe('VisualizerPanel expanded overlay', () => {
  beforeEach(() => {
    reset();
    testState.windowHidden = false;
    canvasProps.mockClear();
  });

  it('renders inline when collapsed', () => {
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    expect(container.querySelector('.psy-viz-panel')).not.toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
    expect(screen.getByRole('region', { name: 'Visualizer' })).toBeInTheDocument();
  });

  it('renders a portalled overlay when expanded', () => {
    reset({ expandedSurface: 'nowPlaying' });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    // Portalled out of the card's DOM subtree, so it can escape clipped or
    // transformed ancestors.
    expect(container.querySelector('.psy-viz-overlay')).toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Visualizer' })).toBeInTheDocument();
  });

  it('dismisses transient UI before expanding', async () => {
    const user = userEvent.setup();
    const onCloseTransientUi = vi.fn();
    window.addEventListener(TRANSIENT_UI_CLOSE_EVENT, onCloseTransientUi);
    renderWithProviders(<VisualizerPanel surface="nowPlaying" />);

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));

    expect(onCloseTransientUi).toHaveBeenCalledTimes(1);
    window.removeEventListener(TRANSIENT_UI_CLOSE_EVENT, onCloseTransientUi);
  });

  it('collapses before an exposed control opens transient UI', () => {
    reset({ expandedSurface: 'nowPlaying' });
    renderWithProviders(<VisualizerPanel surface="nowPlaying" />);

    act(() => prepareTransientUiOpen());

    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
  });

  it('does not restore focus behind transient UI after collapsing', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <TransientLauncher />
        <VisualizerPanel surface="nowPlaying" />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full window' })).toHaveFocus());
    const launcher = screen.getByRole('button', { name: 'Open transient menu' });
    await user.click(launcher);

    expect(screen.getByRole('dialog', { name: 'Transient menu' })).toBeInTheDocument();
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    expect(launcher).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Fill the window' })).not.toHaveFocus();
  });

  it('keeps a fullscreen expansion inside the active fullscreen dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fullscreen Player"
        data-visualizer-overlay-host="fullscreen"
      >
        <VisualizerPanel surface="fullscreen" />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    const host = screen.getByRole('dialog', { name: 'Fullscreen Player' });
    expect(host.querySelector('.psy-viz-overlay')).not.toBeNull();
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
    reset({ enabledNowPlaying: false });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    expect(container.querySelector('.psy-viz-panel')).toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
  });

  it('reads the switch of the surface it is mounted on', () => {
    // The two surfaces are independent: switching off the page behind the
    // fullscreen player must not take the fullscreen panel with it.
    reset({ enabledNowPlaying: false, enabledFullscreen: true });
    const { container } = renderWithProviders(<VisualizerPanel surface="fullscreen" />);
    expect(container.querySelector('.psy-viz-panel')).not.toBeNull();
  });

  it('renders nothing on fullscreen when only that surface is off', () => {
    reset({ enabledNowPlaying: true, enabledFullscreen: false });
    const { container } = renderWithProviders(<VisualizerPanel surface="fullscreen" />);
    expect(container.querySelector('.psy-viz-panel')).toBeNull();
  });

  it('uses an explicit palette-art override', () => {
    renderWithProviders(
      <VisualizerPanel
        surface="nowPlaying"
        artUrl="https://radio.test/cover.jpg"
        artKey="radio-cover"
      />,
    );
    expect(screen.getByTestId('viz-canvas')).toHaveAttribute(
      'data-art-url',
      'https://radio.test/cover.jpg',
    );
    expect(screen.getByTestId('viz-canvas')).toHaveAttribute('data-art-key', 'radio-cover');
  });

  it('only expands the surface that owns the expansion', () => {
    reset({ expandedSurface: 'fullscreen' });
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    // The other surface owns the overlay; this one stays inline.
    expect(container.querySelector('.psy-viz-panel')).not.toBeNull();
    expect(document.body.querySelector('.psy-viz-overlay')).toBeNull();
  });

  it('releases expansion when its owning surface unmounts', async () => {
    reset({ expandedSurface: 'fullscreen' });
    const { unmount } = renderWithProviders(<VisualizerPanel surface="fullscreen" />);

    unmount();

    await waitFor(() => expect(useVisualizerStore.getState().expandedSurface).toBeNull());
  });

  it('does not release another surface expansion when a non-owner unmounts', async () => {
    reset({ expandedSurface: 'fullscreen' });
    const { unmount } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);

    unmount();
    await act(async () => Promise.resolve());

    expect(useVisualizerStore.getState().expandedSurface).toBe('fullscreen');
  });

  it('keeps a mounted expansion through StrictMode effect replay', async () => {
    reset({ expandedSurface: 'nowPlaying' });
    const { unmount } = renderWithProviders(
      <StrictMode>
        <VisualizerPanel surface="nowPlaying" />
      </StrictMode>,
    );

    await act(async () => Promise.resolve());
    expect(useVisualizerStore.getState().expandedSurface).toBe('nowPlaying');

    unmount();
    await waitFor(() => expect(useVisualizerStore.getState().expandedSurface).toBeNull());
  });

  it('focuses the collapse control, consumes Escape, and restores the trigger', async () => {
    const user = userEvent.setup();
    const fullscreenEscape = vi.fn();
    window.addEventListener('keydown', fullscreenEscape);
    renderWithProviders(<VisualizerPanel surface="nowPlaying" />);

    const expand = screen.getByRole('button', { name: 'Fill the window' });
    expand.focus();
    await user.click(expand);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Exit full window' })).toHaveFocus();
    });

    await user.keyboard('{Escape}');
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fill the window' })).toHaveFocus());
    expect(fullscreenEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', fullscreenEscape);
  });

  it('tabs only through overlay controls and the exposed transport', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <div data-visualizer-transport="shell">
          <button type="button">Play transport</button>
        </div>
        <VisualizerPanel surface="nowPlaying" />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full window' })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Play transport' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Switch visualizer mode' })).toHaveFocus();
  });

  it('skips exposed controls hidden by responsive layout CSS', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <div data-visualizer-transport="shell">
          <button type="button">Previous transport</button>
          <div style={{ display: 'none' }}>
            <button type="button">Hidden responsive seek</button>
          </div>
          <button type="button">Next transport</button>
        </div>
        <VisualizerPanel surface="nowPlaying" />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full window' })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Previous transport' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next transport' })).toHaveFocus();
  });

  it('hides and inerts covered shell branches while preserving exposed controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <section data-testid="covered" aria-hidden="false">
          <button type="button">Covered action</button>
        </section>
        <section data-testid="pre-hidden" aria-hidden="true" inert>
          Pre-hidden
        </section>
        <div data-visualizer-transport="shell">
          <button type="button">Play transport</button>
        </div>
        <div data-visualizer-overlay-exempt="shell">
          <button type="button">Window control</button>
        </div>
        <VisualizerPanel surface="nowPlaying" />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    const covered = screen.getByTestId('covered');
    const preHidden = screen.getByTestId('pre-hidden');
    const transport = screen.getByRole('button', { name: 'Play transport' }).parentElement!;
    const windowChrome = screen.getByRole('button', { name: 'Window control' }).parentElement!;
    expect(covered).toHaveAttribute('aria-hidden', 'true');
    expect(covered).toHaveAttribute('inert');
    expect(preHidden).toHaveAttribute('aria-hidden', 'true');
    expect(preHidden).toHaveAttribute('inert');
    expect(transport).not.toHaveAttribute('aria-hidden');
    expect(transport).not.toHaveAttribute('inert');
    expect(windowChrome).not.toHaveAttribute('aria-hidden');
    expect(windowChrome).not.toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Exit full window' }));
    await waitFor(() => expect(covered).toHaveAttribute('aria-hidden', 'false'));
    expect(covered).not.toHaveAttribute('inert');
    expect(preHidden).toHaveAttribute('aria-hidden', 'true');
    expect(preHidden).toHaveAttribute('inert');
  });

  it('isolates covered content inside the fullscreen dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fullscreen Player"
        data-visualizer-overlay-host="fullscreen"
      >
        <div data-testid="fullscreen-covered">Track details</div>
        <div data-visualizer-transport="fullscreen">
          <button type="button">Fullscreen play</button>
        </div>
        <VisualizerPanel surface="fullscreen" />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    expect(screen.getByTestId('fullscreen-covered')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('fullscreen-covered')).toHaveAttribute('inert');
    const transport = screen.getByRole('button', { name: 'Fullscreen play' }).parentElement!;
    expect(transport).not.toHaveAttribute('aria-hidden');
    expect(transport).not.toHaveAttribute('inert');
    expect(screen.getByRole('dialog', { name: 'Visualizer' })).not.toHaveAttribute(
      'aria-modal',
      'true',
    );
  });

  it('pauses a competing inline surface while the expanded owner stays active', () => {
    const { rerender } = renderWithProviders(
      <>
        <VisualizerPanel surface="nowPlaying" />
        <VisualizerPanel surface="fullscreen" />
      </>,
    );
    act(() => useVisualizerStore.getState().setExpandedSurface('nowPlaying'));
    rerender(
      <>
        <VisualizerPanel surface="nowPlaying" />
        <VisualizerPanel surface="fullscreen" />
      </>,
    );

    expect(document.querySelector('.psy-viz-overlay canvas')).toHaveAttribute('data-paused', 'false');
    expect(document.querySelector('.psy-viz-panel canvas')).toHaveAttribute('data-paused', 'true');
  });

  it('pauses the inline feed when the panel leaves the scroll viewport', () => {
    const { container } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    const observer = latestIntersectionObserver();
    expect(observer).toBeDefined();
    act(() => observer?.emit(false));
    expect(container.querySelector('canvas')).toHaveAttribute('data-paused', 'true');
  });

  it('pauses while the Tauri window is hidden', () => {
    const { container, rerender } = renderWithProviders(<VisualizerPanel surface="nowPlaying" />);
    testState.windowHidden = true;
    rerender(<VisualizerPanel surface="nowPlaying" />);
    expect(container.querySelector('canvas')).toHaveAttribute('data-paused', 'true');
  });
});
