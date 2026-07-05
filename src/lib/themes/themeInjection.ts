import type { InstalledTheme } from '@/store/installedThemesStore';

/**
 * Runtime CSS injection for installed community themes. Built-in themes are
 * bundled at build time (`src/styles/themes/index.css`); installed ones have no
 * build-time presence, so their CSS is injected into <head> at runtime. Each
 * installed theme gets one `<style data-installed-theme="<id>">` element, kept
 * in sync with the store.
 */

const ATTR = 'data-installed-theme';
// Generous but bounded — a rich free-form theme (animations, an embedded
// data: font/icon) is still small; this matches the import command's CSS cap
// and keeps one theme from eating the install store's localStorage quota.
const MAX_CSS_BYTES = 256 * 1024;

/**
 * The in-app **security floor** for an installed theme's CSS. Community themes
 * are free-form (any selectors, structure, `@keyframes`, animations — quality
 * is handled by store moderation, and sideloaded themes are installed at the
 * user's own risk). This guard enforces only the hard safety invariants the app
 * relies on, because every installed theme is injected into <head> at all times:
 *
 *  - can't break out of its `<style>` element (`</style>` / `<script>`),
 *  - can't pull anything off the network — no `@import`, and `url()` may only be
 *    an inline `data:` URI (prevents tracking/exfiltration on every app start),
 *  - no `@property` (would register global custom properties that could clash
 *    with the app or other themes),
 *  - no legacy script-in-CSS vectors (`expression()`, `javascript:`,
 *    `-moz-binding`),
 *  - a size cap, and
 *  - `@keyframes` must be namespaced with the theme id (`<id>-…`) so animations
 *    from different installed themes can't collide.
 *
 * Returns the original CSS if it passes, or `null` if it must not be injected.
 */
export function validateThemeCss(css: string, id: string): string | null {
  if (typeof css !== 'string' || !css) return null;
  if (css.length > MAX_CSS_BYTES) return null;
  // Strip comments first so they can't smuggle content past the checks.
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // No element breakout, no remote stylesheet, no global custom-prop registration.
  if (/<\/?\s*(?:style|script)\b/i.test(s)) return null;
  if (/@import\b/i.test(s)) return null;
  if (/@(?:-[a-z]+-)?property\b/i.test(s)) return null;
  // No legacy script-in-CSS vectors.
  if (/expression\s*\(/i.test(s) || /javascript:/i.test(s) || /-moz-binding/i.test(s)) return null;

  // url() may only be an inline data: URI. Match each `url(` and inspect the
  // start of its content — a non-data target never starts with `data:`.
  const urls = s.match(/url\(\s*['"]?\s*[^'")]*/gi) || [];
  for (const u of urls) {
    const inner = u.replace(/^url\(\s*['"]?\s*/i, '');
    if (!/^data:/i.test(inner)) return null;
  }

  // @keyframes (and vendor-prefixed) must start with `<id>-`.
  const prefix = `${id}-`;
  const kf = s.matchAll(/@(?:-[a-z]+-)?keyframes\s+([A-Za-z0-9_-]+)/gi);
  for (const m of kf) {
    if (!m[1].startsWith(prefix)) return null;
  }

  return css;
}

export function injectTheme(theme: InstalledTheme): void {
  const clean = validateThemeCss(theme.css, theme.id);
  if (clean == null) return;
  const selector = `style[${ATTR}="${CSS.escape(theme.id)}"]`;
  let el = document.head.querySelector<HTMLStyleElement>(selector);
  if (!el) {
    el = document.createElement('style');
    el.setAttribute(ATTR, theme.id);
    document.head.appendChild(el);
  }
  if (el.textContent !== clean) el.textContent = clean;
}

export function removeInjectedTheme(id: string): void {
  document.head.querySelector(`style[${ATTR}="${CSS.escape(id)}"]`)?.remove();
}

/**
 * Reconcile the injected <style> elements with the given installed set: drop
 * styles for themes no longer installed, add/update the rest. Idempotent —
 * safe to call on every change and at startup.
 */
export function syncInjectedThemes(themes: InstalledTheme[]): void {
  const wanted = new Set(themes.map((t) => t.id));
  document.head
    .querySelectorAll<HTMLStyleElement>(`style[${ATTR}]`)
    .forEach((el) => {
      const id = el.getAttribute(ATTR);
      if (id && !wanted.has(id)) el.remove();
    });
  for (const theme of themes) injectTheme(theme);
}
