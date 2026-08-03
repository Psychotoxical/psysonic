import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { AddServerForm } from '@/features/settings/components/AddServerForm';
import { encodeServerMagicString } from '@/lib/server/serverMagicString';
import { useAuthStore } from '@/store/authStore';

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
    resetAuthStore();
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
    resetAuthStore();
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

describe('AddServerForm — streaming quality', () => {
  const editingServer = {
    id: 'srv-1',
    name: 'Home',
    url: 'https://music.example.com',
    alternateUrl: 'http://192.168.0.10:4533',
    shareUsesLocalUrl: false,
    username: 'tester',
    password: 'pw',
  };

  beforeEach(() => {
    resetAuthStore();
    vi.clearAllMocks();
    useAuthStore.setState({
      servers: [editingServer],
      subsonicServerIdentityByServer: {
        'srv-1': { type: 'navidrome', serverVersion: '0.56.0', openSubsonic: true },
      },
      streamQualityByAddress: {
        'https://music.example.com': 192,
        'http://192.168.0.10:4533': 96,
      },
      streamFormatByAddress: {
        'https://music.example.com': 'mp3',
        'http://192.168.0.10:4533': 'opus',
      },
    });
  });

  it('shows both saved addresses in one disclosure below custom HTTP headers', async () => {
    renderWithProviders(
      <AddServerForm editingServer={editingServer} onSave={vi.fn()} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();
    const customHeadersToggle = screen.getByRole('button', { name: /Custom HTTP headers/i });
    const streamQualityToggle = screen.getByRole('button', { name: /Streaming Quality/ });

    expect(customHeadersToggle.compareDocumentPosition(streamQualityToggle))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(streamQualityToggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(streamQualityToggle);
    expect(streamQualityToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox', {
      name: 'Streaming Quality · https://music.example.com',
    })).toHaveTextContent('192 kbps');
    expect(screen.getByRole('combobox', {
      name: 'Transcode format · https://music.example.com',
    })).toHaveTextContent('MP3');

    expect(screen.getByRole('combobox', {
      name: 'Streaming Quality · http://192.168.0.10:4533',
    })).toHaveTextContent('96 kbps');
  });

  it('renders its disclosure with the same flat chrome as the one above it', () => {
    renderWithProviders(
      <AddServerForm editingServer={editingServer} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    // `.btn-ghost` carries a resting border and tint; `btn-ghost--flat` opts out.
    // Both disclosures sit in the same form with `padding: 4px 0`, so an outline
    // on one of them would box its text and split two identical controls.
    for (const name of [/Custom HTTP headers/i, /Streaming Quality/]) {
      expect(screen.getByRole('button', { name })).toHaveClass('btn-ghost--flat');
    }
  });

  it('applies staged per-address values only after a successful save', async () => {
    const onSave = vi.fn(async (_data, onPersisted?: () => void) => {
      onPersisted?.();
    });
    renderWithProviders(
      <AddServerForm editingServer={editingServer} onSave={onSave} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Streaming Quality/ }));
    await user.click(screen.getByRole('combobox', {
      name: 'Streaming Quality · https://music.example.com',
    }));
    await user.click(screen.getByRole('option', { name: '128 kbps' }));
    await user.click(screen.getByRole('combobox', {
      name: 'Transcode format · https://music.example.com',
    }));
    await user.click(screen.getByRole('option', { name: 'OPUS' }));

    expect(useAuthStore.getState().streamQualityByAddress['https://music.example.com']).toBe(192);
    expect(useAuthStore.getState().streamFormatByAddress['https://music.example.com']).toBe('mp3');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().streamQualityByAddress['https://music.example.com']).toBe(128);
      expect(useAuthStore.getState().streamFormatByAddress['https://music.example.com']).toBe('opus');
    });
  });

  it('does not apply staged values when the server edit is rejected', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <AddServerForm editingServer={editingServer} onSave={onSave} onCancel={vi.fn()} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Streaming Quality/ }));
    await user.click(screen.getByRole('combobox', {
      name: 'Streaming Quality · https://music.example.com',
    }));
    await user.click(screen.getByRole('option', { name: '64 kbps' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState().streamQualityByAddress['https://music.example.com']).toBe(192);
  });

  it('keeps the controls hidden until the server is verified as Navidrome', () => {
    useAuthStore.setState({ subsonicServerIdentityByServer: {} });
    renderWithProviders(
      <AddServerForm editingServer={editingServer} onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.queryByRole('button', { name: /Streaming Quality/ })).not.toBeInTheDocument();
  });
});
