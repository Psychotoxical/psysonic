/**
 * Tests for the runtime theme-CSS trust boundary and <head> injection sync.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateThemeCss,
  injectTheme,
  syncInjectedThemes,
} from './themeInjection';
import type { InstalledTheme } from '../../store/installedThemesStore';

const ATTR = 'data-installed-theme';

function mk(id: string, css: string): InstalledTheme {
  return { id, name: id, author: 'a', version: '1.0.0', description: '', mode: 'dark', css, installedAt: 0 };
}
const block = (id: string, body = '--accent:#fff;') => `[data-theme='${id}']{ ${body} }`;
const injected = () => document.head.querySelectorAll(`style[${ATTR}]`);

afterEach(() => {
  document.head.querySelectorAll(`style[${ATTR}]`).forEach((el) => el.remove());
});

describe('validateThemeCss', () => {
  it('accepts a valid single scoped rule', () => {
    expect(validateThemeCss(block('dracula'), 'dracula')).not.toBeNull();
  });

  it('accepts a data: url on the contract (e.g. --select-arrow)', () => {
    const css = block('x', `--select-arrow: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");`);
    expect(validateThemeCss(css, 'x')).not.toBeNull();
  });

  it('rejects @import', () => {
    expect(validateThemeCss(`@import 'evil.css'; ${block('x')}`, 'x')).toBeNull();
  });

  it('rejects a non-data url()', () => {
    expect(validateThemeCss(block('x', `--accent: url(https://evil.test/x.png);`), 'x')).toBeNull();
  });

  it('rejects </style> breakout', () => {
    expect(validateThemeCss(`${block('x')}</style><script>`, 'x')).toBeNull();
  });

  it('rejects an unscoped/global selector', () => {
    expect(validateThemeCss(':root{ --accent:red; }', 'x')).toBeNull();
    expect(validateThemeCss('*{ color:red; }', 'x')).toBeNull();
  });

  it('rejects a foreign theme id selector', () => {
    expect(validateThemeCss(block('other'), 'dracula')).toBeNull();
  });

  it('rejects more than one rule', () => {
    expect(validateThemeCss(`${block('x')} ${block('x', '--bg-app:#000;')}`, 'x')).toBeNull();
  });

  it('rejects expression() / javascript:', () => {
    expect(validateThemeCss(block('x', '--accent: expression(alert(1));'), 'x')).toBeNull();
    expect(validateThemeCss(block('x', '--accent: javascript:alert(1);'), 'x')).toBeNull();
  });

  it('rejects an oversized css blob', () => {
    const huge = `[data-theme='x']{ ${'--accent:#ffffff;'.repeat(6000)} }`;
    expect(huge.length).toBeGreaterThan(64 * 1024);
    expect(validateThemeCss(huge, 'x')).toBeNull();
  });

  it('ignores comments when validating', () => {
    expect(validateThemeCss(`/* hi */ ${block('x')}`, 'x')).not.toBeNull();
    // comment cannot smuggle a second rule past the single-rule shape
    expect(validateThemeCss(`${block('x')} /* */ ${block('x')}`, 'x')).toBeNull();
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

  it('does not inject invalid css', () => {
    syncInjectedThemes([mk('a', ':root{ --accent:red; }')]);
    expect(injected()).toHaveLength(0);
  });
});
