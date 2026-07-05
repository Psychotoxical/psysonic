// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { resolveIntersectionScrollRoot } from '@/lib/dom/resolveIntersectionScrollRoot';

describe('resolveIntersectionScrollRoot', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('prefers a horizontal scroll ancestor (mainstage album rails)', () => {
    const rail = document.createElement('div');
    const img = document.createElement('img');
    Object.defineProperty(rail, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(rail, 'clientWidth', { value: 800, configurable: true });
    rail.style.overflowX = 'auto';
    rail.appendChild(img);
    document.body.appendChild(rail);

    expect(resolveIntersectionScrollRoot(img)).toBe(rail);
  });

  it('prefers the nearest scrolling ancestor', () => {
    const outer = document.createElement('div');
    const scroller = document.createElement('div');
    const img = document.createElement('img');
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    scroller.style.overflowY = 'auto';
    outer.appendChild(scroller);
    scroller.appendChild(img);
    document.body.appendChild(outer);

    expect(resolveIntersectionScrollRoot(img)).toBe(scroller);
  });

  it('falls back to mainstage in-page viewport class', () => {
    const inpage = document.createElement('div');
    inpage.className = 'mainstage-inpage-scroll__viewport';
    const img = document.createElement('img');
    inpage.appendChild(img);
    document.body.appendChild(inpage);

    expect(resolveIntersectionScrollRoot(img)).toBe(inpage);
  });

  it('falls back to app main scroll viewport id', () => {
    const main = document.createElement('div');
    main.id = APP_MAIN_SCROLL_VIEWPORT_ID;
    const img = document.createElement('img');
    main.appendChild(img);
    document.body.appendChild(main);

    expect(resolveIntersectionScrollRoot(img)).toBe(main);
  });
});
