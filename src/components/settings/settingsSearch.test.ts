import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { matchScore } from './settingsTabs';
import { searchSettings } from './settingsSearch';

const t = vi.fn((key: string) => {
  const labels: Record<string, string> = {
    'settings.audiomuseTitle': 'AudioMuse-AI (Navidrome)',
    'settings.servers': 'Servers',
    'settings.inputKeybindingsTitle': 'In-app shortcuts',
    'settings.globalShortcutsTitle': 'Global shortcuts',
    'settings.shortcutVolumeUp': 'Volume up',
    'settings.shortcutVolumeDown': 'Volume down',
    'settings.playbackTitle': 'Playback',
  };
  return labels[key] ?? key;
});

describe('matchScore', () => {
  it('prefers earlier substring matches', () => {
    expect(matchScore('volume up global shortcuts', 'volume')).toBeGreaterThan(0);
  });

  it('rejects repeated-character junk queries via fuzzy matching', () => {
    expect(matchScore('database backup analytics strategy', 'aaaaaaa')).toBe(0);
  });

  it('still fuzzy-matches compact typos', () => {
    expect(matchScore('equalizer eq bass treble', 'equl')).toBeGreaterThan(0);
  });
});

describe('searchSettings', () => {
  it('finds AudioMuse by product name', () => {
    const hits = searchSettings('AudioMuse', 'library', t as unknown as TFunction);
    expect(hits.some(h => h.title.includes('AudioMuse'))).toBe(true);
  });

  it('finds global volume shortcuts', () => {
    const hits = searchSettings('Volume', 'library', t as unknown as TFunction);
    expect(hits.some(h => h.title === 'Volume up')).toBe(true);
    expect(hits.some(h => h.title === 'Volume down')).toBe(true);
  });

  it('returns nothing for nonsense queries', () => {
    expect(searchSettings('aaaaaaa', 'library', t as unknown as TFunction)).toEqual([]);
  });
});
