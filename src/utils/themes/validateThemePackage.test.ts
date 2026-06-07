import { describe, it, expect } from 'vitest';
import { validateThemePackage } from './validateThemePackage';
import tokens from './contract/allowed-tokens.json';

const CORE = Object.keys(tokens.core).filter((k) => !k.startsWith('$'));

interface CssOpts {
  id?: string;
  mode?: 'dark' | 'light';
  omit?: string;
  overrides?: Record<string, string>;
  extraDecl?: string;
  extraRule?: string;
}

/** Build a complete, contract-valid theme.css (all core tokens), with knobs to
 *  break exactly one thing per test. */
function buildCss(o: CssOpts = {}): string {
  const { id = 'my-theme', mode = 'dark', omit, overrides = {}, extraDecl, extraRule } = o;
  const decls = CORE.filter((tok) => tok !== omit).map((tok) => {
    if (overrides[tok] !== undefined) return `${tok}: ${overrides[tok]}`;
    if (tok === '--select-arrow') {
      return `${tok}: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>")`;
    }
    return `${tok}: #abcdef`;
  });
  if (extraDecl) decls.push(extraDecl);
  const rule = `[data-theme='${id}'] {\n  color-scheme: ${mode};\n  ${decls.join(';\n  ')};\n}`;
  return extraRule ? `${rule}\n${extraRule}` : rule;
}

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'my-theme',
    name: 'My Theme',
    author: 'tester',
    version: '1.0.0',
    description: 'A nice theme',
    mode: 'dark',
    ...over,
  });
}

const hasError = (r: ReturnType<typeof validateThemePackage>, re: RegExp): boolean =>
  !r.ok && r.errors.some((e) => re.test(e));

describe('validateThemePackage', () => {
  it('accepts a fully contract-valid package', () => {
    const r = validateThemePackage(manifest(), buildCss());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.id).toBe('my-theme');
      expect(r.theme.mode).toBe('dark');
      expect(r.theme).not.toHaveProperty('tags');
    }
  });

  it('preserves valid tags', () => {
    const r = validateThemePackage(manifest({ tags: ['dark', 'neon'] }), buildCss());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.theme.tags).toEqual(['dark', 'neon']);
  });

  it('rejects invalid JSON', () => {
    const r = validateThemePackage('{ not json', buildCss());
    expect(hasError(r, /not valid JSON/)).toBe(true);
  });

  it('rejects a non-object manifest', () => {
    const r = validateThemePackage('"a string"', buildCss());
    expect(hasError(r, /must be a JSON object/)).toBe(true);
  });

  it('rejects unknown manifest properties', () => {
    const r = validateThemePackage(manifest({ evil: true }), buildCss());
    expect(hasError(r, /unknown property "evil"/)).toBe(true);
  });

  it('rejects a missing required field', () => {
    const r = validateThemePackage(manifest({ name: undefined }), buildCss());
    expect(hasError(r, /manifest\.name is required/)).toBe(true);
  });

  it('rejects an id that is not lowercase kebab-case', () => {
    const r = validateThemePackage(manifest({ id: 'My_Theme' }), buildCss({ id: 'My_Theme' }));
    expect(hasError(r, /kebab-case/)).toBe(true);
  });

  it('rejects an id that collides with a built-in theme', () => {
    const r = validateThemePackage(manifest({ id: 'mocha' }), buildCss({ id: 'mocha' }));
    expect(hasError(r, /collides with a built-in/)).toBe(true);
  });

  it('rejects a missing required core token', () => {
    const r = validateThemePackage(manifest(), buildCss({ omit: '--accent' }));
    expect(hasError(r, /missing required core token --accent/)).toBe(true);
  });

  it('rejects a token that is not in the whitelist', () => {
    const r = validateThemePackage(manifest(), buildCss({ extraDecl: '--not-a-real-token: #fff' }));
    expect(hasError(r, /--not-a-real-token is not in the contract whitelist/)).toBe(true);
  });

  it('rejects color-scheme not matching manifest.mode', () => {
    const r = validateThemePackage(manifest({ mode: 'light' }), buildCss({ mode: 'dark' }));
    expect(hasError(r, /must match/)).toBe(true);
  });

  it('rejects a data-URI on a token other than --select-arrow', () => {
    const r = validateThemePackage(
      manifest(),
      buildCss({ overrides: { '--accent': 'url("data:image/png;base64,AAAA")' } }),
    );
    expect(hasError(r, /data-URI values are only allowed on --select-arrow/)).toBe(true);
  });

  it('rejects an external url() value (containment)', () => {
    const r = validateThemePackage(
      manifest(),
      buildCss({ overrides: { '--bg-app': 'url(https://evil.example/x.png)' } }),
    );
    // validateThemeCss flags this structurally (only data: URIs are allowed).
    expect(hasError(r, /one safe \[data-theme/)).toBe(true);
  });

  it('rejects more than one rule (structural)', () => {
    const r = validateThemePackage(manifest(), buildCss({ extraRule: "[data-theme='other'] { --accent: #000 }" }));
    expect(hasError(r, /one safe \[data-theme/)).toBe(true);
  });
});
