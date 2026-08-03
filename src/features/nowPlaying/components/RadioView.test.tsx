import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import type { InternetRadioStation } from '@/lib/api/subsonicTypes';
import type { RadioMetadata } from '@/features/radio';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const testState = vi.hoisted(() => ({
  visualizerPanel: vi.fn(),
  visualizerEnabled: true,
  radioSpectrumAvailable: false,
  radioSpectrumListeners: new Set<() => void>(),
  setRadioSpectrumAvailable(available: boolean) {
    this.radioSpectrumAvailable = available;
    for (const listener of this.radioSpectrumListeners) listener();
  },
}));

vi.mock('@/features/playback', () => ({
  getRadioSpectrumAvailability: () => testState.radioSpectrumAvailable,
  subscribeRadioSpectrumAvailability: (listener: () => void) => {
    testState.radioSpectrumListeners.add(listener);
    return () => testState.radioSpectrumListeners.delete(listener);
  },
  usePlayerStore: { getState: () => ({ currentRadio: null }) },
}));

vi.mock('@/features/visualizer', () => ({
  useVisualizerStore: (selector: (state: { enabledNowPlaying: boolean }) => unknown) => (
    selector({ enabledNowPlaying: testState.visualizerEnabled })
  ),
  VisualizerPanel: (props: Record<string, unknown>) => {
    testState.visualizerPanel(props);
    return <div role="region" aria-label="Visualizer" />;
  },
}));

import RadioView from './RadioView';

const station = {
  id: 'radio-1',
  name: 'Test FM',
  streamUrl: 'https://radio.test/live',
} as InternetRadioStation;

const metadata: RadioMetadata = {
  source: 'icy',
  currentArtist: 'Artist',
  currentTitle: 'Live song',
  history: [],
};

beforeEach(() => {
  testState.visualizerPanel.mockClear();
  testState.visualizerEnabled = true;
  testState.radioSpectrumAvailable = false;
  testState.radioSpectrumListeners.clear();
});

describe('RadioView visualizer integration', () => {
  it('shows a compact localized state while radio analysis is unavailable', () => {
    renderWithProviders(
      <RadioView radioMeta={metadata} currentRadio={station} resolvedCover="" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Radio visualizer unavailable');
    expect(screen.queryByRole('region', { name: 'Visualizer' })).not.toBeInTheDocument();
    expect(testState.visualizerPanel).not.toHaveBeenCalled();
  });

  it('renders the radio visualizer as soon as analysis becomes available', () => {
    renderWithProviders(
      <RadioView radioMeta={metadata} currentRadio={station} resolvedCover="" />,
    );
    act(() => testState.setRadioSpectrumAvailable(true));
    expect(screen.getByRole('region', { name: 'Visualizer' })).toBeInTheDocument();
    expect(testState.visualizerPanel).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'nowPlaying',
      className: 'np-radio-visualizer',
      paused: false,
    }));
  });

  it('passes through fullscreen coverage so the hidden route releases its feed', () => {
    testState.radioSpectrumAvailable = true;
    renderWithProviders(
      <RadioView
        radioMeta={metadata}
        currentRadio={station}
        resolvedCover=""
        visualizerPaused
      />,
    );
    expect(testState.visualizerPanel).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
  });

  it('passes resolved radio art into palette extraction', () => {
    testState.radioSpectrumAvailable = true;
    renderWithProviders(
      <RadioView
        radioMeta={metadata}
        currentRadio={station}
        resolvedCover="https://radio.test/cover.jpg"
      />,
    );
    expect(testState.visualizerPanel).toHaveBeenCalledWith(expect.objectContaining({
      artUrl: 'https://radio.test/cover.jpg',
      artKey: 'https://radio.test/cover.jpg',
    }));
  });

  it('does not show an unavailable card when the feature is disabled', () => {
    testState.visualizerEnabled = false;
    renderWithProviders(
      <RadioView radioMeta={metadata} currentRadio={station} resolvedCover="" />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(testState.visualizerPanel).not.toHaveBeenCalled();
  });
});
