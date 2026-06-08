/** Splash colors aligned with bundled theme semantic tokens (`--bg-app`, etc.). */
export type StartupSplashPalette = {
  bg: string;
  text: string;
  muted: string;
  accent: string;
  track: string;
  /** Sidebar logo gradient start (`--logo-color-start` / `--accent`). */
  logoStart: string;
  /** Sidebar logo gradient end (`--logo-color-end` / `--accent-2`). */
  logoEnd: string;
};

export const BUILTIN_SPLASH_PALETTES: Record<string, StartupSplashPalette> = {
  mocha: {
    bg: '#1e1e2e',
    text: '#cdd6f4',
    muted: '#a6adc8',
    accent: '#cba6f7',
    track: '#313244',
    logoStart: '#cba6f7',
    logoEnd: '#89b4fa',
  },
  latte: {
    bg: '#eff1f5',
    text: '#4c4f69',
    muted: '#6c6f85',
    accent: '#8839ef',
    track: '#ccd0da',
    logoStart: '#8839ef',
    logoEnd: '#1e66f5',
  },
  'kanagawa-wave': {
    bg: '#1F1F28',
    text: '#DCD7BA',
    muted: '#727169',
    accent: '#7E9CD8',
    track: '#2A2A37',
    logoStart: '#7E9CD8',
    logoEnd: '#957FB8',
  },
  'stark-hud': {
    bg: '#0b0f15',
    text: '#e0f7fa',
    muted: '#7da5aa',
    accent: '#00f2ff',
    track: '#141b24',
    logoStart: '#00f2ff',
    logoEnd: '#7df9ff',
  },
  'vision-dark': {
    bg: '#0d0b12',
    text: '#f2eef8',
    muted: '#a6a2b8',
    accent: '#ffd700',
    track: '#16131e',
    logoStart: '#ffd700',
    logoEnd: '#a07af8',
  },
  'vision-navy': {
    bg: '#0a1628',
    text: '#e8eef8',
    muted: '#9caac2',
    accent: '#ffd700',
    track: '#12213a',
    logoStart: '#ffd700',
    logoEnd: '#a07af8',
  },
};

export const BUILTIN_THEME_IDS = Object.keys(BUILTIN_SPLASH_PALETTES);
