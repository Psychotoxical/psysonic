export type Tab =
  | 'library'
  | 'servers'
  | 'audio'
  | 'lyrics'
  | 'appearance'
  | 'personalisation'
  | 'integrations'
  | 'input'
  | 'storage'
  | 'system'
  | 'users';

// Legacy Tab-IDs die via Route-State oder persisted State noch aufschlagen koennen
// auf die neue Struktur mappen. Gibt es keinen Match, faellt die Settings-Page
// einfach auf 'library' zurueck.
const LEGACY_TAB_ALIAS: Record<string, Tab> = {
  general: 'library',
  server: 'servers',
};

export function resolveTab(input: string | undefined | null): Tab {
  if (!input) return 'servers';
  const aliased = LEGACY_TAB_ALIAS[input];
  if (aliased) return aliased;
  const known: Tab[] = ['library', 'servers', 'audio', 'lyrics', 'appearance', 'personalisation', 'integrations', 'input', 'storage', 'system', 'users'];
  return (known as string[]).includes(input) ? (input as Tab) : 'servers';
}

// Statischer Suchindex ueber alle Sub-Sections aller Tabs. Mitpflegen, wenn eine
// neue SettingsSubSection hinzukommt — sonst taucht sie nicht in der Suche auf.
export type SearchIndexEntry = { tab: Tab; titleKey: string; keywords?: string };

export const SETTINGS_INDEX: SearchIndexEntry[] = [
  { tab: 'audio',          titleKey: 'settings.audioOutputDevice',        keywords: 'output device speakers headphones alsa wasapi coreaudio' },
  { tab: 'audio',          titleKey: 'settings.hiResTitle',               keywords: 'hi-res hires resampling bit depth sample rate dsd 24bit' },
  { tab: 'audio',          titleKey: 'settings.eqTitle',                  keywords: 'equalizer eq bass treble autoeq filter pre-gain' },
  { tab: 'audio',          titleKey: 'settings.playbackTitle',            keywords: 'playback crossfade gapless replaygain replay gain volume' },
  { tab: 'lyrics',         titleKey: 'settings.lyricsSourcesTitle',       keywords: 'lyrics sources providers lrclib netease server youlyplus karaoke standard static' },
  { tab: 'lyrics',         titleKey: 'settings.sidebarLyricsStyle',       keywords: 'lyrics scroll style classic apple music' },
  { tab: 'integrations',   titleKey: 'settings.lfmTitle',                 keywords: 'last.fm lastfm scrobble' },
  { tab: 'integrations',   titleKey: 'settings.discordRichPresence',      keywords: 'discord rich presence rpc' },
  { tab: 'integrations',   titleKey: 'settings.enableBandsintown',        keywords: 'bandsintown concerts tours events' },
  { tab: 'integrations',   titleKey: 'settings.nowPlayingEnabled',        keywords: 'now playing share dropdown presence' },
  { tab: 'personalisation',titleKey: 'settings.sidebarTitle',             keywords: 'sidebar nav navigation items reorder customize' },
  { tab: 'personalisation',titleKey: 'settings.artistLayoutTitle',        keywords: 'artist page layout sections order' },
  { tab: 'personalisation',titleKey: 'settings.homeCustomizerTitle',      keywords: 'home page customize sections' },
  { tab: 'personalisation',titleKey: 'settings.queueToolbarTitle',        keywords: 'queue toolbar buttons reorder customize shuffle save load' },
  { tab: 'personalisation',titleKey: 'settings.playlistLayoutTitle',     keywords: 'playlist page layout add songs import csv download zip cache offline suggestions controls hide show' },
  { tab: 'personalisation',titleKey: 'settings.playerBarTitle',          keywords: 'player bar playback favorites stars rating lastfm love equalizer mini player controls hide show' },
  { tab: 'appearance',     titleKey: 'settings.libraryGridMaxColumnsTitle', keywords: 'grid columns album artist playlist cards layout appearance performance scroll paint' },
  { tab: 'library',        titleKey: 'settings.randomMixTitle',           keywords: 'random mix blacklist genre keywords filter audiobook' },
  { tab: 'library',        titleKey: 'settings.ratingsSectionTitle',      keywords: 'ratings stars skip threshold manual' },
  { tab: 'storage',        titleKey: 'settings.offlineDirTitle',          keywords: 'offline library download directory folder cache' },
  { tab: 'storage',        titleKey: 'settings.nextTrackBufferingTitle',  keywords: 'next track buffering preload hot cache streaming' },
  { tab: 'storage',        titleKey: 'settings.downloadsTitle',           keywords: 'downloads zip export archive folder' },
  { tab: 'appearance',     titleKey: 'settings.theme',                    keywords: 'theme color palette dark light' },
  { tab: 'appearance',     titleKey: 'settings.themeSchedulerTitle',      keywords: 'theme scheduler auto time dark mode sunset' },
  { tab: 'appearance',     titleKey: 'settings.visualOptionsTitle',       keywords: 'visual options animations effects titlebar mini player' },
  { tab: 'appearance',     titleKey: 'settings.uiScaleTitle',             keywords: 'ui scale zoom dpi size' },
  { tab: 'appearance',     titleKey: 'settings.font',                     keywords: 'font typography typeface' },
  { tab: 'appearance',     titleKey: 'settings.fsPlayerSection',          keywords: 'fullscreen player mesh blob' },
  { tab: 'appearance',     titleKey: 'settings.seekbarStyle',             keywords: 'seekbar progress bar waveform reduced animations performance gpu fps low-end framerate cap' },
  { tab: 'input',          titleKey: 'settings.inputKeybindingsTitle',    keywords: 'keybindings shortcuts hotkeys keyboard' },
  { tab: 'input',          titleKey: 'settings.globalShortcutsTitle',     keywords: 'global shortcuts hotkeys system-wide media keys' },
  { tab: 'system',         titleKey: 'settings.language',                 keywords: 'language locale translation i18n' },
  { tab: 'system',         titleKey: 'settings.behavior',                 keywords: 'behavior tray minimize close start smooth scroll linux' },
  { tab: 'system',         titleKey: 'settings.backupTitle',              keywords: 'backup export import settings restore' },
  { tab: 'system',         titleKey: 'settings.loggingTitle',             keywords: 'log logs diagnostic debug verbose' },
  { tab: 'system',         titleKey: 'settings.aboutTitle',               keywords: 'about version update changelog release notes' },
  { tab: 'system',         titleKey: 'settings.aboutContributorsLabel',   keywords: 'contributors credits maintainers' },
  { tab: 'system',         titleKey: 'licenses.title',                    keywords: 'licenses license open source attribution copyright third party dependencies oss' },
];

// Substring-first, Fuzzy-Fallback (alle Query-Zeichen in Reihenfolge im
// Haystack). Rueckgabe 0 = kein Match. Hoeher = besser.
export function matchScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx >= 0) return 1000 - Math.min(999, idx);
  let hi = 0;
  for (const ch of n) {
    const j = h.indexOf(ch, hi);
    if (j < 0) return 0;
    hi = j + 1;
  }
  return Math.max(1, 100 - Math.min(99, hi - n.length));
}
