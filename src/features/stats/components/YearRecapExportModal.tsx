import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { savePngBlob } from '@/lib/dom/saveCanvasPng';
import { showToast } from '@/lib/dom/toast';
import type { YearRecapData } from '@/features/stats/hooks/useYearRecapData';
import {
  exportYearRecapBlob,
  personaForPoster,
  renderYearRecapCanvas,
  type RecapPosterFormat,
  type RecapPosterOptions,
  type RecapPosterPalette,
} from '@/features/stats/utils/exportYearRecap';

interface Props {
  open: boolean;
  data: YearRecapData;
  onClose: () => void;
}

const FORMATS: RecapPosterFormat[] = ['story', 'square'];
const PALETTES: RecapPosterPalette[] = ['midnight', 'daylight'];

export default function YearRecapExportModal({ open, data, onClose }: Props) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<RecapPosterFormat>('story');
  const [palette, setPalette] = useState<RecapPosterPalette>('midnight');
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewSeqRef = useRef(0);

  const posterOptions = useMemo<RecapPosterOptions>(() => {
    const persona = personaForPoster(data.recap);
    return {
      recap: data.recap,
      heatmap: data.heatmap,
      year: data.year,
      listeningDayCount: data.summary.listeningDayCount,
      format,
      palette,
      strings: {
        kicker: t('statistics.recapIntroKicker'),
        title: t('statistics.recapCardTitle', { year: data.year }),
        hoursLabel: t('statistics.recapStatHours'),
        daysLabel: t('statistics.recapStatDays'),
        playsLabel: t('statistics.recapStatPlays'),
        newArtistsLabel: t('statistics.recapStatNewArtists'),
        topArtists: t('statistics.recapTopArtists'),
        topAlbums: t('statistics.recapTopAlbums'),
        losslessLabel: t('statistics.recapLosslessBody'),
        personaLabel: persona
          ? t(`statistics.recapPersona${persona[0].toUpperCase()}${persona.slice(1)}`)
          : null,
        privacy: t('statistics.recapPrivacy'),
      },
    };
  }, [data, format, palette, t]);

  // Live preview — same replaceChildren pattern as StatsExportModal.
  useEffect(() => {
    if (!open) return;
    const host = previewRef.current;
    if (!host) return;
    const seq = ++previewSeqRef.current;
    let cancelled = false;
    (async () => {
      try {
        const canvas = await renderYearRecapCanvas(posterOptions);
        if (cancelled || seq !== previewSeqRef.current) return;
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
  }, [open, posterOptions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const blob = await exportYearRecapBlob(posterOptions);
      const saved = await savePngBlob(blob, `psysonic-recap-${data.year}-${format}.png`, {
        dialogTitle: t('statistics.exportSave'),
        savedToast: t('statistics.exportSaved'),
        failedToast: t('statistics.exportSaveFailed'),
      });
      if (saved) onClose();
    } catch (err) {
      console.error('[recap-export] render failed', err);
      showToast(t('statistics.exportSaveFailed'), 3200, 'error');
    } finally {
      setSaving(false);
    }
  };

  const optionButton = (active: boolean): React.CSSProperties => ({
    padding: '0.5rem 0.875rem',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--glass-border)'}`,
    background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
  });

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
        style={{ maxWidth: '640px', width: 'min(640px, 92vw)' }}
      >
        <button className="modal-close" onClick={onClose} aria-label={t('statistics.exportCancel')}>
          <X size={18} />
        </button>
        <h3 style={{ marginBottom: '0.25rem', fontFamily: 'var(--font-display)' }}>
          {t('statistics.recapExportTitle', { year: data.year })}
        </h3>

        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div>
            <div className="year-recap-option-label">{t('statistics.exportFormat')}</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {FORMATS.map(f => (
                <button
                  key={f}
                  type="button"
                  className="btn btn-surface"
                  style={optionButton(format === f)}
                  onClick={() => setFormat(f)}
                >
                  {t(f === 'story' ? 'statistics.exportFormatStory' : 'statistics.exportFormatSquare')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="year-recap-option-label">{t('statistics.recapPaletteLabel')}</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {PALETTES.map(p => (
                <button
                  key={p}
                  type="button"
                  className="btn btn-surface"
                  style={optionButton(palette === p)}
                  onClick={() => setPalette(p)}
                >
                  {t(p === 'midnight' ? 'statistics.recapPaletteMidnight' : 'statistics.recapPaletteDaylight')}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: format === 'story' ? '9 / 16' : '1 / 1',
            margin: '0 auto 1rem',
            maxWidth: format === 'story' ? 'min(300px, calc(50vh * 9 / 16))' : '46vh',
            maxHeight: '50vh',
            background: 'var(--glass-bg)',
            borderRadius: 12,
            border: '1px solid var(--glass-border)',
            overflow: 'hidden',
          }}
        >
          <div ref={previewRef} style={{ width: '100%' }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {t('statistics.exportCancel')}
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? t('statistics.exportSaving') : t('statistics.exportSave')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
