/**
 * Smoke + behaviour test for the mini-player webview tree. The component
 * itself is mostly composition; the meaningful logic is the storage-event
 * cross-window state-sync handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories run before module-level vars are initialized; route the
// shared mocks through vi.hoisted() so the references resolve in time.
const { themeRehydrate, fontRehydrate, keybindingsRehydrate } = vi.hoisted(() => ({
  themeRehydrate: vi.fn(),
  fontRehydrate: vi.fn(),
  keybindingsRehydrate: vi.fn(),
}));

vi.mock('../store/themeStore', () => ({
  useThemeStore: { persist: { rehydrate: themeRehydrate } },
}));
vi.mock('../store/fontStore', () => ({
  useFontStore: { persist: { rehydrate: fontRehydrate } },
}));
vi.mock('../store/keybindingsStore', () => ({
  useKeybindingsStore: { persist: { rehydrate: keybindingsRehydrate } },
}));
vi.mock('../utils/perfFlags', () => ({
  usePerfProbeFlags: () => ({ disableTooltipPortal: true }),
}));
vi.mock('../i18n', () => ({
  default: { changeLanguage: vi.fn() },
}));
vi.mock('../components/MiniPlayer', () => ({ default: () => <div data-testid="mini-player" /> }));
vi.mock('../components/GlobalConfirmModal', () => ({ default: () => <div data-testid="confirm-modal" /> }));
vi.mock('../components/TooltipPortal', () => ({ default: () => <div data-testid="tooltip-portal" /> }));
vi.mock('../components/FpsOverlay', () => ({ default: () => <div data-testid="fps-overlay" /> }));
vi.mock('../contexts/DragDropContext', () => ({
  DragDropProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { render, cleanup } from '@testing-library/react';
import MiniPlayerApp from './MiniPlayerApp';
import i18n from '../i18n';

beforeEach(() => {
  themeRehydrate.mockClear();
  fontRehydrate.mockClear();
  keybindingsRehydrate.mockClear();
  vi.mocked(i18n.changeLanguage).mockClear();
});

afterEach(() => {
  cleanup();
});

function fireStorage(key: string | null, newValue: string | null = 'x'): void {
  // jsdom does not synthesize cross-tab storage events from setItem on the
  // same window — dispatch one manually.
  window.dispatchEvent(new StorageEvent('storage', { key: key ?? '', newValue: newValue ?? '' }));
}

describe('MiniPlayerApp', () => {
  it('renders the mini-player tree (smoke)', () => {
    const { getByTestId } = render(<MiniPlayerApp />);
    expect(getByTestId('mini-player')).toBeTruthy();
    expect(getByTestId('confirm-modal')).toBeTruthy();
    expect(getByTestId('fps-overlay')).toBeTruthy();
  });

  it('hides the tooltip portal when the perf flag disables it', () => {
    const { queryByTestId } = render(<MiniPlayerApp />);
    expect(queryByTestId('tooltip-portal')).toBeNull();
  });

  describe('storage event handler', () => {
    it('rehydrates themeStore on psysonic_theme writes', () => {
      render(<MiniPlayerApp />);
      fireStorage('psysonic_theme');
      expect(themeRehydrate).toHaveBeenCalledTimes(1);
      expect(fontRehydrate).not.toHaveBeenCalled();
    });

    it('rehydrates fontStore on psysonic_font writes', () => {
      render(<MiniPlayerApp />);
      fireStorage('psysonic_font');
      expect(fontRehydrate).toHaveBeenCalledTimes(1);
    });

    it('rehydrates keybindingsStore on psysonic_keybindings writes', () => {
      render(<MiniPlayerApp />);
      fireStorage('psysonic_keybindings');
      expect(keybindingsRehydrate).toHaveBeenCalledTimes(1);
    });

    it('switches i18n language on psysonic_language writes', () => {
      render(<MiniPlayerApp />);
      fireStorage('psysonic_language', 'de');
      expect(i18n.changeLanguage).toHaveBeenCalledWith('de');
    });

    it('ignores psysonic_language when newValue is empty', () => {
      render(<MiniPlayerApp />);
      fireStorage('psysonic_language', '');
      expect(i18n.changeLanguage).not.toHaveBeenCalled();
    });

    it('ignores unrelated storage keys', () => {
      render(<MiniPlayerApp />);
      fireStorage('some-other-key');
      expect(themeRehydrate).not.toHaveBeenCalled();
      expect(fontRehydrate).not.toHaveBeenCalled();
      expect(keybindingsRehydrate).not.toHaveBeenCalled();
      expect(i18n.changeLanguage).not.toHaveBeenCalled();
    });

    it('ignores storage events with no key', () => {
      render(<MiniPlayerApp />);
      fireStorage(null);
      expect(themeRehydrate).not.toHaveBeenCalled();
    });

    it('detaches the listener on unmount', () => {
      const { unmount } = render(<MiniPlayerApp />);
      unmount();
      fireStorage('psysonic_theme');
      expect(themeRehydrate).not.toHaveBeenCalled();
    });
  });
});
