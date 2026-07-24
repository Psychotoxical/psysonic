import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  // Mimic the asset-protocol transform: an absolute path becomes an
  // asset.localhost URL; anything else is returned unchanged (out of scope).
  convertFileSrc: (p: string) =>
    /^[a-zA-Z]:\//.test(p) || p.startsWith('/') ? `https://asset.localhost/${encodeURIComponent(p)}` : p,
}));

import {
  isAllowedAssetPath,
  classifyUrlTarget,
  parseAssetRefs,
  svgContentProblems,
  rewriteAssetUrls,
} from './themeAssets';

describe('isAllowedAssetPath', () => {
  it('accepts in-tree asset paths', () => {
    expect(isAllowedAssetPath('assets/logo.svg')).toBe(true);
    expect(isAllowedAssetPath('assets/fonts/display.woff2')).toBe(true);
    expect(isAllowedAssetPath('assets/bg.webp')).toBe(true);
  });

  it('rejects traversal, absolute, remote-ish and bad types', () => {
    expect(isAllowedAssetPath('assets/../secret.svg')).toBe(false);
    expect(isAllowedAssetPath('/etc/passwd')).toBe(false);
    expect(isAllowedAssetPath('assets\\logo.svg')).toBe(false);
    expect(isAllowedAssetPath('logo.svg')).toBe(false);
    expect(isAllowedAssetPath('assets/logo.exe')).toBe(false);
    expect(isAllowedAssetPath('assets/')).toBe(false);
    expect(isAllowedAssetPath('')).toBe(false);
  });
});

describe('classifyUrlTarget', () => {
  it('separates data, asset and reject', () => {
    expect(classifyUrlTarget('data:image/png;base64,AAAA')).toBe('data');
    expect(classifyUrlTarget('assets/logo.svg')).toBe('asset');
    expect(classifyUrlTarget("'assets/logo.svg'")).toBe('asset');
    expect(classifyUrlTarget('https://evil.example/x.png')).toBe('reject');
    expect(classifyUrlTarget('//evil.example/x.png')).toBe('reject');
    expect(classifyUrlTarget('../x.png')).toBe('reject');
  });
});

describe('parseAssetRefs', () => {
  it('extracts and dedupes only asset paths', () => {
    const css = `
      .a { background: url("assets/one.webp"); }
      .b { background: url(assets/one.webp); }
      .c { background: url('assets/two.svg'); }
      .d { background: url(data:image/gif;base64,AA); }
      .e { background: url(https://x.example/three.png); }
    `;
    expect(parseAssetRefs(css)).toEqual(['assets/one.webp', 'assets/two.svg']);
  });
});

describe('svgContentProblems', () => {
  it('flags active or exfiltrating SVGs', () => {
    expect(svgContentProblems('<svg><script>x</script></svg>').length).toBeGreaterThan(0);
    expect(svgContentProblems('<svg onload="x()"></svg>').length).toBeGreaterThan(0);
    expect(svgContentProblems('<svg><foreignObject/></svg>').length).toBeGreaterThan(0);
    expect(svgContentProblems('<svg><a href="javascript:x"/></svg>').length).toBeGreaterThan(0);
    expect(svgContentProblems('<image href="https://x.example/a.png"/>').length).toBeGreaterThan(0);
  });

  it('passes a clean decorative SVG', () => {
    const clean = '<svg xmlns="http://www.w3.org/2000/svg"><use href="#g"/><path d="M0 0h10v10H0z"/></svg>';
    expect(svgContentProblems(clean)).toEqual([]);
  });
});

describe('rewriteAssetUrls', () => {
  const BASE = 'C:/Users/me/AppData/Roaming/dev.psysonic.player/themes/t';

  it('rewrites an asset url to an asset.localhost URL with no query', () => {
    const out = rewriteAssetUrls('.a{background:url("assets/logo.svg")}', BASE);
    expect(out).toContain('https://asset.localhost/');
    // No cache-busting query — it breaks the Windows WebView2 asset protocol (404).
    expect(out).not.toContain('?v=');
    expect(out).not.toContain('url("assets/logo.svg")');
  });

  it('leaves data: URIs and non-asset urls untouched', () => {
    const css = '.a{background:url(data:image/gif;base64,AA)} .b{background:url(https://x/y.png)}';
    expect(rewriteAssetUrls(css, BASE)).toBe(css);
  });

  it('is a no-op without an asset base', () => {
    const css = '.a{background:url("assets/logo.svg")}';
    expect(rewriteAssetUrls(css, '')).toBe(css);
  });
});
