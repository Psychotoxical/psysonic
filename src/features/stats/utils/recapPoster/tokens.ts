/**
 * Psysonic Rewind poster design tokens. One deliberate dark identity — the
 * poster is share artwork, so it stays brand-constant regardless of the
 * exporter's app theme; only the album-cover accent may tint it per export.
 */

export const REWIND_COLORS = {
  background: '#090A1A',
  backgroundAlt: '#160C2C',
  card: 'rgba(16, 16, 36, 0.84)',
  primaryPurple: '#A783FF',
  brightPurple: '#C6A7FF',
  mutedPurple: '#8D82B4',
  textPrimary: '#F4F1FF',
  textSecondary: '#AAA2CB',
  border: '#6E50A6',
  gridInactive: '#27213E',
} as const;

/** Families registered by the fontsource packages the app already ships. */
export const REWIND_FONT_DISPLAY = '"Space Grotesk Variable", "Inter Variable", system-ui, sans-serif';
export const REWIND_FONT_TEXT = '"Inter Variable", system-ui, sans-serif';

export const REWIND_CARD_RADIUS = 22;
export const REWIND_CARD_BORDER = 1.5;

export interface RewindTypeScale {
  hero: number;
  heroLabel: number;
  spotlight: number;
  section: number;
  statValue: number;
  statLabel: number;
  listRow: number;
  body: number;
  footer: number;
}

/** §4 of the design doc — the ratio between levels matters, not the px. */
export const REWIND_TYPE: Record<'story' | 'square', RewindTypeScale> = {
  story: {
    hero: 230,
    heroLabel: 64,
    spotlight: 72,
    section: 28,
    statValue: 48,
    statLabel: 24,
    listRow: 30,
    body: 26,
    footer: 20,
  },
  square: {
    hero: 150,
    heroLabel: 52,
    spotlight: 56,
    section: 26,
    statValue: 42,
    statLabel: 22,
    listRow: 28,
    body: 24,
    footer: 20,
  },
};

export const REWIND_DIMENSIONS = {
  story: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
} as const;

/** §10 safe area. */
export const REWIND_SAFE = { x: 64, top: 60, bottom: 60 } as const;
