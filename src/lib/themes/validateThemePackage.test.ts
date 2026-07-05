import { describe, it, expect } from 'vitest';
import { validateThemePackage } from '@/lib/themes/validateThemePackage';

/** A minimal floor-passing theme.css for `id`. */
function css(id = 'my-theme'): string {
  return `[data-theme='${id}'] { color-scheme: dark; --accent: #abcdef; }`;
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
  it('accepts a valid package', () => {
    const r = validateThemePackage(manifest(), css());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.id).toBe('my-theme');
      expect(r.theme.mode).toBe('dark');
      expect(r.theme).not.toHaveProperty('tags');
    }
  });

  it('accepts free-form CSS — foreign selectors and namespaced animations', () => {
    const freeform = `
      [data-theme='my-theme'] { color-scheme: dark; --accent: #abcdef; }
      @keyframes my-theme-pulse { from { opacity: 1 } to { opacity: .5 } }
      .sidebar { animation: my-theme-pulse 2s infinite; }
      [data-theme='my-theme'][data-playing='true'] .player-bar { filter: brightness(1.1); }
    `;
    expect(validateThemePackage(manifest(), freeform).ok).toBe(true);
  });

  it('preserves valid tags', () => {
    const r = validateThemePackage(manifest({ tags: ['dark', 'neon'] }), css());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.theme.tags).toEqual(['dark', 'neon']);
  });

  it('rejects invalid JSON', () => {
    expect(hasError(validateThemePackage('{ not json', css()), /not valid JSON/)).toBe(true);
  });

  it('rejects a non-object manifest', () => {
    expect(hasError(validateThemePackage('"a string"', css()), /must be a JSON object/)).toBe(true);
  });

  it('rejects unknown manifest properties', () => {
    expect(hasError(validateThemePackage(manifest({ evil: true }), css()), /unknown property "evil"/)).toBe(true);
  });

  it('rejects a missing required field', () => {
    expect(hasError(validateThemePackage(manifest({ name: undefined }), css()), /manifest\.name is required/)).toBe(true);
  });

  it('rejects an id that is not lowercase kebab-case', () => {
    const r = validateThemePackage(manifest({ id: 'My_Theme' }), css('My_Theme'));
    expect(hasError(r, /kebab-case/)).toBe(true);
  });

  it('rejects an id that collides with a built-in theme', () => {
    const r = validateThemePackage(manifest({ id: 'mocha' }), css('mocha'));
    expect(hasError(r, /collides with a built-in/)).toBe(true);
  });

  it('rejects CSS that reaches the network via @import', () => {
    const r = validateThemePackage(manifest(), `@import 'https://evil/x.css'; ${css()}`);
    expect(hasError(r, /failed the safety check/)).toBe(true);
  });

  it('rejects CSS with a non-data url() (containment)', () => {
    const r = validateThemePackage(manifest(), `[data-theme='my-theme'] { background: url(https://evil/x.png); }`);
    expect(hasError(r, /failed the safety check/)).toBe(true);
  });

  it('rejects @keyframes not namespaced with the theme id', () => {
    const r = validateThemePackage(manifest(), `@keyframes pulse { from {} to {} } ${css()}`);
    expect(hasError(r, /failed the safety check/)).toBe(true);
  });
});
