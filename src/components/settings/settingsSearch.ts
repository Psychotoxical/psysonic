import type { TFunction } from 'i18next';
import { GLOBAL_SHORTCUT_ACTIONS, IN_APP_SHORTCUT_ACTIONS } from '../../config/shortcutActions';
import { SETTINGS_INDEX, matchScore, type Tab } from './settingsTabs';

export type SettingsSearchHit = {
  tab: Tab;
  title: string;
  focusTitle: string;
  score: number;
  key: string;
};

export function searchSettings(query: string, activeTab: Tab, t: TFunction): SettingsSearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const hits: SettingsSearchHit[] = [];

  for (const entry of SETTINGS_INDEX) {
    const title = t(entry.titleKey);
    const hay = entry.keywords ? `${title} ${entry.keywords}` : title;
    const score = matchScore(hay, q);
    if (score <= 0) continue;
    const focusTitle = entry.focusTitleKey ? t(entry.focusTitleKey) : title;
    hits.push({ tab: entry.tab, title, focusTitle, score, key: entry.titleKey });
  }

  const inAppSection = t('settings.inputKeybindingsTitle');
  for (const { id, getLabel } of IN_APP_SHORTCUT_ACTIONS) {
    const title = getLabel(t);
    const hay = `${title} ${inAppSection} shortcut hotkey keyboard in-app ${id.replace(/-/g, ' ')}`;
    const score = matchScore(hay, q);
    if (score <= 0) continue;
    hits.push({ tab: 'input', title, focusTitle: inAppSection, score, key: `in-app:${id}` });
  }

  const globalSection = t('settings.globalShortcutsTitle');
  for (const { id, getLabel } of GLOBAL_SHORTCUT_ACTIONS) {
    const title = getLabel(t);
    const hay = `${title} ${globalSection} shortcut hotkey global media ${id.replace(/-/g, ' ')}`;
    const score = matchScore(hay, q);
    if (score <= 0) continue;
    hits.push({ tab: 'input', title, focusTitle: globalSection, score, key: `global:${id}` });
  }

  hits.sort((a, b) => {
    const aCurrent = a.tab === activeTab ? 1 : 0;
    const bCurrent = b.tab === activeTab ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return b.score - a.score;
  });

  return hits;
}
