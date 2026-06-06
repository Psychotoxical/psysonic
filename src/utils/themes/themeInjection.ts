import type { InstalledTheme } from '../../store/installedThemesStore';

/**
 * Runtime CSS injection for installed community themes. Built-in themes are
 * bundled at build time (`src/styles/themes/index.css`); installed ones have no
 * build-time presence, so their `[data-theme='<id>']` block must be injected
 * into <head> at runtime. Each installed theme gets one
 * `<style data-installed-theme="<id>">` element, kept in sync with the store.
 */

const ATTR = 'data-installed-theme';

/**
 * Defense-in-depth. The repo CI already guarantees a single `[data-theme]`
 * selector with whitelisted custom properties and no `@import` / external
 * `url()`. We re-check the cheap, security-relevant invariants here in case a
 * theme is ever loaded from a less-trusted source than the validated CDN:
 *  - nothing can break out of the <style> element,
 *  - no `@import`,
 *  - the only `url()` allowed is `data:` (the inline `--select-arrow` SVG).
 * Returns the CSS unchanged if safe, or null if it must not be injected.
 */
export function sanitizeThemeCss(css: string): string | null {
  if (/<\/?\s*style/i.test(css)) return null;
  if (/@import/i.test(css)) return null;
  const urls = css.match(/url\(\s*['"]?[^'")]+/gi) || [];
  for (const u of urls) {
    const inner = u.replace(/^url\(\s*['"]?/i, '');
    if (!/^data:/i.test(inner)) return null;
  }
  return css;
}

export function injectTheme(theme: InstalledTheme): void {
  const clean = sanitizeThemeCss(theme.css);
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
