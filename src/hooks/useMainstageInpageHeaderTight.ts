import { useEffect, useState } from 'react';

const TIGHT_AFTER_PX = 10;
const LOOSE_BELOW_PX = 2;

/**
 * Compact the browse toolbar when the in-page overlay viewport scrolls down,
 * same thresholds as Artists (`> 10` tight, `< 2` loose).
 */
export function useMainstageInpageHeaderTight(
  scrollBodyEl: HTMLElement | null,
  resetDeps: ReadonlyArray<unknown>,
): boolean {
  const [tight, setTight] = useState(false);

  useEffect(() => {
    if (!scrollBodyEl) return;
    const el = scrollBodyEl;
    const onScroll = () => {
      const y = el.scrollTop;
      setTight(prev => {
        if (y > TIGHT_AFTER_PX) return true;
        if (y < LOOSE_BELOW_PX) return false;
        return prev;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollBodyEl]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an external subscription/event callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTight(false);
    // Spread values so deps track filter keys, not a new array identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...resetDeps]);

  return tight;
}
