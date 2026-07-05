import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
}

export default function CoverLightbox({ src, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="cover-lightbox-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt}>
      <button className="cover-lightbox-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      <img
        className="cover-lightbox-img"
        src={src}
        alt={alt}
        onClick={e => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
