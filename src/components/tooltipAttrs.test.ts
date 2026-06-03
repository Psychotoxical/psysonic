import { describe, it, expect } from 'vitest';
import { tooltipAttrs } from './tooltipAttrs';

describe('tooltipAttrs', () => {
  it('pairs data-tooltip with a matching aria-label', () => {
    expect(tooltipAttrs('Play this album')).toEqual({
      'data-tooltip': 'Play this album',
      'aria-label': 'Play this album',
    });
  });

  it('adds the forced position only when requested', () => {
    expect(tooltipAttrs('x', { pos: 'bottom' })['data-tooltip-pos']).toBe('bottom');
    expect('data-tooltip-pos' in tooltipAttrs('x')).toBe(false);
  });

  it('adds the wrap marker only when requested', () => {
    expect('data-tooltip-wrap' in tooltipAttrs('x', { wrap: true })).toBe(true);
    expect('data-tooltip-wrap' in tooltipAttrs('x')).toBe(false);
  });
});
