import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import CoverLightbox from '../components/CoverLightbox';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { ensureCoverTierJs } from './resolveJs';
import type { CoverArtRef } from './types';

export function useCoverLightboxSrc(
  ref: CoverArtRef | null,
  opts?: { alt?: string },
): { open: () => void; lightbox: ReactNode; src: string; loading: boolean } {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState('');
  const [loading, setLoading] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !ref) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const blob = await ensureCoverTierJs(ref, 2000);
      if (cancelled) return;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (blob) {
        const blobUrl = URL.createObjectURL(blob);
        blobUrlRef.current = blobUrl;
        setSrc(blobUrl);
      } else {
        setSrc(buildCoverArtFetchUrl(ref, 2000));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, ref?.coverArtId, ref?.serverScope]);

  useEffect(() => {
    if (open) return;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setSrc('');
    setLoading(false);
  }, [open]);

  useEffect(() => () => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
  }, []);

  const handleClose = useCallback(() => setOpen(false), []);
  const handleOpen = useCallback(() => setOpen(true), []);

  const lightbox = open && src && !loading ? (
    <CoverLightbox src={src} alt={opts?.alt ?? ''} onClose={handleClose} />
  ) : null;

  return { open: handleOpen, lightbox, src, loading };
}
