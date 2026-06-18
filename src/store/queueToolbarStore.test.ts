import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_TOOLBAR_BUTTONS,
  migrateQueueToolbarButtons,
  type QueueToolbarButtonConfig,
} from './queueToolbarStore';

const ids = (b: QueueToolbarButtonConfig[]) => b.map(x => x.id);
const vis = (b: QueueToolbarButtonConfig[], id: string) => b.find(x => x.id === id)?.visible;

describe('migrateQueueToolbarButtons', () => {
  it('passes the current default through unchanged', () => {
    expect(migrateQueueToolbarButtons(DEFAULT_QUEUE_TOOLBAR_BUTTONS)).toEqual(DEFAULT_QUEUE_TOOLBAR_BUTTONS);
  });

  it('collapses legacy save + load into a single playlist button at the earlier position', () => {
    const legacy = [
      { id: 'shuffle', visible: true },
      { id: 'save', visible: true },
      { id: 'load', visible: true },
      { id: 'share', visible: true },
      { id: 'clear', visible: true },
      { id: 'separator', visible: true },
      { id: 'gapless', visible: true },
      { id: 'crossfade', visible: true },
      { id: 'infinite', visible: true },
    ];
    const out = migrateQueueToolbarButtons(legacy);
    expect(ids(out)).toEqual([
      'shuffle', 'playlist', 'share', 'clear', 'separator', 'gapless', 'crossfade', 'autodj', 'infinite',
    ]);
  });

  it('keeps playlist visible if either legacy save or load was visible', () => {
    const out = migrateQueueToolbarButtons([
      { id: 'save', visible: false },
      { id: 'load', visible: true },
    ]);
    expect(vis(out, 'playlist')).toBe(true);

    const hidden = migrateQueueToolbarButtons([
      { id: 'save', visible: false },
      { id: 'load', visible: false },
    ]);
    expect(vis(hidden, 'playlist')).toBe(false);
  });

  it('inserts autodj right after crossfade and inherits its visibility', () => {
    const out = migrateQueueToolbarButtons([
      { id: 'crossfade', visible: false },
      { id: 'infinite', visible: true },
    ]);
    const i = ids(out);
    expect(i.indexOf('autodj')).toBe(i.indexOf('crossfade') + 1);
    expect(vis(out, 'autodj')).toBe(false);
  });

  it('preserves a customised order', () => {
    const out = migrateQueueToolbarButtons([
      { id: 'crossfade', visible: true },
      { id: 'shuffle', visible: true },
      { id: 'playlist', visible: true },
    ]);
    // autodj follows crossfade, leading items keep their order, missing defaults appended.
    expect(ids(out).slice(0, 4)).toEqual(['crossfade', 'autodj', 'shuffle', 'playlist']);
    // every default id is present exactly once
    for (const d of DEFAULT_QUEUE_TOOLBAR_BUTTONS) {
      expect(ids(out).filter(x => x === d.id)).toHaveLength(1);
    }
  });

  it('drops corrupt entries and tolerates non-array input', () => {
    const out = migrateQueueToolbarButtons([
      null,
      { id: 'shuffle', visible: true },
      { id: 123, visible: true },
      { id: 'bogus', visible: true },
      { visible: true },
    ]);
    expect(ids(out)).toContain('shuffle');
    expect(ids(out)).not.toContain('bogus');
    // unknown/corrupt gone, defaults filled in
    expect(ids(out).sort()).toEqual(DEFAULT_QUEUE_TOOLBAR_BUTTONS.map(b => b.id).sort());

    expect(migrateQueueToolbarButtons(undefined)).toEqual(DEFAULT_QUEUE_TOOLBAR_BUTTONS);
  });
});
