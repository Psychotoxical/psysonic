/**
 * Synchronous startup splash theme (before the Vite bundle loads).
 * Keep palette ids/hex in sync with `src/config/startupSplashPalettes.ts`.
 */
(function startupSplashPreflight() {
  var THEME_KEY = 'psysonic_theme';
  var INSTALLED_KEY = 'psysonic_installed_themes';
  var DEFAULT = {
    bg: '#1e1e2e',
    text: '#cdd6f4',
    muted: '#a6adc8',
    accent: '#cba6f7',
    track: '#313244',
    logoStart: '#cba6f7',
    logoEnd: '#89b4fa',
  };
  var BUILTIN = {
    mocha: DEFAULT,
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

  function readCssVar(css, name) {
    var match = css.match(new RegExp(name + '\\s*:\\s*([^;]+);'));
    var value = match && match[1] ? match[1].trim() : '';
    return value || null;
  }

  function resolveScheduledTheme(state) {
    if (!state.enableThemeScheduler) return state.theme;
    var now = new Date();
    var nowMins = now.getHours() * 60 + now.getMinutes();
    var dayParts = state.timeDayStart.split(':').map(Number);
    var nightParts = state.timeNightStart.split(':').map(Number);
    var dayMins = dayParts[0] * 60 + dayParts[1];
    var nightMins = nightParts[0] * 60 + nightParts[1];
    var isDay = dayMins < nightMins
      ? nowMins >= dayMins && nowMins < nightMins
      : nowMins >= dayMins || nowMins < nightMins;
    return isDay ? state.themeDay : state.themeNight;
  }

  function readThemeState() {
    try {
      var raw = localStorage.getItem(THEME_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var s = parsed && parsed.state;
      if (!s) return null;
      return {
        enableThemeScheduler: !!s.enableThemeScheduler,
        theme: String(s.theme || 'mocha'),
        themeDay: String(s.themeDay || 'latte'),
        themeNight: String(s.themeNight || 'mocha'),
        timeDayStart: String(s.timeDayStart || '07:00'),
        timeNightStart: String(s.timeNightStart || '19:00'),
      };
    } catch (_err) {
      return null;
    }
  }

  function readInstalledThemes() {
    try {
      var raw = localStorage.getItem(INSTALLED_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      var themes = parsed && parsed.state && parsed.state.themes;
      return Array.isArray(themes) ? themes : [];
    } catch (_err) {
      return [];
    }
  }

  function paletteForTheme(themeId, installedThemes) {
    if (BUILTIN[themeId]) return BUILTIN[themeId];
    for (var i = 0; i < installedThemes.length; i += 1) {
      var theme = installedThemes[i];
      if (!theme || theme.id !== themeId || !theme.css) continue;
      var bg = readCssVar(theme.css, '--bg-app');
      var accent = readCssVar(theme.css, '--accent');
      if (!bg || !accent) break;
      var logoStart = readCssVar(theme.css, '--logo-color-start') || accent;
      var logoEnd = readCssVar(theme.css, '--logo-color-end')
        || readCssVar(theme.css, '--accent-2')
        || accent;
      return {
        bg: bg,
        text: readCssVar(theme.css, '--text-primary') || readCssVar(theme.css, '--ctp-text') || DEFAULT.text,
        muted: readCssVar(theme.css, '--text-muted') || readCssVar(theme.css, '--ctp-subtext0') || DEFAULT.muted,
        accent: accent,
        track: readCssVar(theme.css, '--bg-card') || readCssVar(theme.css, '--border-subtle') || DEFAULT.track,
        logoStart: logoStart,
        logoEnd: logoEnd,
      };
    }
    return DEFAULT;
  }

  function applyPalette(themeId, palette) {
    var root = document.documentElement;
    root.setAttribute('data-theme', themeId);
    root.style.setProperty('--startup-splash-bg', palette.bg);
    root.style.setProperty('--startup-splash-text', palette.text);
    root.style.setProperty('--startup-splash-muted', palette.muted);
    root.style.setProperty('--startup-splash-accent', palette.accent);
    root.style.setProperty('--startup-splash-track', palette.track);
    root.style.setProperty('--startup-splash-logo-start', palette.logoStart);
    root.style.setProperty('--startup-splash-logo-end', palette.logoEnd);
    root.style.background = palette.bg;
    if (document.body) document.body.style.background = palette.bg;
  }

  var persisted = readThemeState();
  var themeId = persisted ? resolveScheduledTheme(persisted) : 'mocha';
  var palette = paletteForTheme(themeId, readInstalledThemes());
  applyPalette(themeId, palette);
})();
