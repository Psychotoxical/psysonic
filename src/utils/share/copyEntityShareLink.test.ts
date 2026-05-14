/**
 * `copyEntityShareLink` composition tests (Phase F3).
 *
 * Thin wrapper around `getBaseUrl` + `encodeSharePayload` +
 * `copyTextToClipboard` — tests pin its trimming + guard semantics so a
 * refactor doesn't silently make empty-server / empty-id calls write
 * garbage to the clipboard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyEntityShareLink } from './copyEntityShareLink';
import {
  decodeSharePayloadFromText,
  PSYSONIC_SHARE_PREFIX,
} from './shareLink';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

beforeEach(() => {
  resetAuthStore();
  // The clipboard mock from src/test/mocks/browser.ts is installed globally;
  // each test starts with a clean writeText state via resetBrowserMocks.
  vi.mocked(navigator.clipboard.writeText).mockResolvedValue();
});

describe('copyEntityShareLink', () => {
  it('writes a psysonic2-prefixed payload that round-trips to the original entity', async () => {
    const sid = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://music.example.com', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(sid);

    const ok = await copyEntityShareLink('track', 'tr-1');

    expect(ok).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
    expect(written.startsWith(PSYSONIC_SHARE_PREFIX)).toBe(true);
    expect(decodeSharePayloadFromText(written)).toEqual({
      srv: 'https://music.example.com',
      k: 'track',
      id: 'tr-1',
    });
  });

  it('returns false when no server is active (empty base URL)', async () => {
    // No addServer / setActiveServer → getBaseUrl() returns '' → bail.
    const ok = await copyEntityShareLink('album', 'al-1');
    expect(ok).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('returns false on empty or whitespace-only id', async () => {
    const sid = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(sid);

    expect(await copyEntityShareLink('artist', '')).toBe(false);
    expect(await copyEntityShareLink('artist', '   ')).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the id before encoding', async () => {
    const sid = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(sid);

    await copyEntityShareLink('composer', '  co-9  ');

    const written = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
    expect(decodeSharePayloadFromText(written)).toEqual({
      srv: 'https://x.test',
      k: 'composer',
      id: 'co-9',
    });
  });

  it('propagates a clipboard-failure return value (false)', async () => {
    const sid = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(sid);

    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('blocked'));
    // execCommand fallback also fails.
    const originalExec = document.execCommand;
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;

    const ok = await copyEntityShareLink('album', 'al-1');
    expect(ok).toBe(false);

    document.execCommand = originalExec;
  });
});
