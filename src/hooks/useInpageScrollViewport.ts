import { useCallback, useRef, useState } from 'react';

/** In-page overlay scroll viewport ref + state for IntersectionObserver roots. */
export function useInpageScrollViewport() {
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollBodyEl, setScrollBodyEl] = useState<HTMLDivElement | null>(null);
  const bindScrollBody = useCallback((el: HTMLDivElement | null) => {
    scrollBodyRef.current = el;
    setScrollBodyEl(el);
  }, []);
  const getScrollRoot = useCallback(() => scrollBodyRef.current, []);
  return { scrollBodyRef, scrollBodyEl, bindScrollBody, getScrollRoot };
}
