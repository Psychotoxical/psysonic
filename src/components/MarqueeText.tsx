import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '../store/authStore';

interface Props {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}

export default function MarqueeText({ text, className, style, onClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollAmount, setScrollAmount] = useState(0);
  const animationMode = useAuthStore(s => s.animationMode);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;
    text.style.display = 'inline-block';
    const textWidth = text.getBoundingClientRect().width;
    text.style.display = '';
    const overflow = textWidth - container.clientWidth;
    setScrollAmount(overflow > 4 ? Math.ceil(overflow) : 0);
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [text, measure]);

  // In `static` animation mode the marquee never scrolls — overflowing text
  // is truncated with an ellipsis (handled by CSS via data-anim-mode).
  const shouldScroll = scrollAmount > 0 && animationMode !== 'static';

  return (
    <div
      ref={containerRef}
      className={`marquee-wrap${className ? ` ${className}` : ''}`}
      style={style}
      onClick={onClick}
      data-anim-mode={animationMode}
    >
      <span
        ref={textRef}
        className={shouldScroll ? 'marquee-scroll' : ''}
        style={shouldScroll ? { '--marquee-amount': `-${scrollAmount}px` } as React.CSSProperties : {}}
      >
        {text}
      </span>
    </div>
  );
}
