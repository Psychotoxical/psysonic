import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { savePngBlob } from '@/lib/dom/saveCanvasPng';
import { showToast } from '@/lib/dom/toast';
import type { YearRecapData } from '@/features/stats/hooks/useYearRecapData';
import {
  exportRewindPosterBlob,
  renderRewindPoster,
  type RewindPosterFormat,
  type RewindPosterLayout,
  type RewindPosterOptions,
} from '@/features/stats/utils/recapPoster';
import { listeningPersona, PERSONA_WINDOWS } from '@/features/stats/utils/yearRecapDerive';

interface Props {
  open: boolean;
  data: YearRecapData;
  onClose: () => void;
}

const FORMATS: RewindPosterFormat[] = ['story', 'square'];

const LAYOUT_LABEL_KEYS: Record<RewindPosterLayout, string> = {
  overview: 'statistics.rewindLayoutOverview',
  artist: 'statistics.rewindLayoutArtist',
  album: 'statistics.rewindLayoutAlbum',
  nerd: 'statistics.rewindLayoutNerd',
};

export default function YearRecapExportModal({ open, data, onClose }: Props) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<RewindPosterLayout>('overview');
  const [format, setFormat] = useState<RewindPosterFormat>('story');
  const [saving, setSaving] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewSeqRef = useRef(0);

  // §11: spotlight layouts need a leader — hide them instead of rendering holes.
  const layouts = useMemo<RewindPosterLayout[]>(() => {
    const available: RewindPosterLayout[] = ['overview'];
    if (data.recap.topArtists.length > 0) available.push('artist');
    if (data.recap.topAlbums.length > 0) available.push('album');
    available.push('nerd');
    return available;
  }, [data.recap.topArtists.length, data.recap.topAlbums.length]);

  // A data change can retire the selected spotlight layout — never render it.
  const activeLayout = layouts.includes(layout) ? layout : 'overview';

  const posterOptions = useMemo<RewindPosterOptions>(() => {
    const persona = listeningPersona(data.recap.hourlyPlayCounts);
    const window = persona ? PERSONA_WINDOWS[persona] : null;
    return {
      data: { recap: data.recap, summary: data.summary, year: data.year },
      layout: activeLayout,
      format,
      strings: {
        kicker: t('statistics.recapIntroKicker'),
        overviewTitle: t('statistics.recapCardTitle', { year: data.year }),
        artistTitle: t('statistics.rewindArtistTitle'),
        albumTitle: t('statistics.rewindAlbumTitle'),
        nerdTitle: t('statistics.rewindNerdTitle'),
        hoursWord: t('statistics.recapStatHours'),
        minutesWord: t('statistics.rewindMinutesWord'),
        hourUnit: t('statistics.rewindHourUnit'),
        minuteUnit: t('statistics.rewindMinuteUnit'),
        nerdHeroLabel: t('statistics.rewindNerdHeroLabel'),
        statDays: t('statistics.recapStatDays'),
        statPlays: t('statistics.recapStatPlays'),
        statNewArtists: t('statistics.recapStatNewArtists'),
        statUniqueTracks: t('statistics.rewindUniqueTracks'),
        statSessions: t('statistics.rewindSessions'),
        statListeningTime: t('statistics.rewindListeningTime'),
        statPlaysShort: t('statistics.rewindPlays'),
        topArtists: t('statistics.recapTopArtists'),
        topAlbums: t('statistics.recapTopAlbums'),
        topTracks: t('statistics.recapTopTracks'),
        topGenres: t('statistics.recapTopGenres'),
        losslessWord: t('statistics.recapLosslessTitle'),
        losslessSentence: t('statistics.recapLosslessBody'),
        hourlyHeading: t('statistics.rewindHourlyHeading'),
        personaTitle: persona
          ? t(`statistics.recapPersona${persona[0].toUpperCase()}${persona.slice(1)}`)
          : null,
        personaBody: window
          ? t('statistics.rewindPersonaBody', { from: window.from, to: window.to })
          : null,
        longestSession: t('statistics.rewindLongestSession'),
        localFirstTitle: t('statistics.rewindLocalFirstTitle'),
        localFirstBody: t('statistics.rewindLocalFirstBody'),
        privacy: t('statistics.recapPrivacy'),
      },
    };
  }, [data, activeLayout, format, t]);

  // Live preview — same replaceChildren pattern as StatsExportModal.
  useEffect(() => {
    if (!open) return;
    const host = previewRef.current;
    if (!host) return;
    const seq = ++previewSeqRef.current;
    let cancelled = false;
    (async () => {
      try {
        const canvas = await renderRewindPoster(posterOptions);
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
      const blob = await exportRewindPosterBlob(posterOptions);
      const saved = await savePngBlob(blob, `psysonic-rewind-${data.year}-${activeLayout}-${format}.png`, {
        dialogTitle: t('statistics.exportSave'),
        savedToast: t('statistics.exportSaved'),
        failedToast: t('statistics.exportSaveFailed'),
      });
      if (saved) onClose();
    } catch (err) {
      console.error('[rewind-export] render failed', err);
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
            <div className="year-recap-option-label">{t('statistics.rewindLayoutLabel')}</div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {layouts.map(l => (
                <button
                  key={l}
                  type="button"
                  className="btn btn-surface"
                  style={optionButton(activeLayout === l)}
                  onClick={() => setLayout(l)}
                >
                  {t(LAYOUT_LABEL_KEYS[l])}
                </button>
              ))}
            </div>
          </div>
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
