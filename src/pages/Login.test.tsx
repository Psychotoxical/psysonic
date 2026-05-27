import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { encodeServerMagicString } from '@/utils/server/serverMagicString';

vi.mock('@/api/subsonic', () => ({
  pingWithCredentials: vi.fn(async () => ({
    ok: true,
    type: 'navidrome',
    serverVersion: '0.55.0',
    openSubsonic: true,
  })),
  scheduleInstantMixProbeForServer: vi.fn(),
}));

import { pingWithCredentials } from '@/api/subsonic';

beforeEach(() => {
  resetAuthStore();
  vi.mocked(pingWithCredentials).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Login — v2 magic string paste persistence', () => {
  it('persists alternateUrl + shareUsesLocalUrl from a pasted v2 invite', async () => {
    const Login = (await import('./Login')).default;
    renderWithProviders(<Login />);
    const user = userEvent.setup();

    const magicString = encodeServerMagicString({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      shareUsesLocalUrl: true,
      username: 'tester',
      password: 'pw',
    });

    // Find the magic-string input by its known label/placeholder. The login
    // form has multiple inputs; we use the displayed-value-after-paste path
    // to keep the test stable across UI label tweaks.
    const allTextboxes = screen.getAllByRole('textbox');
    // The magic-string input is the one whose change handler decodes and
    // prefills the rest — paste into it and the form auto-populates.
    const magicInput = allTextboxes[allTextboxes.length - 1]!;
    await user.type(magicInput, magicString);

    // Submit the form via the Connect button (label "Connect" in en locale).
    const submit = screen.getByRole('button', { name: /connect/i });
    await user.click(submit);

    await waitFor(() => {
      expect(useAuthStore.getState().servers.length).toBeGreaterThan(0);
    });

    const saved = useAuthStore.getState().servers[0]!;
    expect(saved.url).toBe('https://music.example.com');
    expect(saved.alternateUrl).toBe('http://192.168.0.10:4533');
    expect(saved.shareUsesLocalUrl).toBe(true);
    expect(saved.username).toBe('tester');
  });

  it('persists a v1 invite as a single-address profile (no alternateUrl)', async () => {
    const Login = (await import('./Login')).default;
    renderWithProviders(<Login />);
    const user = userEvent.setup();

    const v1MagicString = encodeServerMagicString({
      url: 'https://music.example.com',
      username: 'tester',
      password: 'pw',
    });

    const allTextboxes = screen.getAllByRole('textbox');
    const magicInput = allTextboxes[allTextboxes.length - 1]!;
    await user.type(magicInput, v1MagicString);

    const submit = screen.getByRole('button', { name: /connect/i });
    await user.click(submit);

    await waitFor(() => {
      expect(useAuthStore.getState().servers.length).toBeGreaterThan(0);
    });

    const saved = useAuthStore.getState().servers[0]!;
    expect(saved.url).toBe('https://music.example.com');
    // v1 invite — neither dual-address field should appear on the saved
    // profile so localStorage doesn't carry dangling defaults.
    expect(saved.alternateUrl).toBeUndefined();
    expect(saved.shareUsesLocalUrl).toBeUndefined();
  });
});
