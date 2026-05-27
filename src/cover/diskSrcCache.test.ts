import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn(),
}));

import { convertFileSrc } from '@tauri-apps/api/core';
import { clearAllDiskSrcCache, coverDiskUrl, getDiskSrc, rememberDiskSrc } from './diskSrcCache';

describe('coverDiskUrl', () => {
  beforeEach(() => {
    vi.mocked(convertFileSrc).mockReset();
  });

  it('rejects raw Windows path when convertFileSrc returns passthrough', () => {
    const fsPath =
      'C:\\Users\\me\\AppData\\Roaming\\dev.psysonic.player\\cover-cache\\srv\\al-1\\128.webp';
    vi.mocked(convertFileSrc).mockReturnValue(fsPath);
    expect(coverDiskUrl(fsPath)).toBe('');
  });

  it('accepts asset.localhost URLs from convertFileSrc', () => {
    const fsPath = 'C:\\cache\\cover-cache\\srv\\al-1\\128.webp';
    vi.mocked(convertFileSrc).mockReturnValue('https://asset.localhost/C%3A%2Fcache%2F128.webp');
    expect(coverDiskUrl(fsPath)).toBe('https://asset.localhost/C%3A%2Fcache%2F128.webp');
  });

  it('normalizes Windows backslashes before convertFileSrc', () => {
    const fsPath = 'C:\\Users\\me\\cover-cache\\al-1\\128.webp';
    vi.mocked(convertFileSrc).mockImplementation((p: string) =>
      `https://asset.localhost/${encodeURIComponent(p)}`,
    );
    const url = coverDiskUrl(fsPath);
    expect(convertFileSrc).toHaveBeenCalledWith('C:/Users/me/cover-cache/al-1/128.webp');
    expect(url).toContain('asset.localhost');
  });

  it('accepts asset: protocol URLs from convertFileSrc', () => {
    const fsPath = '/home/u/.local/share/dev.psysonic.player/cover-cache/srv/al-1/128.webp';
    vi.mocked(convertFileSrc).mockReturnValue('asset://localhost/home/u/.../128.webp');
    expect(coverDiskUrl(fsPath)).toBe('asset://localhost/home/u/.../128.webp');
  });
});

describe('rememberDiskSrc', () => {
  beforeEach(() => {
    vi.mocked(convertFileSrc).mockReset();
    clearAllDiskSrcCache();
  });

  it('does not cache when coverDiskUrl rejects the path', () => {
    const fsPath = 'C:\\bad\\128.webp';
    vi.mocked(convertFileSrc).mockReturnValue(fsPath);
    expect(rememberDiskSrc('srv:cover:al-1:128', fsPath)).toBe('');
    expect(getDiskSrc('srv:cover:al-1:128')).toBe('');
  });
});
