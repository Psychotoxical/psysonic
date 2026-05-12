import type { SubsonicAlbum } from '../api/subsonicTypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { getAlbumList } from '../api/subsonic';
import { showToast } from '../utils/toast';
import {
  exportAlbumCardBlob,
  renderAlbumCardCanvas,
  ExportFormat,
  ExportGridSize,
} from '../utils/exportAlbumCard';

interface Props {
  open: boolean;
  /** Pre-loaded albums (e.g. from the statistics page). The modal will fetch
   *  more on open if this list is shorter than 25 (max grid 5×5). */
  albums: SubsonicAlbum[];
  /** Footer-right meta string, e.g. "Most Played" or a date. */
  meta?: string;
  onClose: () => void;
}

const MAX_NEEDED = 25; // 5 × 5 grid

const FORMATS: { key: ExportFormat; ratioBox: { w: number; h: number } }[] = [
  { key: 'story',   ratioBox: { w: 36, h: 64 } },
  { key: 'square',  ratioBox: { w: 50, h: 50 } },
  { key: 'twitter', ratioBox: { w: 64, h: 36 } },
];

const GRID_SIZES: ExportGridSize[] = [3, 4, 5];

export default function StatsExportModal({ open, albums, meta, onClose }: Props) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('square');
  const [gridSize, setGridSize] = useState<ExportGridSize>(3);
  const [saving, setSaving] = useState(false);
  const [topUpAlbums, setTopUpAlbums] = useState<SubsonicAlbum[] | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewSeqRef = useRef(0);

  const effectiveAlbums = topUpAlbums ?? albums;
  const required = gridSize * gridSize;
  const enoughAlbums = effectiveAlbums.length >= required;

  // On open: if the caller-provided list is shorter than the largest grid,
  // fetch up to 25 in the background so the user can pick 4×4 / 5×5 even
  // when the entry surface only loaded a few albums.
  useEffect(() => {
    if (!open) return;
    if (albums.length >= MAX_NEEDED) {
      setTopUpAlbums(albums);
      return;
    }
    setTopUpAlbums(null);
    let cancelled = false;
    (async () => {
      try {
        const more = await getAlbumList('frequent', MAX_NEEDED, 0);
        if (cancelled) return;
        setTopUpAlbums(more.length > albums.length ? more : albums);
      } catch {
        if (!cancelled) setTopUpAlbums(albums);
      }
    })();
    return () => { cancelled = true; };
  }, [open, albums]);

  const title = t('statistics.exportFooterLabel');

  // Live preview: re-renders on format / gridSize / albums changes.
  useEffect(() => {
    if (!open) return;
    if (!enoughAlbums) return;
    const host = previewRef.current;
    if (!host) return;
    const seq = ++previewSeqRef.current;

    let cancelled = false;
    (async () => {
      try {
        const canvas = await renderAlbumCardCanvas({
          albums: effectiveAlbums,
          format,
          gridSize,
          title,
          meta,
          preview: true,
        });
        if (cancelled || seq !== previewSeqRef.current) return;
        // Replace any previous preview canvas.
        host.replaceChildren(canvas);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.style.borderRadius = '12px';
        canvas.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
      } catch (e) {
        if (!cancelled && seq === previewSeqRef.current) {
          host.textContent = String(e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, format, gridSize, effectiveAlbums, enoughAlbums, title, meta]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onSave = async () => {
    if (saving || !enoughAlbums) return;
    setSaving(true);
    try {
      const blob = await exportAlbumCardBlob({ albums: effectiveAlbums, format, gridSize, title, meta });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const suggested = `psysonic-top-albums-${gridSize}x${gridSize}-${format}-${stamp}.png`;
      const path = await save({
        title: t('statistics.exportSave'),
        defaultPath: suggested,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (!path) {
        setSaving(false);
        return;
      }
      const buf = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, buf);
      showToast(t('statistics.exportSaved'), 2400, 'info');
      onClose();
    } catch (err) {
      console.error('[stats-export] save failed', err);
      showToast(t('statistics.exportSaveFailed'), 3200, 'error');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '720px', width: 'min(720px, 92vw)' }}
      >
        <button className="modal-close" onClick={onClose} aria-label={t('statistics.exportCancel')}>
          <X size={18} />
        </button>
        <h3 style={{ marginBottom: '0.25rem', fontFamily: 'var(--font-display)' }}>
          {t('statistics.exportTitle')}
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.875rem' }}>
          {t('statistics.exportSubtitle')}
        </p>

        {/* Format */}
        <div style={{ marginBottom: '0.875rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('statistics.exportFormat')}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {FORMATS.map(f => {
              const active = format === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFormat(f.key)}
                  className="btn btn-surface"
                  style={{
                    padding: '0.5rem 0.75rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--glass-border)'}`,
                    background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
                  }}
                >
                  <span style={{
                    display: 'inline-block',
                    width: f.ratioBox.w * 0.4,
                    height: f.ratioBox.h * 0.4,
                    background: active ? 'var(--accent)' : 'var(--text-muted)',
                    opacity: active ? 0.9 : 0.5,
                    borderRadius: 2,
                  }} />
                  {t(`statistics.exportFormat${f.key[0].toUpperCase()}${f.key.slice(1)}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Grid */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('statistics.exportGrid')}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {GRID_SIZES.map(n => {
              const active = gridSize === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setGridSize(n)}
                  className="btn btn-surface"
                  style={{
                    padding: '0.5rem 0.875rem',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--glass-border)'}`,
                    background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
                  }}
                >
                  {t('statistics.exportGridLabel', { n })}
                </button>
              );
            })}
          </div>
        </div>

        {/* Preview */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('statistics.exportPreview')}
          </div>
          <PreviewFrame format={format}>
            {!enoughAlbums ? (
              <div style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '0.875rem',
                padding: '1rem',
              }}>
                {t('statistics.exportNotEnough', { count: required, n: gridSize })}
              </div>
            ) : (
              <div ref={previewRef} style={{ width: '100%' }} />
            )}
          </PreviewFrame>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {t('statistics.exportCancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={onSave}
            disabled={!enoughAlbums || saving}
          >
            {saving ? t('statistics.exportSaving') : t('statistics.exportSave')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const PreviewFrame = ({ format, children }: { format: ExportFormat; children: React.ReactNode }) => {
  const aspect = useMemo(() => {
    if (format === 'story')   return '9 / 16';
    if (format === 'square')  return '1 / 1';
    return '16 / 9';
  }, [format]);
  // Cap preview height so the modal stays manageable on a typical desktop.
  // Narrow ratios (Story) become height-bounded; wide ratios (Twitter) are
  // width-bounded by the modal itself.
  return (
    <div style={{
      position: 'relative',
      width: '100%',
      maxHeight: '52vh',
      aspectRatio: aspect,
      margin: '0 auto',
      maxWidth: format === 'story' ? '320px' : undefined,
      background: 'var(--glass-bg)',
      borderRadius: 12,
      border: '1px solid var(--glass-border)',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  );
};
