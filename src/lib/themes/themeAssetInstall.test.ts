import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeThemeAssets = vi.fn();
vi.mock('@/lib/themes/themeAssetStorage', () => ({
  writeThemeAssets: (...a: unknown[]) => writeThemeAssets(...a),
}));
// installRegistryAssets needs the registry fetch; not exercised here.
vi.mock('@/lib/themes/themeRegistry', () => ({ fetchThemeAssetBytes: vi.fn() }));

import { installLocalAssets, type LocalAssetInput } from '@/lib/themes/themeAssetInstall';

const bytes = (s: string) => new TextEncoder().encode(s);
const svg = (body = '<path d="M0 0"/>') => bytes(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

beforeEach(() => {
  writeThemeAssets.mockReset();
  writeThemeAssets.mockResolvedValue('/data/themes/t');
});

describe('installLocalAssets', () => {
  it('writes referenced, in-contract assets and returns the base', async () => {
    const provided: LocalAssetInput[] = [{ rel: 'assets/logo.svg', bytes: svg() }];
    const res = await installLocalAssets('t', ['assets/logo.svg'], provided);
    expect(res).toEqual({ ok: true, assetBase: '/data/themes/t', rels: ['assets/logo.svg'] });
    expect(writeThemeAssets).toHaveBeenCalledOnce();
  });

  it('rejects when a referenced asset is missing from the zip', async () => {
    const res = await installLocalAssets('t', ['assets/logo.svg'], []);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(writeThemeAssets).not.toHaveBeenCalled();
  });

  it('rejects an SVG carrying active content', async () => {
    const provided: LocalAssetInput[] = [{ rel: 'assets/x.svg', bytes: svg('<script>x</script>') }];
    const res = await installLocalAssets('t', ['assets/x.svg'], provided);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
    expect(writeThemeAssets).not.toHaveBeenCalled();
  });

  it('rejects a path that escapes the assets folder', async () => {
    const provided: LocalAssetInput[] = [{ rel: 'assets/../evil.svg', bytes: svg() }];
    const res = await installLocalAssets('t', ['assets/../evil.svg'], provided);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  it('writes only the referenced subset, dropping unreferenced files', async () => {
    const provided: LocalAssetInput[] = [
      { rel: 'assets/logo.svg', bytes: svg() },
      { rel: 'assets/unused.webp', bytes: bytes('x') },
    ];
    const res = await installLocalAssets('t', ['assets/logo.svg'], provided);
    expect(res.ok).toBe(true);
    const written = writeThemeAssets.mock.calls[0][1] as { rel: string }[];
    expect(written.map((e) => e.rel)).toEqual(['assets/logo.svg']);
  });
});
