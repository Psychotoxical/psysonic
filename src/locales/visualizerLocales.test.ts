import { describe, expect, it } from 'vitest';
import { visualizer as bg } from './bg/visualizer';
import { visualizer as de } from './de/visualizer';
import { visualizer as en } from './en/visualizer';
import { visualizer as es } from './es/visualizer';
import { visualizer as fr } from './fr/visualizer';
import { visualizer as hu } from './hu/visualizer';
import { visualizer as itLocale } from './it/visualizer';
import { visualizer as ja } from './ja/visualizer';
import { visualizer as nb } from './nb/visualizer';
import { visualizer as nl } from './nl/visualizer';
import { visualizer as pl } from './pl/visualizer';
import { visualizer as ro } from './ro/visualizer';
import { visualizer as ru } from './ru/visualizer';
import { visualizer as zh } from './zh/visualizer';

function keyShape(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? keyShape(child as Record<string, unknown>, path)
      : [path];
  }).sort();
}

describe('visualizer locale namespace', () => {
  const baseline = keyShape(en);
  const locales = { bg, de, es, fr, hu, it: itLocale, ja, nb, nl, pl, ro, ru, zh };

  it.each(Object.entries(locales))('%s matches the English key shape', (_locale, translation) => {
    expect(keyShape(translation)).toEqual(baseline);
  });
});
