import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HardDriveDownload, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/lib/format/formatBytes';

const OPEN_DELAY_MS = 450;

interface Props {
  label: string;
  totalBytes: number | null;
  libraryBytes: number | null;
  favoritesBytes: number | null;
}

export function OfflineLibraryDiskStat({
  label,
  totalBytes,
  libraryBytes,
  favoritesBytes,
}: Props) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const openTimerRef = useRef<number | null>(null);

  const breakdownReady = libraryBytes !== null && favoritesBytes !== null;

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  const scheduleOpen = () => {
    if (!breakdownReady) return;
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };

  const close = () => {
    clearOpenTimer();
    setOpen(false);
  };

  const breakdownAriaLabel = breakdownReady
    ? [
      t('connection.offlineLibraryDiskTierLibrary', { size: formatBytes(libraryBytes) }),
      t('connection.offlineLibraryDiskTierFavorites', { size: formatBytes(favoritesBytes) }),
    ].join('. ')
    : undefined;

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popoverRef.current) {
      setStyle({ opacity: 0 });
      return;
    }

    const anchor = anchorRef.current.getBoundingClientRect();
    const box = popoverRef.current.getBoundingClientRect();
    const GAP = 8;
    const MARGIN = 8;

    let top = anchor.bottom + GAP;
    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));

    setStyle({ opacity: 1, top, left });
  }, [open, libraryBytes, favoritesBytes]);

  useEffect(() => () => clearOpenTimer(), []);

  return (
    <>
      <div
        ref={anchorRef}
        className={`offline-library-header-stat${breakdownReady ? ' offline-library-header-stat--interactive' : ''}`}
        aria-live="polite"
        aria-label={breakdownAriaLabel}
        onMouseEnter={scheduleOpen}
        onMouseLeave={close}
        onFocus={scheduleOpen}
        onBlur={close}
        tabIndex={breakdownReady ? 0 : undefined}
      >
        <span className="offline-library-disk-label">{label}</span>
        <span className="offline-library-disk-value">
          {totalBytes !== null ? formatBytes(totalBytes) : '…'}
        </span>
      </div>
      {open && breakdownReady && createPortal(
        <div
          ref={popoverRef}
          className="offline-library-disk-breakdown"
          style={{ position: 'fixed', pointerEvents: 'auto', ...style }}
          role="tooltip"
          onMouseEnter={() => {
            clearOpenTimer();
            setOpen(true);
          }}
          onMouseLeave={close}
        >
          <div className="offline-library-disk-breakdown-row">
            <span
              className="offline-library-disk-breakdown-icon offline-library-disk-breakdown-icon--library"
              aria-hidden
            >
              <HardDriveDownload size={15} strokeWidth={2} />
            </span>
            <span className="offline-library-disk-breakdown-size">
              {formatBytes(libraryBytes)}
            </span>
          </div>
          <div className="offline-library-disk-breakdown-divider" aria-hidden />
          <div className="offline-library-disk-breakdown-row">
            <span
              className="offline-library-disk-breakdown-icon offline-library-disk-breakdown-icon--favorites"
              aria-hidden
            >
              <Heart size={15} strokeWidth={2} />
            </span>
            <span className="offline-library-disk-breakdown-size">
              {formatBytes(favoritesBytes)}
            </span>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
