import React, { useRef, useState, useEffect, useCallback } from 'react';
import { usePerfProbeFlags } from '../utils/perfFlags';

interface Props {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export default function MarqueeText({ text, className, style, onClick, onContextMenu }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollAmount, setScrollAmount] = useState(0);
  const perfFlags = usePerfProbeFlags();

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

  const shouldScroll = scrollAmount > 0 && !perfFlags.disableMarqueeScroll;

  return (
    <div
      ref={containerRef}
      className={`marquee-wrap${className ? ` ${className}` : ''}`}
      style={style}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
