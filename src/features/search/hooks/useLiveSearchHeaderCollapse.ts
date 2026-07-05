import { useState, useRef, useEffect, type RefObject } from 'react';

/**
 * Collapses the live-search field into an icon-overlay when the header runs out
 * of horizontal room, with hysteresis and a stickier compact mode for the
 * Live/Orbit header controls (the two must not feed each other and oscillate).
 * Returns the collapsed flag for the field render + overlay state.
 */
export function useLiveSearchHeaderCollapse(rootRef: RefObject<HTMLDivElement | null>): boolean {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const collapsedRef = useRef(false);
  const compactHeaderControlsRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const header = root.closest('.content-header') as HTMLElement | null;
    if (!header) return;
    const spacer = header.querySelector('.spacer') as HTMLElement | null;
    if (!spacer) return;

    const MIN_EXPANDED_WIDTH = 260;
    const SPACER_RESERVE = 24;
    const HYSTERESIS_PX = 20;
    // Live/Orbit compact-mode is intentionally stickier than search collapse,
    // otherwise both systems can feed each other and oscillate.
    const HEADER_CONTROLS_COMPACT_ON_SPACER = 36;
    const HEADER_CONTROLS_COMPACT_OFF_SPACER = 108;
    const SWITCH_COOLDOWN_MS = 180;
    const collapseThreshold = MIN_EXPANDED_WIDTH + SPACER_RESERVE;
    const expandThreshold = collapseThreshold + HYSTERESIS_PX;
    let lastSwitchAt = 0;
    let cooldownTimer: number | null = null;

    const updateCollapsed = () => {
      const searchWidth = root.getBoundingClientRect().width;
      const spacerWidth = spacer.getBoundingClientRect().width;
      const budget = searchWidth + spacerWidth;
      const headerOverflowing = header.scrollWidth - header.clientWidth > 1;
      let nextCollapsed = collapsedRef.current
        ? budget < expandThreshold
        : budget < collapseThreshold;
      // Priority rule: if we are already compacting Live/Orbit labels, search
      // must stay collapsed until compact mode can be released.
      if (compactHeaderControlsRef.current) {
        nextCollapsed = true;
      }
      if (nextCollapsed !== collapsedRef.current) {
        const now = performance.now();
        const remaining = SWITCH_COOLDOWN_MS - (now - lastSwitchAt);
        if (remaining > 0) {
          if (cooldownTimer == null) {
            cooldownTimer = window.setTimeout(() => {
              cooldownTimer = null;
              updateCollapsed();
            }, remaining);
          }
          return;
        }
        lastSwitchAt = now;
        collapsedRef.current = nextCollapsed;
        setIsCollapsed(nextCollapsed);
      }

      const nextCompactControls = nextCollapsed
        ? (
          compactHeaderControlsRef.current
            // Stay compact until we clearly have room and no overflow.
            ? (headerOverflowing || spacerWidth < HEADER_CONTROLS_COMPACT_OFF_SPACER)
            // Enter compact only when both tight spacer and real overflow exist.
            : (headerOverflowing && spacerWidth < HEADER_CONTROLS_COMPACT_ON_SPACER)
        )
        : false;
      if (nextCompactControls !== compactHeaderControlsRef.current) {
        compactHeaderControlsRef.current = nextCompactControls;
        if (nextCompactControls) {
          header.dataset.liveHeaderCompact = 'true';
        } else {
          delete header.dataset.liveHeaderCompact;
        }
      }
    };

    updateCollapsed();
    const ro = new ResizeObserver(updateCollapsed);
    ro.observe(header);
    ro.observe(spacer);
    ro.observe(root);
    window.addEventListener('resize', updateCollapsed);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateCollapsed);
      delete header.dataset.liveHeaderCompact;
      if (cooldownTimer != null) {
        window.clearTimeout(cooldownTimer);
      }
    };
  }, [rootRef]);

  return isCollapsed;
}
