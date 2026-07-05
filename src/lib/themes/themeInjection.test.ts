/**
 * Tests for the runtime theme-CSS security floor and <head> injection sync.
 * Community themes are free-form; the floor only blocks the hard safety
 * invariants (network, scripts, breakout, unscoped @keyframes, size).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateThemeCss,
  injectTheme,
  syncInjectedThemes,
} from '@/lib/themes/themeInjection';
import type { InstalledTheme } from '@/store/installedThemesStore';

const ATTR = 'data-installed-theme';

function mk(id: string, css: string): InstalledTheme {
  return { id, name: id, author: 'a', version: '1.0.0', description: '', mode: 'dark', css, installedAt: 0 };
}
const block = (id: string, body = '--accent:#fff;') => `[data-theme='${id}']{ ${body} }`;
const injected = () => document.head.querySelectorAll(`style[${ATTR}]`);

afterEach(() => {
  document.head.querySelectorAll(`style[${ATTR}]`).forEach((el) => el.remove());
});

describe('validateThemeCss (security floor)', () => {
  it('accepts a simple scoped rule', () => {
    expect(validateThemeCss(block('dracula'), 'dracula')).not.toBeNull();
  });

  it('accepts free-form selectors and structure', () => {
    const css = `html { color: red; } .sidebar { background: #000; } [data-theme='x'] .player-bar { opacity: 0.9; }`;
    expect(validateThemeCss(css, 'x')).not.toBeNull();
  });

  it('accepts @media and multiple rules', () => {
    const css = `${block('x')} @media (min-width: 600px) { .sidebar { width: 200px; } }`;
    expect(validateThemeCss(css, 'x')).not.toBeNull();
  });

  it('accepts @keyframes namespaced with the theme id, and its animation use', () => {
    const css = `@keyframes x-pulse { from { opacity: 1 } to { opacity: 0.5 } } .sidebar { animation: x-pulse 2s infinite; }`;
    expect(validateThemeCss(css, 'x')).not.toBeNull();
  });

  it('accepts a data: url()', () => {
    const css = block('x', `--select-arrow: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");`);
    expect(validateThemeCss(css, 'x')).not.toBeNull();
  });

  it('rejects @keyframes not namespaced with the theme id', () => {
    expect(validateThemeCss(`@keyframes pulse { from {} to {} } ${block('x')}`, 'x')).toBeNull();
  });

  it('rejects @import', () => {
    expect(validateThemeCss(`@import 'evil.css'; ${block('x')}`, 'x')).toBeNull();
  });

  it('rejects @property (global custom-prop registration)', () => {
    const css = `@property --x { syntax: '<color>'; inherits: false; initial-value: red; } ${block('x')}`;
    expect(validateThemeCss(css, 'x')).toBeNull();
  });

  it('rejects a non-data url()', () => {
    expect(validateThemeCss(block('x', `--accent: url(https://evil.test/x.png);`), 'x')).toBeNull();
  });

  it('rejects </style> / <script> breakout', () => {
    expect(validateThemeCss(`${block('x')}</style><script>`, 'x')).toBeNull();
  });

  it('rejects expression() / javascript:', () => {
    expect(validateThemeCss(block('x', '--accent: expression(alert(1));'), 'x')).toBeNull();
    expect(validateThemeCss(block('x', '--accent: javascript:alert(1);'), 'x')).toBeNull();
  });

  it('rejects an oversized css blob', () => {
    const huge = `[data-theme='x']{ ${'--accent:#ffffff;'.repeat(20000)} }`;
    expect(huge.length).toBeGreaterThan(256 * 1024);
    expect(validateThemeCss(huge, 'x')).toBeNull();
  });

  it('ignores comments when validating', () => {
    expect(validateThemeCss(`/* hi */ ${block('x')}`, 'x')).not.toBeNull();
    // A comment cannot smuggle an @import past the floor.
    expect(validateThemeCss(`${block('x')} /* */ @import 'x';`, 'x')).toBeNull();
  });
});

describe('syncInjectedThemes', () => {
  it('injects one <style> per installed theme', () => {
    syncInjectedThemes([mk('a', block('a')), mk('b', block('b'))]);
    expect(injected()).toHaveLength(2);
    expect(document.head.querySelector(`style[${ATTR}="a"]`)?.textContent).toContain('data-theme');
  });

  it('removes styles for themes no longer installed', () => {
    syncInjectedThemes([mk('a', block('a')), mk('b', block('b'))]);
    syncInjectedThemes([mk('a', block('a'))]);
    expect(injected()).toHaveLength(1);
    expect(document.head.querySelector(`style[${ATTR}="b"]`)).toBeNull();
  });

  it('is idempotent (no duplicate elements)', () => {
    syncInjectedThemes([mk('a', block('a'))]);
    syncInjectedThemes([mk('a', block('a'))]);
    expect(injected()).toHaveLength(1);
  });

  it('updates textContent when the css changes', () => {
    injectTheme(mk('a', block('a', '--accent:#111;')));
    injectTheme(mk('a', block('a', '--accent:#222;')));
    const el = document.head.querySelector(`style[${ATTR}="a"]`);
    expect(injected()).toHaveLength(1);
    expect(el?.textContent).toContain('#222');
  });

  it('does not inject css that fails the floor', () => {
    syncInjectedThemes([mk('a', `@import 'evil.css'; ${block('a')}`)]);
    expect(injected()).toHaveLength(0);
  });
});
