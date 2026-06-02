import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Trash2 } from 'lucide-react';
import { getLoggingMode, tailRuntimeLogs, type RuntimeLogLine } from '../../../api/runtimeLogs';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../../store/authStore';
import type { LoggingMode } from '../../../store/authStoreTypes';
import CustomSelect from '../../CustomSelect';
import { filterLogLines } from '../../../utils/perf/filterLogLines';

const POLL_MS = 750;
const LINE_CAP_OPTIONS = [
  { value: '500', label: '500 lines' },
  { value: '1000', label: '1000 lines' },
  { value: '2000', label: '2000 lines' },
  { value: '5000', label: '5000 lines' },
];
const DEPTH_OPTIONS: { value: LoggingMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'normal', label: 'Normal' },
  { value: 'debug', label: 'Debug' },
];

/**
 * Live view of the backend runtime log buffer (the stdout/stderr lines that are
 * otherwise only visible in the launching terminal — unreachable on Windows).
 * Polls the ring buffer incrementally, with a depth switch, line cap, and an
 * ordered include/exclude word filter.
 */
export default function SidebarPerfProbeLogsTab() {
  const loggingMode = useAuthStore(s => s.loggingMode);
  const setLoggingMode = useAuthStore(s => s.setLoggingMode);

  const [lines, setLines] = useState<RuntimeLogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [lineCap, setLineCap] = useState(1000);
  const [follow, setFollow] = useState(true);

  const lastSeqRef = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  const lineCapRef = useRef(lineCap);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  pausedRef.current = paused;
  lineCapRef.current = lineCap;

  // Keep the backend mode readout in sync with reality on open.
  useEffect(() => {
    void getLoggingMode().then(mode => {
      if (mode !== loggingMode) setLoggingMode(mode);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (!pausedRef.current) {
        try {
          const cap = lineCapRef.current;
          const tail = await tailRuntimeLogs(lastSeqRef.current, cap);
          if (!cancelled && (tail.lines.length > 0 || tail.dropped)) {
            lastSeqRef.current = tail.lastSeq;
            setLines(prev => {
              const next = tail.dropped && prev.length > 0
                ? [...prev, { seq: -1, text: '— log buffer overflow: older lines dropped —' }, ...tail.lines]
                : [...prev, ...tail.lines];
              return next.length > cap ? next.slice(next.length - cap) : next;
            });
          } else if (!cancelled) {
            lastSeqRef.current = tail.lastSeq;
          }
        } catch {
          /* transient; retry next tick */
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const visible = useMemo(() => filterLogLines(lines, filter), [lines, filter]);

  // Auto-follow tail unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const changeDepth = (mode: LoggingMode) => {
    setLoggingMode(mode);
    void invoke('set_logging_mode', { mode }).catch(() => {});
  };

  const clear = () => {
    setLines([]);
  };

  return (
    <div className="perf-logs">
      <div className="perf-logs__controls">
        <label className="perf-logs__control">
          <span className="perf-logs__control-label">Depth</span>
          <CustomSelect
            value={loggingMode}
            onChange={v => changeDepth(v as LoggingMode)}
            options={DEPTH_OPTIONS}
          />
        </label>
        <label className="perf-logs__control">
          <span className="perf-logs__control-label">Keep</span>
          <CustomSelect
            value={String(lineCap)}
            onChange={v => setLineCap(Number(v))}
            options={LINE_CAP_OPTIONS}
          />
        </label>
        <button
          type="button"
          className="perf-logs__btn"
          onClick={() => setPaused(p => !p)}
          aria-pressed={paused}
          title={paused ? 'Resume live tail' : 'Pause live tail'}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="perf-logs__btn" onClick={clear} title="Clear view">
          <Trash2 size={14} />
          Clear
        </button>
      </div>

      <input
        type="text"
        className="perf-logs__filter"
        placeholder="Filter: word to include, -word to exclude, comma-separated (order matters)"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        spellCheck={false}
      />

      <div
        className="perf-logs__view"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
      >
        {visible.length === 0 ? (
          <div className="perf-logs__empty">
            {loggingMode === 'off'
              ? 'Logging is Off — set depth to Normal or Debug to capture lines.'
              : lines.length === 0
                ? 'Waiting for log lines…'
                : 'No lines match the current filter.'}
          </div>
        ) : (
          visible.map((line, i) => (
            <div
              key={line.seq < 0 ? `marker-${i}` : line.seq}
              className={`perf-logs__line${line.seq < 0 ? ' perf-logs__line--marker' : ''}`}
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      <div className="perf-logs__status">
        <span>{visible.length.toLocaleString()} shown · {lines.length.toLocaleString()} buffered</span>
        {!follow && (
          <button
            type="button"
            className="perf-logs__jump"
            onClick={() => { setFollow(true); }}
          >
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
