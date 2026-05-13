import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { showToast } from '../../utils/toast';
import type { SpotifyCsvTrack } from '../../utils/spotifyCsvImport';

interface CsvReportModalProps {
  report: {
    added: number;
    notFound: SpotifyCsvTrack[];
    duplicates: number;
    duplicateTracks: SpotifyCsvTrack[];
    total: number;
    searchErrors?: SpotifyCsvTrack[];
  };
  playlistName: string;
  onClose: () => void;
}

export default function CsvImportReportModal({ report, playlistName, onClose }: CsvReportModalProps) {
  const { t } = useTranslation();
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const downloadReport = () => {
    try {
      const content = [
        'CSV Import Report',
        `Playlist: ${playlistName}`,
        `Date: ${new Date().toLocaleString()}`,
        `Total: ${report.total}, Added: ${report.added}, Duplicates: ${report.duplicates}, Not Found: ${report.notFound.length}${report.searchErrors ? `, Network Errors: ${report.searchErrors.length}` : ''}`,
        '',
        ...(report.duplicateTracks.length > 0 ? ['Duplicate Tracks (skipped):', ...report.duplicateTracks.map(t => `- ${t.trackName} by ${t.artistName}${t.albumName ? ` (${t.albumName})` : ''}`), ''] : []),
        ...(report.notFound.length > 0 ? ['Not Found Tracks:', ...report.notFound.map(t => `  - ${t.trackName} | ${t.artistName} | ${t.albumName || 'N/A'} | Score: ${(t.score ?? 0).toFixed(2)} (threshold: ${(t.thresholdNeeded ?? 0).toFixed(2)})`), ''] : []),
        ...(report.searchErrors && report.searchErrors.length > 0 ? ['Network Error Tracks (may retry):', ...report.searchErrors.map(t => `- ${t.trackName} by ${t.artistName}`), ''] : []),
      ].join('\n');

      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');

      // Detailed name: playlist + date-time-seconds
      const timestamp = new Date().toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const safePlaylistName = playlistName.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 50);
      a.download = `import-report-${safePlaylistName}-${timestamp}.txt`;

      a.href = url;
      a.click();
      URL.revokeObjectURL(url);

      showToast(t('playlists.csvImportDownloadSuccess'), 3000, 'info');
    } catch (err) {
      console.error('Failed to download report:', err);
      showToast(t('playlists.csvImportDownloadError'), 3000, 'error');
    }
  };

  return createPortal(
    <div
      className="modal-overlay modal-overlay--csv"
      onClick={handleOverlayClick}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
      }}
    >
      <div
        className="modal-content"
        style={{
          maxWidth: 500,
          maxHeight: '80vh',
          width: '90%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
        onClick={e => e.stopPropagation()}
      >
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ position: 'absolute', top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 20, marginBottom: 16 }}>{t('playlists.csvImportReport')}</h2>

        <div style={{ display: 'grid', gridTemplateColumns: report.searchErrors && report.searchErrors.length > 0 ? 'repeat(5, 1fr)' : 'repeat(4, 1fr)', gap: 12, marginBottom: 20, textAlign: 'center' }}>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)' }}>{report.total}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportTotal')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>{report.added}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportAdded')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-muted)' }}>{report.duplicates}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportDuplicates')}</div>
          </div>
          <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: report.notFound.length > 0 ? '#ff6b6b' : 'var(--text-muted)' }}>{report.notFound.length}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportNotFound')}</div>
          </div>
          {report.searchErrors && report.searchErrors.length > 0 && (
            <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#ffa500' }}>{report.searchErrors.length}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('playlists.csvImportNetworkErrors')}</div>
            </div>
          )}
        </div>

        {report.duplicateTracks.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-muted)' }}>{t('playlists.csvImportDuplicatesTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 150, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.duplicateTracks.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {report.notFound.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-muted)' }}>{t('playlists.csvImportNotFoundTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 200, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.notFound.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                  {track.albumName && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{track.albumName}</div>}
                  {track.score !== undefined && (
                    <div style={{ fontSize: 11, marginTop: 2 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Score: </span>
                      <span style={{ color: track.score >= (track.thresholdNeeded ?? 0.6) ? '#4ade80' : '#f87171' }}>
                        {track.score.toFixed(2)}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}> (threshold: {(track.thresholdNeeded ?? 0.6).toFixed(2)})</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {report.searchErrors && report.searchErrors.length > 0 && (
          <>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: '#ffa500' }}>{t('playlists.csvImportNetworkErrorsTitle')}</h3>
            <div style={{ overflowY: 'auto', maxHeight: 150, marginBottom: 16, border: '1px solid var(--surface)', borderRadius: 8 }}>
              {report.searchErrors.map((track, i) => (
                <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--surface)', fontSize: 13 }}>
                  <div style={{ fontWeight: 500 }}>{track.trackName}</div>
                  <div style={{ color: 'var(--text-muted)' }}>{track.artistName}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button className="btn btn-surface" onClick={downloadReport}>
            <Download size={14} /> {t('playlists.csvImportDownloadReport')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t('playlists.csvImportClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
