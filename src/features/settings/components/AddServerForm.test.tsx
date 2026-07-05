import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { AddServerForm } from '@/features/settings/components/AddServerForm';
import { encodeServerMagicString } from '@/lib/server/serverMagicString';

// resolve_host_addresses Tauri command — hint-only, must not block save.
vi.mock('@/lib/api/network', () => ({
  resolveHostAddresses: vi.fn(async () => [] as string[]),
}));

// showToast mocked so we can assert two-LAN validation surfaced the error.
vi.mock('@/lib/dom/toast', () => ({
  showToast: vi.fn(),
}));

import { showToast } from '@/lib/dom/toast';

describe('AddServerForm — dual-address behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves a single-address profile without alternateUrl / shareUsesLocalUrl', async () => {
    const onSave = vi.fn();
    renderWithProviders(<AddServerForm onSave={onSave} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const inputs = screen.getAllByRole('textbox');
    // [0] name, [1] primary url, [2] alternate url, [3] username, [4] magic string
    await user.type(inputs[1]!, 'https://music.example.com');
    await user.type(inputs[3]!, 'tester');
    await user.type(screen.getByPlaceholderText('••••••••'), 'pw');
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0]![0];
    expect(arg.url).toBe('https://music.example.com');
    expect(arg.username).toBe('tester');
    expect(arg.password).toBe('pw');
    expect(arg).not.toHaveProperty('alternateUrl');
    expect(arg).not.toHaveProperty('shareUsesLocalUrl');
  });

  it('saves both addresses when the user fills the second field', async () => {
    const onSave = vi.fn();
    renderWithProviders(<AddServerForm onSave={onSave} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const inputs = screen.getAllByRole('textbox');
    // [0] name, [1] primary url, [2] alternate url, [3] username
    await user.type(inputs[1]!, 'https://music.example.com');
    await user.type(inputs[2]!, 'http://192.168.0.10:4533');
    await user.type(inputs[3]!, 'tester');
    await user.type(screen.getByPlaceholderText('••••••••'), 'pw');
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0]![0];
    expect(arg.url).toBe('https://music.example.com');
    expect(arg.alternateUrl).toBe('http://192.168.0.10:4533');
    expect(arg.shareUsesLocalUrl).toBe(false);
  });

  it('blocks save with a toast when both addresses classify as LAN', async () => {
    const onSave = vi.fn();
    renderWithProviders(<AddServerForm onSave={onSave} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[1]!, 'http://10.0.0.5');
    await user.type(inputs[2]!, 'http://192.168.0.10');
    await user.type(inputs[3]!, 'tester');
    await user.type(screen.getByPlaceholderText('••••••••'), 'pw');
    await user.click(screen.getByRole('button', { name: /add/i }));

    // Save is blocked, error toast surfaced with the two-LAN string.
    expect(onSave).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/both addresses are local/i),
      expect.any(Number),
      'error',
    );
  });

  it('decodes a v2 magic string and forwards alternateUrl + shareUsesLocalUrl on save', async () => {
    const onSave = vi.fn();
    renderWithProviders(<AddServerForm onSave={onSave} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const magicString = encodeServerMagicString({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      shareUsesLocalUrl: true,
      username: 'tester',
      password: 'pw',
    });

    // The magic-string input is the last textbox shown for new-profile mode.
    const inputs = screen.getAllByRole('textbox');
    const magicInput = inputs[inputs.length - 1]!;
    await user.type(magicInput, magicString);
    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0]![0];
    expect(arg.url).toBe('https://music.example.com');
    expect(arg.alternateUrl).toBe('http://192.168.0.10:4533');
    expect(arg.shareUsesLocalUrl).toBe(true);
    expect(arg.username).toBe('tester');
    expect(arg.password).toBe('pw');
  });

  it('strips alternateUrl + share flag when the user empties the second field', async () => {
    const onSave = vi.fn();
    renderWithProviders(
      <AddServerForm
        onSave={onSave}
        onCancel={vi.fn()}
        editingServer={{
          id: 'srv-1',
          name: 'Home',
          url: 'https://music.example.com',
          alternateUrl: 'http://192.168.0.10',
          shareUsesLocalUrl: true,
          username: 'tester',
          password: 'pw',
        }}
      />,
    );
    const user = userEvent.setup();

    // Locate the alternate-url field (second URL-shaped input, prefilled).
    const altInput = screen.getByDisplayValue('http://192.168.0.10');
    await user.clear(altInput);
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0]![0];
    expect(arg.url).toBe('https://music.example.com');
    expect(arg).not.toHaveProperty('alternateUrl');
    expect(arg).not.toHaveProperty('shareUsesLocalUrl');
  });
});

describe('AddServerForm — custom HTTP headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes configured custom headers on save', async () => {
    const onSave = vi.fn();
    renderWithProviders(<AddServerForm onSave={onSave} onCancel={vi.fn()} />);
    const user = userEvent.setup();

    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[1]!, 'https://music.example.com');
    await user.type(inputs[3]!, 'tester');
    await user.type(screen.getByPlaceholderText('••••••••'), 'pw');

    await user.click(screen.getByRole('button', { name: /custom http headers/i }));
    const headerNameInputs = screen.getAllByPlaceholderText(/header name/i);
    const headerValueInputs = screen.getAllByPlaceholderText(/header value/i);
    await user.type(headerNameInputs[0]!, 'CF-Access-Client-Secret');
    await user.type(headerValueInputs[0]!, 'gate-secret');

    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const arg = onSave.mock.calls[0]![0];
    expect(arg.customHeaders).toEqual([{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }]);
    expect(arg.customHeadersApplyTo).toBe('public');
  });
});
