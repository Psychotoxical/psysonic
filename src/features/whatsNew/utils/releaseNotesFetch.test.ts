import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const isTauri = vi.fn(() => true);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => isTauri(),
}));

const { fetchWhatsNewAsset, whatsNewDownloadUrl } = await import('@/features/whatsNew/utils/releaseNotesFetch');

describe('releaseNotesFetch', () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReturnValue(true);
  });

  it('builds the release download URL from version', () => {
    expect(whatsNewDownloadUrl('1.48.0-rc.1')).toBe(
      'https://github.com/Psychotoxical/psysonic/releases/download/app-v1.48.0-rc.1/whats-new.md',
    );
  });

  it('fetches via fetch_url_bytes Rust proxy', async () => {
    const body = '# Highlights\n- Item';
    invoke.mockResolvedValueOnce([[...new TextEncoder().encode(body)], 'text/plain']);

    const text = await fetchWhatsNewAsset('1.48.0');
    expect(invoke).toHaveBeenCalledWith('fetch_url_bytes', {
      url: 'https://github.com/Psychotoxical/psysonic/releases/download/app-v1.48.0/whats-new.md',
    });
    expect(text).toBe(body);
  });

  it('returns null outside Tauri', async () => {
    isTauri.mockReturnValue(false);
    expect(await fetchWhatsNewAsset('1.48.0')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
