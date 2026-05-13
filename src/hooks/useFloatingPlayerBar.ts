import React, { useEffect, useState } from 'react';

/** Computes the floating player-bar position based on the current sidebar +
 *  queue panel widths. Returns an inline-style object (left/right/width); only
 *  active when `floatingPlayerBar` is true. Uses a ResizeObserver on both
 *  containers so the bar slides while the sidebar or queue is resized. */
export function useFloatingPlayerBar(
  _playerBarRef: React.RefObject<HTMLElement | null>,
  floatingPlayerBar: boolean,
): React.CSSProperties {
  const [floatingStyle, setFloatingStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!floatingPlayerBar) return;

    const updatePosition = () => {
      const sidebar = document.querySelector('.sidebar') as HTMLElement;
      const queue = document.querySelector('.queue-panel') as HTMLElement;

      const leftOffset = sidebar ? sidebar.getBoundingClientRect().right : 0;
      const rightOffset = queue ? window.innerWidth - queue.getBoundingClientRect().left : 0;

      setFloatingStyle({
        left: leftOffset + 24,
        right: rightOffset + 24,
        width: 'auto',
      });
    };

    updatePosition();

    const observer = new ResizeObserver(updatePosition);
    const sidebar = document.querySelector('.sidebar');
    const queue = document.querySelector('.queue-panel');
    if (sidebar) observer.observe(sidebar);
    if (queue) observer.observe(queue);
    window.addEventListener('resize', updatePosition);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
    };
  }, [floatingPlayerBar]);

  return floatingStyle;
}
