import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { syncServerHttpContextForProfile } from '@/lib/server/syncServerHttpContext';

const server = {
  id: 'app-uuid-1',
  name: 'Gated',
  url: 'https://music.example.com',
  username: 'u',
  password: 'p',
  customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'secret' }],
  customHeadersApplyTo: 'public' as const,
};

describe('syncServerHttpContextForProfile', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('passes the wire payload under the wire key for Tauri struct args', async () => {
    await syncServerHttpContextForProfile(server);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('server_http_context_sync', {
      wire: expect.objectContaining({
        serverId: expect.any(String),
        appServerId: 'app-uuid-1',
        customHeaders: server.customHeaders,
        customHeadersApplyTo: 'public',
      }),
    });
  });
});
