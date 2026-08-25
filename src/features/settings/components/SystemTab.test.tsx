import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { SystemTab } from './SystemTab';

vi.mock('@/lib/api/platformShell', () => ({
  linuxWaylandTextRenderSettingsAvailable: vi.fn(async () => false),
}));

vi.mock('@/lib/themes/themeRegistry', () => ({
  revalidateRegistry: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => null),
}));

describe('SystemTab tray settings', () => {
  beforeEach(() => {
    resetAuthStore();
    useAuthStore.getState().setShowTrayIcon(false);
  });

  it('disables minimize to tray when the tray icon is hidden', () => {
    renderWithProviders(<SystemTab />);

    expect(screen.getByRole('checkbox', { name: 'Minimize to Tray' })).toBeDisabled();
    expect(screen.getByText(
      'Enable "Show Tray Icon" first — you need the tray to reopen the window after closing it.',
    )).toBeInTheDocument();
  });
});
