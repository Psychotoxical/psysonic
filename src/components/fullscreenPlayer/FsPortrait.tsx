import { memo, useEffect, useRef, useState } from 'react';

// Artist portrait — right half, crossfades on track change.
export const FsPortrait = memo(function FsPortrait({ url }: { url: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const counterRef = useRef(1);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const id = counterRef.current++;
    const img = new Image();
    img.onload = img.onerror = () => {
      if (cancelled) return;
      setLayers(prev => [...prev, { url, id, visible: false }]);
      requestAnimationFrame(() => {
        if (cancelled) return;
        if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
        setLayers(prev => prev.map(l => ({ ...l, visible: l.id === id })));
        cleanupTimer.current = setTimeout(() => {
          if (!cancelled) setLayers(prev => prev.filter(l => l.id === id));
        }, 1000);
      });
    };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);

  if (layers.length === 0) return null;

  return (
    <div className="fs-portrait-wrap" aria-hidden="true">
      {layers.map(layer => (
        <img
          key={layer.id}
          src={layer.url}
          className="fs-portrait"
          style={{ opacity: layer.visible ? 1 : 0 }}
          decoding="async"
          loading="eager"
          alt=""
        />
      ))}
    </div>
  );
});
