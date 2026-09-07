import { describe, it, expect } from 'vitest';
import {
  DESKTOP_THEME_ID,
  desktopPaletteCss,
  resolveDesktopPalette,
} from './desktopPalette';
import type { DesktopPalette } from '@/generated/bindings';

/** A palette naming every step it can — the richest shape the mapper sees. */
const full: DesktopPalette = {
  source: '/home/user/.local/state/full/current/theme/colors.toml',
  name: 'Example Theme',
  mode: 'dark',
  colors: {
    accent: '#4c6ef5',
    selection: '#22222a',
    muted: '#6b6b76',
    background: '#101014',
    dark_background: '#0c0c0f',
    darker_background: '#08080a',
    lighter_background: '#22222a',
    foreground: '#e6e6ec',
    dark_foreground: '#a9a9b4',
    red: '#e05252',
    yellow: '#e0b252',
    green: '#52c07a',
    cyan: '#3fb5c4',
    blue: '#4c6ef5',
    magenta: '#b45ec9',
  },
};

/** The floor a generic hook (pywal, matugen, a hand-written file) might emit. */
const minimal: DesktopPalette = {
  source: '/tmp/palette.toml',
  name: null,
  mode: null,
  colors: { background: '#18181c', foreground: '#e8e8ef', accent: '#7aa2f7' },
};

describe('resolveDesktopPalette', () => {
  it('maps a full palette onto the theme tokens without inventing values', () => {
    const { ctp, dark } = resolveDesktopPalette(full);

    expect(dark).toBe(true);
    expect(ctp.base).toBe('#101014');
    expect(ctp.mantle).toBe('#0c0c0f');
    expect(ctp.crust).toBe('#08080a');
    expect(ctp.surface0).toBe('#22222a');
    expect(ctp.text).toBe('#e6e6ec');
    expect(ctp.subtext1).toBe('#a9a9b4');
    expect(ctp.subtext0).toBe('#6b6b76');
    expect(ctp.mauve).toBe('#4c6ef5');
    expect(ctp.red).toBe('#e05252');
    expect(ctp.teal).toBe('#3fb5c4');
  });

  it('derives every token from three colours when that is all the palette has', () => {
    const { ctp } = resolveDesktopPalette(minimal);

    for (const [name, value] of Object.entries(ctp)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Surfaces step away from the background, text tones toward it.
    expect(ctp.base).toBe('#18181c');
    expect(ctp.crust < ctp.base).toBe(true);
    expect(ctp.surface0 > ctp.base).toBe(true);
    expect(ctp.surface2 > ctp.surface1).toBe(true);
    expect(ctp.surface1 > ctp.surface0).toBe(true);
    // Unnamed hues resolve to the accent rather than to nothing.
    expect(ctp.green).toBe('#7aa2f7');
  });

  it("trusts the palette's declared mode over the background's luminance", () => {
    // A light `mode` on a dark background is contradictory, but the file said so.
    expect(resolveDesktopPalette({ ...full, mode: 'light' }).dark).toBe(false);
    // With no declared mode, the background decides.
    expect(resolveDesktopPalette({ ...full, mode: null }).dark).toBe(true);
    expect(
      resolveDesktopPalette({ ...minimal, colors: { ...minimal.colors, background: '#fdfdfd' } })
        .dark,
    ).toBe(false);
  });

  it('keeps text on the accent readable in both directions', () => {
    const onPale = resolveDesktopPalette({
      ...minimal,
      colors: { ...minimal.colors, accent: '#f9e2af' },
    });
    const onDeep = resolveDesktopPalette({
      ...minimal,
      colors: { ...minimal.colors, accent: '#1e3a8a' },
    });

    expect(onPale.textOnAccent).toBe('#11111b');
    expect(onDeep.textOnAccent).not.toBe('#11111b');
  });

  it('falls back to a usable dark theme when the palette names nothing it knows', () => {
    const { ctp, dark } = resolveDesktopPalette({
      source: '/tmp/x.toml',
      name: null,
      mode: null,
      colors: { some_unknown_key: '#123456' },
    });

    expect(dark).toBe(true);
    expect(ctp.base).toMatch(/^#[0-9a-f]{6}$/);
    expect(ctp.text).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('accepts shorthand hex', () => {
    const { ctp } = resolveDesktopPalette({
      ...minimal,
      colors: { ...minimal.colors, background: '#abc' },
    });

    expect(ctp.base).toBe('#aabbcc');
  });
});

describe('desktopPaletteCss', () => {
  it('emits a single block for the desktop theme id', () => {
    const css = desktopPaletteCss(full);

    expect(css.startsWith(`[data-theme='${DESKTOP_THEME_ID}'] {`)).toBe(true);
    expect(css.match(/\[data-theme=/g)).toHaveLength(1);
    expect(css).toContain('color-scheme: dark;');
    expect(css).toContain('--ctp-base: #101014;');
    expect(css).toContain('--bg-app: var(--ctp-base);');
  });

  it('defines every token the built-in themes define', () => {
    const css = desktopPaletteCss(full);
    const required = [
      'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach', 'yellow',
      'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender', 'text', 'subtext1',
      'subtext0', 'overlay2', 'overlay1', 'overlay0', 'surface2', 'surface1',
      'surface0', 'base', 'mantle', 'crust',
    ].map(n => `--ctp-${n}:`);
    const semantic = [
      '--bg-app:', '--bg-sidebar:', '--bg-card:', '--bg-hover:', '--bg-player:',
      '--bg-glass:', '--accent:', '--accent-dim:', '--accent-glow:', '--text-primary:',
      '--text-secondary:', '--text-muted:', '--border:', '--border-subtle:',
      '--positive:', '--warning:', '--danger:', '--highlight:', '--accent-2:',
      '--bg-deep:', '--bg-elevated:', '--text-on-accent:', '--player-title:',
      '--player-artist:', '--select-arrow:',
    ];

    for (const token of [...required, ...semantic]) expect(css, token).toContain(token);
  });

  it('passes the injection validator that gates every runtime-injected theme', async () => {
    const { validateThemeCss } = await import('./themeInjection');

    expect(validateThemeCss(desktopPaletteCss(full), DESKTOP_THEME_ID)).not.toBeNull();
  });

  it('cannot be steered into arbitrary CSS by the palette file', () => {
    // The Rust reader only forwards hex colours, but the CSS builder must not
    // depend on that: a value that slipped through is parsed, not interpolated.
    const css = desktopPaletteCss({
      ...minimal,
      colors: { ...minimal.colors, accent: 'red; } :root { display: none; } x{y:z' },
    });

    expect(css).not.toContain('display: none');
    expect(css.match(/\{/g)).toHaveLength(1);
  });
});
