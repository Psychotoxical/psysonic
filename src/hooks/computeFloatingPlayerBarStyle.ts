import type { CSSProperties } from 'react';

const HORIZONTAL_MARGIN_PX = 24;

/** Center the floating bar in the main column; shrink-wrap width instead of stretching. */
export function computeFloatingPlayerBarStyle(
  sidebarRight: number,
  queueLeft: number | null,
  viewportWidth: number,
): CSSProperties {
  const contentLeft = sidebarRight;
  const contentRight = queueLeft ?? viewportWidth;
  const contentWidth = Math.max(0, contentRight - contentLeft);
  const maxWidth = Math.max(100, contentWidth - HORIZONTAL_MARGIN_PX * 2);
  const centerX = contentLeft + contentWidth / 2;

  return {
    left: centerX,
    right: 'auto',
    transform: 'translateX(-50%)',
    width: 'max-content',
    maxWidth,
  };
}
