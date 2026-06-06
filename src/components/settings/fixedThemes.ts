/**
 * The fixed, bundled core themes — always present, never uninstallable. Every
 * other palette lives in the community Theme Store and is applied by id once
 * installed. `bg`/`card`/`accent` drive the 3-band swatch preview.
 */
export interface FixedTheme {
  id: string;
  label: string;
  bg: string;
  card: string;
  accent: string;
  /** Colour-blind-safe accessibility theme — flagged with a badge in the UI. */
  accessibility?: boolean;
}

export const FIXED_THEMES: FixedTheme[] = [
  { id: 'mocha',         label: 'Catppuccin Mocha', bg: '#1e1e2e', card: '#313244', accent: '#cba6f7' },
  { id: 'latte',         label: 'Catppuccin Latte', bg: '#eff1f5', card: '#ccd0da', accent: '#8839ef' },
  { id: 'kanagawa-wave', label: 'Kanagawa Wave', bg: '#1F1F28', card: '#2A2A37', accent: '#7E9CD8' },
  { id: 'stark-hud',     label: 'Stark HUD',     bg: '#0b0f15', card: '#05070a', accent: '#00f2ff' },
  { id: 'vision-dark',   label: 'Vision Dark',   bg: '#0d0b12', card: '#16131e', accent: '#ffd700', accessibility: true },
  { id: 'vision-navy',   label: 'Vision Navy',   bg: '#0a1628', card: '#112038', accent: '#ffd700', accessibility: true },
];
