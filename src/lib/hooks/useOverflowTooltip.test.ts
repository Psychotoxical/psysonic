import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOverflowTooltip, useOverflowTooltipFactory } from '@/lib/hooks/useOverflowTooltip';

/**
 * Stands in for the render: applies the returned attributes the way React would,
 * and states the clipping explicitly because jsdom reports 0 for both metrics.
 */
function makeAnchor(
  attrs: ReturnType<typeof useOverflowTooltip>,
  text: string,
  { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number },
) {
  const el = document.createElement('p');
  el.textContent = text;
  if (attrs['data-tooltip']) el.setAttribute('data-tooltip', attrs['data-tooltip']);
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  document.body.appendChild(el);
  return el;
}

const enter = (
  attrs: ReturnType<typeof useOverflowTooltip>,
  el: HTMLElement,
) => attrs.onMouseEnter?.({ currentTarget: el } as unknown as React.MouseEvent<HTMLElement>);

describe('useOverflowTooltip', () => {
  it('marks the element as an anchor so the delegated listener can find it', () => {
    const { result } = renderHook(() => useOverflowTooltip('Album name'));
    expect(result.current['data-tooltip']).toBe('Album name');
    expect(result.current.onMouseEnter).toBeTypeOf('function');
  });

  it('opts into wrapping, since only over-wide text gets here', () => {
    // Without the marker TooltipPortal renders `nowrap` with no max width, and
    // its horizontal clamp pins `left` at the margin — so a long title would run
    // off the right edge unreachable. See the hook's closing comment.
    expect(renderHook(() => useOverflowTooltip('Album name')).result.current['data-tooltip-wrap']).toBe('');
  });

  it('stays out of the DOM entirely when disabled or textless', () => {
    expect(renderHook(() => useOverflowTooltip('Album name', false)).result.current).toEqual({});
    expect(renderHook(() => useOverflowTooltip('')).result.current).toEqual({});
    expect(renderHook(() => useOverflowTooltip(null)).result.current).toEqual({});
  });

  it('keeps the tooltip when the text is actually clipped', () => {
    const { result } = renderHook(() => useOverflowTooltip('A very long album name'));
    const el = makeAnchor(result.current, 'A very long album name', { scrollWidth: 400, clientWidth: 200 });
    enter(result.current, el);
    expect(el.getAttribute('data-tooltip')).toBe('A very long album name');
  });

  it('removes the tooltip when the text fits', () => {
    const { result } = renderHook(() => useOverflowTooltip('Short'));
    const el = makeAnchor(result.current, 'Short', { scrollWidth: 100, clientWidth: 200 });
    enter(result.current, el);
    expect(el.hasAttribute('data-tooltip')).toBe(false);
  });

  it('treats an exactly-fitting text as not clipped', () => {
    const { result } = renderHook(() => useOverflowTooltip('Exact'));
    const el = makeAnchor(result.current, 'Exact', { scrollWidth: 200, clientWidth: 200 });
    enter(result.current, el);
    expect(el.hasAttribute('data-tooltip')).toBe(false);
  });

  it('shows what is on screen, not the anchor string it was seeded with', () => {
    // Artist credits are joined by a child component, so the parent's label can
    // differ from the rendered text — the tooltip must follow the latter.
    const { result } = renderHook(() => useOverflowTooltip('Artist A'));
    const el = makeAnchor(result.current, 'Artist A feat. Artist B', { scrollWidth: 400, clientWidth: 200 });
    enter(result.current, el);
    expect(el.getAttribute('data-tooltip')).toBe('Artist A feat. Artist B');
  });

  it('is correct whichever order the two mouseover handlers run in', () => {
    const { result } = renderHook(() => useOverflowTooltip('Short'));
    const el = makeAnchor(result.current, 'Short', { scrollWidth: 100, clientWidth: 200 });

    // Ours second: the delegated listener already captured the anchor and armed
    // its timer; by the time it reads the value, the attribute is gone.
    const captured = el.closest('[data-tooltip]');
    expect(captured).toBe(el);
    enter(result.current, el);
    expect(captured?.getAttribute('data-tooltip')).toBeNull();

    // Ours first: nothing left for the delegated listener to latch onto.
    expect(el.closest('[data-tooltip]')).toBeNull();
  });

  it('re-evaluates on every enter, so a resize brings the tooltip back', () => {
    const { result } = renderHook(() => useOverflowTooltip('Album name'));
    const el = makeAnchor(result.current, 'Album name', { scrollWidth: 100, clientWidth: 200 });
    enter(result.current, el);
    expect(el.hasAttribute('data-tooltip')).toBe(false);

    Object.defineProperty(el, 'clientWidth', { value: 50, configurable: true });
    enter(result.current, el);
    expect(el.getAttribute('data-tooltip')).toBe('Album name');
  });
});

describe('useOverflowTooltipFactory', () => {
  it('produces per-row attributes from one shared handler', () => {
    const { result } = renderHook(() => useOverflowTooltipFactory());
    const a = result.current('First album');
    const b = result.current('Second album');
    expect(a['data-tooltip']).toBe('First album');
    expect(b['data-tooltip']).toBe('Second album');
    // Shared on purpose: the handler reads everything off the event target.
    expect(a.onMouseEnter).toBe(b.onMouseEnter);
  });

  it('measures the row it actually fired on', () => {
    const { result } = renderHook(() => useOverflowTooltipFactory());
    const clipped = makeAnchor(result.current('Long'), 'Long', { scrollWidth: 400, clientWidth: 200 });
    const fits = makeAnchor(result.current('Short'), 'Short', { scrollWidth: 100, clientWidth: 200 });

    enter(result.current('Long'), clipped);
    enter(result.current('Short'), fits);

    expect(clipped.getAttribute('data-tooltip')).toBe('Long');
    expect(fits.hasAttribute('data-tooltip')).toBe(false);
  });

  it('yields nothing when disabled or textless', () => {
    const off = renderHook(() => useOverflowTooltipFactory(false)).result.current;
    expect(off('Album name')).toEqual({});
    const on = renderHook(() => useOverflowTooltipFactory()).result.current;
    expect(on('')).toEqual({});
    expect(on(null)).toEqual({});
  });
});
