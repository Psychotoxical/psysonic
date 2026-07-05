import { useState } from 'react';
import { Activity, Network, ScrollText, SlidersHorizontal, Wrench, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import SidebarPerfProbeMonitorTab from '@/features/sidebar/components/perfProbe/SidebarPerfProbeMonitorTab';
import SidebarPerfProbeTogglesTab from '@/features/sidebar/components/perfProbe/SidebarPerfProbeTogglesTab';
import SidebarPerfProbeTuningTab from '@/features/sidebar/components/perfProbe/SidebarPerfProbeTuningTab';
import SidebarPerfProbeLogsTab from '@/features/sidebar/components/perfProbe/SidebarPerfProbeLogsTab';
import SidebarPerfProbeConnectionsTab from '@/features/sidebar/components/perfProbe/SidebarPerfProbeConnectionsTab';
import { resetPerfProbeFlags, type PerfProbeFlags } from '@/lib/perf/perfFlags';
import { clearPerfLiveOverlayPins } from '@/lib/perf/perfOverlayPins';
import { resetPerfOverlayAppearance } from '@/lib/perf/perfOverlayAppearance';
import { resetPerfOverlayMode } from '@/lib/perf/perfOverlayMode';

type TabId = 'monitor' | 'connections' | 'toggles' | 'tuning' | 'logs';

interface Props {
  open: boolean;
  onClose: () => void;
  perfFlags: PerfProbeFlags;
  hotCacheEnabled: boolean;
  setHotCacheEnabled: (v: boolean) => void;
  normalizationEngine: string;
  setNormalizationEngine: (v: 'off' | 'loudness') => void;
  loggingMode: string;
  setLoggingMode: (v: 'off' | 'normal') => void;
}

export default function SidebarPerfProbeModal({
  open,
  onClose,
  perfFlags,
  hotCacheEnabled,
  setHotCacheEnabled,
  normalizationEngine,
  setNormalizationEngine,
  loggingMode,
  setLoggingMode,
}: Props) {
  const [tab, setTab] = useState<TabId>('monitor');

  if (!open) return null;

  const resetAll = () => {
    resetPerfProbeFlags();
    clearPerfLiveOverlayPins();
    resetPerfOverlayAppearance();
    resetPerfOverlayMode();
  };

  return createPortal(
    <div
      className="modal-overlay modal-overlay--perf-probe"
      onClick={() => onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="psylab-title"
    >
      <div
        className="modal-content sidebar-perf-modal"
        onClick={e => e.stopPropagation()}
      >
        <button type="button" className="modal-close" onClick={() => onClose()} aria-label="Close">
          <X size={18} />
        </button>

        <header className="sidebar-perf-modal__header">
          <h3 id="psylab-title" className="modal-title">PsyLab</h3>
          <p className="sidebar-perf-modal__hint">
            Live metrics, server connections, runtime tuning, and diagnostic disable toggles.
          </p>
        </header>

        <div className="sidebar-perf-modal__tabs" role="tablist" aria-label="PsyLab sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'monitor'}
            className={`sidebar-perf-modal__tab${tab === 'monitor' ? ' sidebar-perf-modal__tab--active' : ''}`}
            onClick={() => setTab('monitor')}
          >
            <Activity size={15} />
            Monitor
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connections'}
            className={`sidebar-perf-modal__tab${tab === 'connections' ? ' sidebar-perf-modal__tab--active' : ''}`}
            onClick={() => setTab('connections')}
          >
            <Network size={15} />
            Connections
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'toggles'}
            className={`sidebar-perf-modal__tab${tab === 'toggles' ? ' sidebar-perf-modal__tab--active' : ''}`}
            onClick={() => setTab('toggles')}
          >
            <SlidersHorizontal size={15} />
            Toggles
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tuning'}
            className={`sidebar-perf-modal__tab${tab === 'tuning' ? ' sidebar-perf-modal__tab--active' : ''}`}
            onClick={() => setTab('tuning')}
          >
            <Wrench size={15} />
            Tuning
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'logs'}
            className={`sidebar-perf-modal__tab${tab === 'logs' ? ' sidebar-perf-modal__tab--active' : ''}`}
            onClick={() => setTab('logs')}
          >
            <ScrollText size={15} />
            Logs
          </button>
        </div>

        <div className={`sidebar-perf-modal__body${tab === 'logs' ? ' sidebar-perf-modal__body--logs' : ''}`}>
          {tab === 'monitor' && <SidebarPerfProbeMonitorTab />}
          {tab === 'connections' && <SidebarPerfProbeConnectionsTab />}
          {tab === 'tuning' && <SidebarPerfProbeTuningTab />}
          {tab === 'toggles' && (
            <SidebarPerfProbeTogglesTab
              perfFlags={perfFlags}
              hotCacheEnabled={hotCacheEnabled}
              setHotCacheEnabled={setHotCacheEnabled}
              normalizationEngine={normalizationEngine}
              setNormalizationEngine={setNormalizationEngine}
              loggingMode={loggingMode}
              setLoggingMode={setLoggingMode}
            />
          )}
          {tab === 'logs' && <SidebarPerfProbeLogsTab />}
        </div>

        <div className="sidebar-perf-modal__actions">
          <button type="button" className="btn btn-ghost" onClick={resetAll}>
            Reset all
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onClose()}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
