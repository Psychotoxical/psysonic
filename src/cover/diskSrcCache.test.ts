import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => true),
  convertFileSrc: vi.fn(),
}));

import { convertFileSrc } from '@tauri-apps/api/core';
import {
  clearAllDiskSrcCache,
  coverDiskUrl,
  forgetDiskSrcForServer,
  forgetDiskSrcPrefix,
  getDiskSrc,
  rememberDiskSrc,
} from './diskSrcCache';

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

const serverScopeA = {
  kind: 'server' as const,
  serverId: 'profile-a',
  url: 'http://srv-a',
  username: 'u',
  password: 'p',
};

describe('forgetDiskSrcForServer', () => {
  beforeEach(() => {
    vi.mocked(convertFileSrc).mockImplementation((p: string) =>
      `asset://localhost/${encodeURIComponent(p)}`,
    );
    clearAllDiskSrcCache();
  });

  it('drops every cached entry under the given server index key', () => {
    rememberDiskSrc('srv-a:cover:album:al-1:128', '/disk/a/al-1/128.webp');
    rememberDiskSrc('srv-a:cover:album:al-1:512', '/disk/a/al-1/512.webp');
    rememberDiskSrc('srv-a:cover:album:al-2:128', '/disk/a/al-2/128.webp');
    rememberDiskSrc('srv-b:cover:album:al-1:128', '/disk/b/al-1/128.webp');

    forgetDiskSrcForServer('srv-a');

    expect(getDiskSrc('srv-a:cover:album:al-1:128')).toBe('');
    expect(getDiskSrc('srv-a:cover:album:al-1:512')).toBe('');
    expect(getDiskSrc('srv-a:cover:album:al-2:128')).toBe('');
    // Other servers untouched — this is the URL-change remigration path,
    // not a global purge.
    expect(getDiskSrc('srv-b:cover:album:al-1:128')).not.toBe('');
  });

  it('is a no-op on an empty key (defensive)', () => {
    rememberDiskSrc('srv-a:cover:album:al-1:128', '/disk/a/al-1/128.webp');
    forgetDiskSrcForServer('');
    expect(getDiskSrc('srv-a:cover:album:al-1:128')).not.toBe('');
  });

  it('is a no-op when nothing matches the prefix', () => {
    rememberDiskSrc('srv-a:cover:album:al-1:128', '/disk/a/al-1/128.webp');
    forgetDiskSrcForServer('srv-missing');
    expect(getDiskSrc('srv-a:cover:album:al-1:128')).not.toBe('');
  });
});

describe('forgetDiskSrcPrefix (regression — must not be confused with forgetDiskSrcForServer)', () => {
  beforeEach(() => {
    vi.mocked(convertFileSrc).mockImplementation((p: string) =>
      `asset://localhost/${encodeURIComponent(p)}`,
    );
    clearAllDiskSrcCache();
  });

  it('only clears the (server, cache entity) tuple', () => {
    rememberDiskSrc('srv-a:cover:album:al-1:128', '/disk/a/al-1/128.webp');
    rememberDiskSrc('srv-a:cover:album:al-2:128', '/disk/a/al-2/128.webp');
    forgetDiskSrcPrefix({
      serverScope: serverScopeA,
      cacheKind: 'album',
      cacheEntityId: 'al-1',
    });
    expect(getDiskSrc('srv-a:cover:album:al-1:128')).toBe('');
    expect(getDiskSrc('srv-a:cover:album:al-2:128')).not.toBe('');
  });
});
