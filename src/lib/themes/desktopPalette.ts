import type { DesktopPalette } from '@/generated/bindings';

/**
 * Turns the palette the user's desktop publishes into a Psysonic theme, so a
 * desktop theme switch re-themes the app instead of leaving the two out of sync.
 *
 * The Rust side (`src-tauri/src/desktop_palette.rs`) reads the file and hands
 * over a `name → #rrggbb` map with no interpretation. Everything below is the
 * interpretation: which of those names drive which theme tokens, and how to
 * derive the tokens a sparse palette doesn't name.
 *
 * The vocabulary understood here is the one Omarchy's `colors.toml` uses, which
 * pywal/matugen/base16 hooks can also emit. A palette that names only
 * `background`, `foreground` and `accent` still produces a complete, usable
 * theme — every other token is derived from those three.
 */

/** Payload of `read_desktop_palette` and the `desktop-palette:changed` event —
 *  the generated contract type, re-exported so theme code has one import. */
export type { DesktopPalette };

/** Theme id this installs under — matches the `[data-theme='…']` selector below. */
export const DESKTOP_THEME_ID = 'desktop';

type Rgb = [number, number, number];

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → rgb triple. Alpha is dropped:
 *  these are opaque surface colours, and the app supplies its own alphas. */
function parseHex(hex: string): Rgb | null {
  const raw = hex.trim().replace(/^#/, '');
  const full = raw.length <= 4 ? raw.replace(/./g, c => c + c) : raw;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(n => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` of `b` mixed into `a`, linearly in sRGB. Good enough for deriving
 *  neighbouring surface tones; nobody is judging gamma on a hover background. */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * amount) as Rgb;
}

/** Perceived luminance, 0–1 — used to decide which way "lighter" points and
 *  what text colour survives on top of the accent. */
function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

/**
 * Resolved palette: every token the theme contract needs, with the derivations
 * a sparse palette falls back to. Exported for the tests, which assert the
 * derivation rules rather than the final CSS string.
 */
export function resolveDesktopPalette(palette: DesktopPalette) {
  const hex = (...names: string[]): Rgb | null => {
    for (const name of names) {
      const parsed = palette.colors[name] ? parseHex(palette.colors[name]) : null;
      if (parsed) return parsed;
    }
    return null;
  };

  const bg = hex('background', 'base', 'bg') ?? [30, 30, 46];
  const fg = hex('foreground', 'text', 'fg') ?? [205, 214, 244];
  const accent = hex('accent', 'primary', 'blue') ?? fg;

  // `mode` is authoritative when the palette declares it; otherwise the
  // background decides, which is what every consumer of these files does.
  const dark = palette.mode ? palette.mode !== 'light' : luminance(bg) < 0.5;
  // "Away from the background" — lighter on a dark theme, darker on a light one.
  const lift = dark ? ([255, 255, 255] as Rgb) : ([0, 0, 0] as Rgb);
  const sink = dark ? ([0, 0, 0] as Rgb) : ([255, 255, 255] as Rgb);

  // Surfaces. A palette that names its own steps wins; the rest are the
  // background nudged toward or away from the foreground in even increments.
  const base = bg;
  const mantle = hex('dark_background', 'mantle') ?? mix(bg, sink, 0.3);
  const crust = hex('darker_background', 'crust') ?? mix(bg, sink, 0.5);
  const surface0 = hex('lighter_background', 'selection', 'surface0') ?? mix(bg, lift, 0.08);
  const surface1 = hex('surface1') ?? mix(bg, lift, 0.14);
  const surface2 = hex('surface2') ?? mix(bg, lift, 0.22);

  // Text tones, brightest to dimmest.
  const text = fg;
  const subtext1 = hex('dark_foreground', 'subtext1') ?? mix(fg, bg, 0.2);
  const subtext0 = hex('muted', 'subtext0') ?? mix(fg, bg, 0.35);
  const overlay2 = hex('overlay2') ?? mix(fg, bg, 0.5);
  const overlay1 = hex('overlay1') ?? mix(fg, bg, 0.62);
  const overlay0 = hex('overlay0') ?? mix(fg, bg, 0.72);

  // Named hues. Each falls back to the accent so a three-colour palette still
  // produces a coherent theme rather than holes where a status colour belongs.
  const red = hex('red') ?? accent;
  const green = hex('green') ?? accent;
  const yellow = hex('yellow') ?? accent;
  const blue = hex('blue') ?? accent;
  const teal = hex('cyan', 'teal') ?? accent;
  const magenta = hex('magenta', 'pink') ?? accent;
  const orange = hex('orange', 'peach') ?? red;

  return {
    dark,
    ctp: {
      rosewater: toHex(hex('bright_foreground', 'rosewater') ?? mix(fg, lift, 0.15)),
      flamingo: toHex(hex('light_foreground', 'flamingo') ?? mix(fg, lift, 0.08)),
      pink: toHex(hex('bright_magenta', 'pink') ?? magenta),
      mauve: toHex(accent),
      red: toHex(red),
      maroon: toHex(hex('brown', 'maroon') ?? mix(red, bg, 0.3)),
      peach: toHex(orange),
      yellow: toHex(yellow),
      green: toHex(green),
      teal: toHex(teal),
      sky: toHex(hex('bright_cyan', 'sky') ?? teal),
      sapphire: toHex(hex('bright_blue', 'sapphire') ?? blue),
      blue: toHex(blue),
      // Deliberately not `bright_blue` — that is already sapphire, and the two
      // reading identically flattens every surface that pairs them.
      lavender: toHex(hex('lavender') ?? mix(accent, lift, 0.25)),
      text: toHex(text),
      subtext1: toHex(subtext1),
      subtext0: toHex(subtext0),
      overlay2: toHex(overlay2),
      overlay1: toHex(overlay1),
      overlay0: toHex(overlay0),
      surface2: toHex(surface2),
      surface1: toHex(surface1),
      surface0: toHex(surface0),
      base: toHex(base),
      mantle: toHex(mantle),
      crust: toHex(crust),
    },
    // Alpha-bearing tokens can't be expressed as `var(--ctp-*)` references.
    glass: rgba(base, 0.75),
    accentDim: rgba(accent, 0.15),
    accentGlow: rgba(accent, 0.3),
    // Whatever sits on an accent-filled button has to stay readable, and a
    // light accent (a pale yellow, say) needs dark text rather than the crust.
    textOnAccent: toHex(luminance(accent) > 0.55 ? ([17, 17, 27] as Rgb) : mix(base, sink, 0.4)),
    // The dropdown chevron is a data: SVG, so its stroke is baked in per theme.
    selectArrow: toHex(subtext1),
  };
}

/**
 * The `[data-theme='desktop']` block. Shape follows the built-in themes
 * (`src/styles/themes/catppuccin-mocha-variables.css`): the `--ctp-*` palette,
 * then the semantic tokens on top of it.
 */
export function desktopPaletteCss(palette: DesktopPalette): string {
  const p = resolveDesktopPalette(palette);
  const arrow = encodeURIComponent(p.selectArrow);
  const ctp = Object.entries(p.ctp)
    .map(([name, value]) => `  --ctp-${name}: ${value};`)
    .join('\n');

  return `[data-theme='${DESKTOP_THEME_ID}'] {
  color-scheme: ${p.dark ? 'dark' : 'light'};
  --select-arrow: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22${arrow}%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E");
${ctp}

  /* Semantic tokens */
  --bg-app: var(--ctp-base);
  --bg-sidebar: var(--ctp-mantle);
  --bg-card: var(--ctp-surface0);
  --bg-hover: var(--ctp-surface1);
  --bg-player: var(--ctp-crust);
  --bg-glass: ${p.glass};
  --accent: var(--ctp-mauve);
  --accent-dim: ${p.accentDim};
  --accent-glow: ${p.accentGlow};
  --text-primary: var(--ctp-text);
  --text-secondary: var(--ctp-subtext1);
  --text-muted: var(--ctp-subtext0);
  --border: var(--ctp-surface1);
  --border-subtle: var(--ctp-surface0);
  --positive: var(--ctp-green);
  --warning: var(--ctp-yellow);
  --danger: var(--ctp-red);
  --highlight: var(--ctp-yellow);
  --accent-2: var(--ctp-blue);
  --bg-deep: var(--ctp-crust);
  --bg-elevated: var(--ctp-surface2);
  --text-on-accent: ${p.textOnAccent};
  --player-title: var(--text-primary);
  --player-artist: var(--text-secondary);
}
`;
}

/** `'dark'` or `'light'`, as the theme store spells it. */
export function desktopPaletteMode(palette: DesktopPalette): 'dark' | 'light' {
  return resolveDesktopPalette(palette).dark ? 'dark' : 'light';
}
