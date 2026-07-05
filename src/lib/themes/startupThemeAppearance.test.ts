import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SPLASH_PALETTES } from '@/config/startupSplashPalettes';
import {
  applyStartupSplashPalette,
  resolveEffectiveThemeId,
  resolveScheduledThemeId,
  resolveSplashPalette,
} from '@/lib/themes/startupThemeAppearance';

describe('startupThemeAppearance', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('resolves scheduled day/night theme', () => {
    const theme = resolveScheduledThemeId({
      enableThemeScheduler: true,
      theme: 'mocha',
      themeDay: 'latte',
      themeNight: 'stark-hud',
      timeDayStart: '00:00',
      timeNightStart: '12:00',
    });
    expect(['latte', 'stark-hud']).toContain(theme);
  });

  it('reads effective theme from persisted store', () => {
    localStorage.setItem('psysonic_theme', JSON.stringify({
      state: {
        theme: 'vision-dark',
        enableThemeScheduler: false,
      },
    }));
    expect(resolveEffectiveThemeId()).toBe('vision-dark');
  });

  it('parses community theme css into splash palette', () => {
    const palette = resolveSplashPalette('my-theme', [{
      id: 'my-theme',
      css: `[data-theme='my-theme'] { --bg-app: #112233; --accent: #aabbcc; --text-primary: #ddeeff; --text-muted: #99aabb; --bg-card: #223344; }`,
    }]);
    expect(palette).toMatchObject({
      bg: '#112233',
      accent: '#aabbcc',
      text: '#ddeeff',
      muted: '#99aabb',
      track: '#223344',
      logoStart: '#aabbcc',
      logoEnd: '#aabbcc',
    });
  });

  it('applies palette css variables on document root', () => {
    applyStartupSplashPalette('kanagawa-wave', BUILTIN_SPLASH_PALETTES['kanagawa-wave']);
    expect(document.documentElement.getAttribute('data-theme')).toBe('kanagawa-wave');
    expect(document.documentElement.style.getPropertyValue('--startup-splash-bg').trim()).toBe('#1F1F28');
    expect(document.documentElement.style.getPropertyValue('--startup-splash-accent').trim()).toBe('#7E9CD8');
    expect(document.documentElement.style.getPropertyValue('--startup-splash-logo-start').trim()).toBe('#7E9CD8');
    expect(document.documentElement.style.getPropertyValue('--startup-splash-logo-end').trim()).toBe('#957FB8');
  });

  it('reads custom logo gradient from community theme css', () => {
    const palette = resolveSplashPalette('brand', [{
      id: 'brand',
      css: `[data-theme='brand'] { --bg-app: #111; --accent: #f00; --logo-color-start: #0f0; --logo-color-end: #00f; }`,
    }]);
    expect(palette.logoStart).toBe('#0f0');
    expect(palette.logoEnd).toBe('#00f');
  });

  it('keeps public preflight palettes in sync with bundled theme map', () => {
    const preflight = readFileSync(
      resolve(process.cwd(), 'public/startup-splash-preflight.js'),
      'utf8',
    );
    for (const themeId of Object.keys(BUILTIN_SPLASH_PALETTES)) {
      expect(preflight).toContain(`'${themeId}'`);
      expect(preflight).toContain(BUILTIN_SPLASH_PALETTES[themeId].bg);
      expect(preflight).toContain(BUILTIN_SPLASH_PALETTES[themeId].logoStart);
    }
  });
});
