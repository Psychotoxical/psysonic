import type { InstalledTheme } from '../../store/installedThemesStore';

/**
 * Runtime CSS injection for installed community themes. Built-in themes are
 * bundled at build time (`src/styles/themes/index.css`); installed ones have no
 * build-time presence, so their `[data-theme='<id>']` block must be injected
 * into <head> at runtime. Each installed theme gets one
 * `<style data-installed-theme="<id>">` element, kept in sync with the store.
 */

const ATTR = 'data-installed-theme';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate one installed theme's CSS against the runtime trust boundary. The
 * repo CI is the authoritative contract check (token whitelist, thumbnail, …);
 * this is the in-app guard for the structural invariants the app *relies on* to
 * keep a theme contained — important because every installed theme is injected
 * into <head> at all times and scoping depends entirely on the selector.
 *
 * A valid theme CSS is **exactly one rule**, scoped **exactly** to this theme's
 * `[data-theme='<id>']` selector, with:
 *  - no `<style>`/`</style>` (can't break out of the element),
 *  - no `@import` / at-rules (the single-rule shape rejects these),
 *  - no unscoped/global (`:root`, `html`, `*`) or *foreign* (another id's)
 *    selector — so it can never style anything but its own theme,
 *  - `url()` only as `data:` (the inline `--select-arrow` SVG), and
 *  - no `expression()` / `javascript:`.
 *
 * Returns the original CSS if valid, or `null` if it must not be injected.
 */
export function validateThemeCss(css: string, id: string): string | null {
  if (typeof css !== 'string' || !css) return null;
  // Bound the per-theme localStorage footprint. A real token-only theme is a
  // few KB; this generous cap rejects a pathological/huge file before it can
  // eat the install store's quota.
  if (css.length > 64 * 1024) return null;
  // Strip comments first so they can't smuggle content past the checks.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (/<\/?\s*style/i.test(stripped)) return null;
  if (/@import/i.test(stripped)) return null;
  // Exactly one rule, scoped to exactly this theme's selector. The single
  // braces-pair shape also rejects at-rules (`@media{…}`), extra rules, and
  // unscoped/foreign selectors.
  const selector = `\\[data-theme=(['"])${escapeRegExp(id)}\\1\\]`;
  const match = stripped.match(new RegExp(`^${selector}\\s*\\{([^{}]*)\\}$`));
  if (!match) return null;
  const body = match[2]; // group 1 is the selector quote; group 2 is the declarations
  if (/expression\s*\(/i.test(body) || /javascript:/i.test(body)) return null;
  const urls = body.match(/url\(\s*['"]?[^'")]*/gi) || [];
  for (const u of urls) {
    const inner = u.replace(/^url\(\s*['"]?/i, '');
    if (!/^data:/i.test(inner)) return null;
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
