import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, DatabaseZap, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { startScan } from '../../api/subsonicScan';
import { useScanStore } from '../../store/scanStore';
import { showToast } from '../../utils/ui/toast';

const CONFIRM_TIMEOUT_MS = 3000;

interface Props {
  serverId: string;
  /** `compact` for the server switcher dropdown (icon-only), `card` for the settings cards. */
  variant: 'compact' | 'card';
}

export default function ServerScanActions({ serverId, variant }: Props) {
  const { t } = useTranslation();
  const entry = useScanStore(s => s.byServer[serverId]);
  const setEntry = useScanStore(s => s.set);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phase = entry?.phase ?? 'idle';
  const count = entry?.count ?? 0;
  const confirmingFull = entry?.confirmingFull ?? false;
  const busy = phase === 'starting' || phase === 'running';

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

  const armConfirmTimeout = () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setEntry(serverId, { confirmingFull: false });
    }, CONFIRM_TIMEOUT_MS);
  };

  const launch = async (full: boolean) => {
    setEntry(serverId, { phase: 'starting', type: full ? 'full' : 'quick', count: 0, confirmingFull: false });
    try {
      await startScan(serverId, full);
      setEntry(serverId, { phase: 'running' });
    } catch (err) {
      setEntry(serverId, { phase: 'error' });
      showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Scan failed', 4000, 'error');
    }
  };

  const onQuickClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    void launch(false);
  };

  const onFullClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (!confirmingFull) {
      setEntry(serverId, { confirmingFull: true });
      armConfirmTimeout();
      return;
    }
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    void launch(true);
  };

  // ── Status slot content ──────────────────────────────────────────────────
  const status = (() => {
    if (phase === 'running' || phase === 'starting') {
      const label = count > 0 ? formatCount(count) : '';
      return (
        <span className="server-scan-status" data-tooltip={t('settings.scan.scanning')}>
          <Loader2 size={13} className="spin-slow" />
          {label && <span className="server-scan-status-count">{label}</span>}
        </span>
      );
    }
    if (phase === 'just-finished') {
      return (
        <span className="server-scan-status server-scan-status--done" data-tooltip={t('settings.scan.done')}>
          <Check size={13} />
        </span>
      );
    }
    if (phase === 'error') {
      return (
        <span className="server-scan-status server-scan-status--error" data-tooltip={t('settings.scan.error')}>
          <WifiOff size={13} />
        </span>
      );
    }
    return null;
  })();

  // ── Render ───────────────────────────────────────────────────────────────
  if (variant === 'compact') {
    return (
      <span className="server-scan-actions server-scan-actions--compact" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="player-btn player-btn-sm"
          onClick={onQuickClick}
          disabled={busy}
          data-tooltip={t('settings.scan.quickTip')}
          data-tooltip-pos="bottom"
          aria-label={t('settings.scan.quick')}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className={`player-btn player-btn-sm${confirmingFull ? ' server-scan-btn--confirm' : ''}`}
          onClick={onFullClick}
          disabled={busy}
          data-tooltip={confirmingFull ? t('settings.scan.confirmFull') : t('settings.scan.fullTip')}
          data-tooltip-pos="bottom"
          aria-label={t('settings.scan.full')}
        >
          <DatabaseZap size={13} />
        </button>
        <span className="server-scan-slot" aria-live="polite">{status}</span>
      </span>
    );
  }

  // Card variant — matches the existing `btn btn-surface` chrome in ServersTab actions.
  return (
    <>
      <button
        type="button"
        className="btn btn-surface"
        style={{ fontSize: 12, padding: '4px 10px' }}
        onClick={onQuickClick}
        disabled={busy}
        data-tooltip={t('settings.scan.quickTip')}
        aria-label={t('settings.scan.quick')}
      >
        <RefreshCw size={13} />
        <span className="server-card-btn-label">{t('settings.scan.quick')}</span>
      </button>
      <button
        type="button"
        className={`btn btn-surface${confirmingFull ? ' btn-confirm-danger' : ''}`}
        style={{ fontSize: 12, padding: '4px 10px' }}
        onClick={onFullClick}
        disabled={busy}
        data-tooltip={confirmingFull ? t('settings.scan.confirmFull') : t('settings.scan.fullTip')}
        aria-label={t('settings.scan.full')}
      >
        <DatabaseZap size={13} />
        <span className="server-card-btn-label">
          {confirmingFull ? t('settings.scan.confirmFullShort') : t('settings.scan.full')}
        </span>
      </button>
      {status && <span className="server-scan-slot">{status}</span>}
    </>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
