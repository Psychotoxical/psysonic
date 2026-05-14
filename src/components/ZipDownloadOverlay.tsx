import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { HardDriveDownload, Check, X } from 'lucide-react';
import { useZipDownloadStore } from '../store/zipDownloadStore';
import { formatBytes } from '../utils/format/formatBytes';

function ZipDownloadItem({ id }: { id: string }) {
  const dismiss = useZipDownloadStore(s => s.dismiss);
  const item = useZipDownloadStore(s => s.downloads.find(d => d.id === id));

  // Auto-dismiss 3 s after completion or error.
  useEffect(() => {
    if (!item?.done && !item?.error) return;
    const timer = setTimeout(() => dismiss(id), 3000);
    return () => clearTimeout(timer);
  }, [item?.done, item?.error, id, dismiss]);

  if (!item) return null;

  const pct = item.total && item.total > 0
    ? Math.min(100, (item.bytes / item.total) * 100)
    : null;

  const isIndeterminate = !item.done && !item.error && (item.total === null || item.total === 0);

  return (
    <div className={`zip-dl-item${item.done ? ' zip-dl-done' : item.error ? ' zip-dl-error' : ''}`}>
      <div className="zip-dl-header">
        {item.done
          ? <Check size={13} />
          : item.error
            ? <X size={13} />
            : <HardDriveDownload size={13} className="spin-slow" />
        }
        <span className="zip-dl-name" data-tooltip={item.filename} data-tooltip-pos="top">{item.filename}</span>
        {(item.done || item.error) && (
          <button className="zip-dl-close" onClick={() => dismiss(id)} aria-label="Close">
            <X size={10} />
          </button>
        )}
      </div>

      {!item.done && !item.error && (
        <>
          <div className="zip-dl-info">
            {formatBytes(item.bytes)}
            {item.total !== null && item.total > 0 && (
              <> / {formatBytes(item.total)} &nbsp;({pct!.toFixed(0)}%)</>
            )}
          </div>
          <div className={`zip-dl-track${isIndeterminate ? ' zip-dl-indeterminate' : ''}`}>
            {!isIndeterminate && pct !== null && (
              <div className="zip-dl-fill" style={{ width: `${pct}%` }} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ZipDownloadOverlay() {
  // Subscribe to the array reference directly — never derive a new array in the selector
  // (selector returning new array on every call causes an infinite re-render loop).
  const downloads = useZipDownloadStore(s => s.downloads);
  if (downloads.length === 0) return null;

  return createPortal(
    <div className="zip-dl-overlay">
      {downloads.map(d => <ZipDownloadItem key={d.id} id={d.id} />)}
    </div>,
    document.body,
  );
}
