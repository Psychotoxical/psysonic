import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Local theme assets — the in-app mirror of the repo's `scripts/theme-assets.mjs`.
 *
 * A theme may ship images and fonts in an `assets/` folder and reference them
 * with a relative `url("assets/…")`. Themes still never reach the network: a
 * `url()` is a `data:` URI or a local `assets/` path, nothing else. These rules
 * are the security boundary, so they are kept byte-for-byte in step with the CI
 * validator and covered by the same test cases.
 */

/** Extensions an asset file may use. Images plus web fonts — nothing executable. */
export const ASSET_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif', 'svg', 'woff2', 'woff'] as const;

/** Budgets. Small on purpose; the 256 KB CSS cap is separate and unchanged. */
export const ASSET_CAPS = {
  perFileBytes: 1 * 1024 * 1024, // 1 MB
  perThemeBytes: 4 * 1024 * 1024, // 4 MB
  maxFiles: 32,
};

const EXT_RE = new RegExp(`\\.(${ASSET_EXTS.join('|')})$`, 'i');

/** True when a relative path is a safe, in-tree `assets/…` reference. */
export function isAllowedAssetPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\\')) return false; // backslash — never a web path
  if (p.startsWith('/')) return false; // absolute
  if (!p.startsWith('assets/')) return false; // must live under assets/
  const segments = p.split('/');
  if (segments.some((s) => s === '..' || s === '')) return false; // no traversal / empty segment
  return EXT_RE.test(p);
}

/** Classify a raw url() target: 'data' | 'asset' | 'reject'. */
export function classifyUrlTarget(inner: string): 'data' | 'asset' | 'reject' {
  const s = inner.trim().replace(/^['"]/, '').replace(/['"]$/, '').trim();
  if (/^data:/i.test(s)) return 'data';
  if (isAllowedAssetPath(s)) return 'asset';
  return 'reject';
}

/** Every `assets/…` path referenced by the CSS (deduped, first-seen order). */
export function parseAssetRefs(css: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(css)) !== null) {
    const target = m[2].trim();
    if (isAllowedAssetPath(target) && !seen.has(target)) {
      seen.add(target);
      refs.push(target);
    }
  }
  return refs;
}

/**
 * Inspect an SVG that will be referenced from CSS `url()`. Rendered that way a
 * browser does not run scripts, but sideloaded themes are not moderated, so the
 * app runs the same defence-in-depth check the CI validator does. Returns the
 * list of problems (empty = clean).
 */
export function svgContentProblems(text: string): string[] {
  const problems: string[] = [];
  if (/<\s*script\b/i.test(text)) problems.push('contains <script>');
  if (/\son\w+\s*=/i.test(text)) problems.push('contains an inline event handler (on…=)');
  if (/<\s*foreignObject\b/i.test(text)) problems.push('contains <foreignObject>');
  if (/javascript:/i.test(text)) problems.push('contains a javascript: URI');
  const refRe = /(?:xlink:href|href|src)\s*=\s*(['"])([^'"]*)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(text)) !== null) {
    const v = m[2].trim();
    if (v && !v.startsWith('#') && !/^data:/i.test(v)) {
      problems.push(`references an external resource (${v.slice(0, 40)})`);
    }
  }
  return problems;
}

/** Windows: forward slashes before `convertFileSrc` (tauri#7970). */
function normalizeAbsPath(fsPath: string): string {
  return /^[a-zA-Z]:[\\/]/.test(fsPath) ? fsPath.replace(/\\/g, '/') : fsPath;
}

/**
 * Rewrite each `url("assets/…")` in the CSS to a webview-loadable `asset:` URL
 * under `assetBaseDir` (the theme's absolute on-disk directory). `data:` URIs and
 * everything else are left untouched, so a theme with no assets is unchanged.
 * Synchronous (`convertFileSrc` is a pure string transform), so this runs inside
 * the pre-paint injection.
 *
 * No cache-busting query is appended: on Windows WebView2 the asset-protocol
 * handler resolves the file path *including* a trailing `?v=…`, so a query turns
 * a valid asset into a 404. This mirrors the cover cache, which also serves disk
 * files via `convertFileSrc` with no query and relies on the asset protocol
 * serving current bytes. The only cost is that an updated asset behind an
 * unchanged filename may show stale in the webview until the next launch; the
 * on-disk file is always current (install rewrites it).
 */
export function rewriteAssetUrls(css: string, assetBaseDir: string): string {
  if (!assetBaseDir) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q: string, target: string) => {
    const t = target.trim();
    if (!isAllowedAssetPath(t)) return whole; // data: and anything else untouched
    const abs = normalizeAbsPath(`${assetBaseDir}/${t}`);
    const src = convertFileSrc(abs);
    if (!src || src === abs) return whole; // not in Tauri / outside asset scope
    return `url("${src}")`;
  });
}
