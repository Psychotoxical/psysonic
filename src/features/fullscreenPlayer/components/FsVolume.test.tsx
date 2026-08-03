import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { FsVolume } from './FsVolume';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { onInvoke } from '@/test/mocks/tauri';

beforeEach(() => {
  resetAllStores();
  // `setVolume` pushes the level to the audio backend; stub the invoke so the
  // store update runs instead of rejecting on an uninitialised bridge.
  onInvoke('audio_set_volume', () => undefined);
});

describe('FsVolume', () => {
  it('renders the mute toggle and a slider reflecting the current volume', () => {
    usePlayerStore.setState({ volume: 0.6 });
    const { getByLabelText } = renderWithProviders(<FsVolume />);
    expect(getByLabelText('Mute')).toBeInTheDocument();
    const slider = getByLabelText('Volume') as HTMLInputElement;
    expect(slider.value).toBe('0.6');
    // Screen readers announce a meaningful percentage, not a bare 0–1 number.
    expect(slider).toHaveAttribute('aria-valuetext', '60%');
  });

  it('dragging the slider sets the volume', () => {
    usePlayerStore.setState({ volume: 0.6 });
    const { getByLabelText } = renderWithProviders(<FsVolume />);
    fireEvent.change(getByLabelText('Volume'), { target: { value: '0.25' } });
    expect(usePlayerStore.getState().volume).toBe(0.25);
  });

  it('mutes, then restores the previous level on unmute', () => {
    usePlayerStore.setState({ volume: 0.8 });
    const { getByLabelText } = renderWithProviders(<FsVolume />);
    fireEvent.click(getByLabelText('Mute'));
    expect(usePlayerStore.getState().volume).toBe(0);
    fireEvent.click(getByLabelText('Unmute'));
    expect(usePlayerStore.getState().volume).toBe(0.8);
  });

  it('adds a hover tooltip on the mute button only when asked', () => {
    const { getByLabelText, rerender } = renderWithProviders(<FsVolume />);
    expect(getByLabelText('Mute')).not.toHaveAttribute('data-tooltip');
    rerender(<FsVolume showTooltip />);
    expect(getByLabelText('Mute')).toHaveAttribute('data-tooltip', 'Mute');
  });

  it('passes each mode its own class names so the styling attaches', () => {
    const { container, getByLabelText } = renderWithProviders(
      <FsVolume className="fs-volume" buttonClassName="fs-btn" sliderClassName="fs-volume-slider" />,
    );
    expect(container.querySelector('.fs-volume')).not.toBeNull();
    expect(getByLabelText('Mute')).toHaveClass('fs-btn');
    expect(getByLabelText('Volume')).toHaveClass('fs-volume-slider');
  });
});
