import {
  BUILTIN_SPLASH_PALETTES,
  BUILTIN_THEME_IDS,
  type StartupSplashPalette,
} from '@/config/startupSplashPalettes';

export type PersistedThemeState = {
  enableThemeScheduler: boolean;
  theme: string;
  themeDay: string;
  themeNight: string;
  timeDayStart: string;
  timeNightStart: string;
};

export type InstalledThemeSnapshot = {
  id: string;
  css: string;
};

const THEME_STORAGE_KEY = 'psysonic_theme';
const INSTALLED_THEMES_STORAGE_KEY = 'psysonic_installed_themes';

export function resolveScheduledThemeId(state: PersistedThemeState): string {
  if (!state.enableThemeScheduler) return state.theme;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [dh, dm] = state.timeDayStart.split(':').map(Number);
  const [nh, nm] = state.timeNightStart.split(':').map(Number);
  const dayMins = dh * 60 + dm;
  const nightMins = nh * 60 + nm;
  const isDay = dayMins < nightMins
    ? nowMins >= dayMins && nowMins < nightMins
    : nowMins >= dayMins || nowMins < nightMins;
  return isDay ? state.themeDay : state.themeNight;
}

export function readPersistedThemeState(): PersistedThemeState | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const s = parsed.state;
    if (!s) return null;
    return {
      enableThemeScheduler: !!s.enableThemeScheduler,
      theme: String(s.theme ?? 'mocha'),
      themeDay: String(s.themeDay ?? 'latte'),
      themeNight: String(s.themeNight ?? 'mocha'),
      timeDayStart: String(s.timeDayStart ?? '07:00'),
      timeNightStart: String(s.timeNightStart ?? '19:00'),
    };
  } catch {
    return null;
  }
}

export function readInstalledThemesFromStorage(): InstalledThemeSnapshot[] {
  try {
    const raw = localStorage.getItem(INSTALLED_THEMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { themes?: InstalledThemeSnapshot[] } };
    const themes = parsed.state?.themes;
    return Array.isArray(themes) ? themes : [];
  } catch {
    return [];
  }
}

export function resolveEffectiveThemeId(): string {
  const persisted = readPersistedThemeState();
  if (!persisted) return 'mocha';
  return resolveScheduledThemeId(persisted);
}

function readCssVar(css: string, name: string): string | null {
  const match = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function resolveLogoColors(
  css: string,
  accent: string,
): Pick<StartupSplashPalette, 'logoStart' | 'logoEnd'> {
  const logoStart = readCssVar(css, '--logo-color-start') ?? accent;
  const logoEnd = readCssVar(css, '--logo-color-end')
    ?? readCssVar(css, '--accent-2')
    ?? accent;
  return { logoStart, logoEnd };
}

function paletteFromCommunityCss(css: string, fallbackTrack: string): StartupSplashPalette | null {
  const bg = readCssVar(css, '--bg-app');
  const accent = readCssVar(css, '--accent');
  if (!bg || !accent) return null;
  const text = readCssVar(css, '--text-primary') ?? readCssVar(css, '--ctp-text') ?? '#cdd6f4';
  const muted = readCssVar(css, '--text-muted') ?? readCssVar(css, '--ctp-subtext0') ?? text;
  const track = readCssVar(css, '--bg-card') ?? readCssVar(css, '--border-subtle') ?? fallbackTrack;
  return { bg, text, muted, accent, track, ...resolveLogoColors(css, accent) };
}

export function resolveSplashPalette(
  themeId: string,
  installedThemes: InstalledThemeSnapshot[] = readInstalledThemesFromStorage(),
): StartupSplashPalette {
  const builtin = BUILTIN_SPLASH_PALETTES[themeId];
  if (builtin) return builtin;

  const installed = installedThemes.find(theme => theme.id === themeId);
  if (installed) {
    const fromCss = paletteFromCommunityCss(installed.css, BUILTIN_SPLASH_PALETTES.mocha.track);
    if (fromCss) return fromCss;
  }

  return BUILTIN_SPLASH_PALETTES.mocha;
}

export function applyStartupSplashPalette(
  themeId: string,
  palette: StartupSplashPalette,
): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', themeId);
  root.style.setProperty('--startup-splash-bg', palette.bg);
  root.style.setProperty('--startup-splash-text', palette.text);
  root.style.setProperty('--startup-splash-muted', palette.muted);
  root.style.setProperty('--startup-splash-accent', palette.accent);
  root.style.setProperty('--startup-splash-track', palette.track);
  root.style.setProperty('--startup-splash-logo-start', palette.logoStart);
  root.style.setProperty('--startup-splash-logo-end', palette.logoEnd);
  root.style.background = palette.bg;
  document.body.style.background = palette.bg;
}

export function applyStartupSplashThemeFromStorage(): string {
  const themeId = resolveEffectiveThemeId();
  const palette = resolveSplashPalette(themeId);
  applyStartupSplashPalette(themeId, palette);
  return themeId;
}

export function isBuiltinThemeId(themeId: string): boolean {
  return BUILTIN_THEME_IDS.includes(themeId);
}
