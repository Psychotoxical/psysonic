import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Copy, Download, Pause, Play, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { getLoggingMode, tailRuntimeLogs, type RuntimeLogLine } from '../../../api/runtimeLogs';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../../store/authStore';
import type { LoggingMode } from '../../../store/authStoreTypes';
import CustomSelect from '../../CustomSelect';
import { filterLogLines } from '../../../utils/perf/filterLogLines';
import { sanitizeLogLine } from '../../../utils/perf/sanitizeLogLine';

function formatLogLinesText(lines: RuntimeLogLine[]): string {
  return lines.map(line => line.text).join('\n');
}

const POLL_MS = 750;
const BOTTOM_EPSILON = 24;
// Hard ceiling for the in-view buffer while the user has scrolled up (so history
// they are reading is not trimmed away). Matches the backend ring buffer size.
const MAX_BUFFER = 20_000;
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
  const [overflowed, setOverflowed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [exporting, setExporting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const lastSeqRef = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  const lineCapRef = useRef(lineCap);
  const followRef = useRef(follow);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Topmost visible line to re-pin against while the user is scrolled up, so the
  // view stays put even as new lines append below or old ones scroll out.
  const anchorRef = useRef<{ seq: number; offset: number } | null>(null);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  pausedRef.current = paused;
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  lineCapRef.current = lineCap;
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  followRef.current = follow;

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
          // While following, request only the visible cap; while scrolled up,
          // pull up to the hard ceiling so read-back history is preserved.
          const fetchMax = followRef.current ? lineCapRef.current : MAX_BUFFER;
          const tail = await tailRuntimeLogs(lastSeqRef.current, fetchMax);
          if (!cancelled && tail.dropped) setOverflowed(true);
          if (!cancelled && tail.lines.length > 0) {
            lastSeqRef.current = tail.lastSeq;
            setLines(prev => {
              const next = [
                ...prev,
                ...tail.lines.map(line => ({
                  ...line,
                  text: sanitizeLogLine(line.text),
                })),
              ];
              // Only trim from the top while following; otherwise keep history
              // under the reader's viewport up to the hard ceiling.
              const cap = followRef.current ? lineCapRef.current : MAX_BUFFER;
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

  // When following resumes (or the cap shrinks), trim retained history to the cap.
  useEffect(() => {
    if (!follow) return;
    // React Compiler set-state-in-effect rule: state set from a DOM/layout measurement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(prev => (prev.length > lineCap ? prev.slice(prev.length - lineCap) : prev));
  }, [follow, lineCap]);

  // Keep the view pinned: stick to the bottom while following, otherwise re-pin
  // the previously-topmost line so the reader's position holds as lines append.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const node = el.querySelector<HTMLElement>(`[data-seq="${anchor.seq}"]`);
    if (node) el.scrollTop = node.offsetTop - anchor.offset;
  }, [visible, follow]);

  const captureAnchor = (el: HTMLElement) => {
    const top = el.scrollTop;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      if (child.dataset.seq == null) continue;
      if (child.offsetTop + child.offsetHeight > top + 1) {
        anchorRef.current = { seq: Number(child.dataset.seq), offset: child.offsetTop - top };
        return;
      }
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_EPSILON;
    if (!atBottom) captureAnchor(el);
    if (atBottom !== followRef.current) setFollow(atBottom);
  };

  const jumpToLatest = () => {
    anchorRef.current = null;
    setFollow(true);
  };

  const changeDepth = (mode: LoggingMode) => {
    setLoggingMode(mode);
    void invoke('set_logging_mode', { mode }).catch(() => {});
  };

  const clear = () => {
    setLines([]);
    setOverflowed(false);
  };

  const selectedLogText = useCallback(() => {
    const el = scrollRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return '';
    return sel.toString();
  }, []);

  const copyText = async (text: string, feedback = true) => {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      if (feedback) setCopyState('ok');
      return true;
    } catch {
      if (feedback) setCopyState('error');
      return false;
    } finally {
      if (feedback) window.setTimeout(() => setCopyState('idle'), 1600);
    }
  };

  const copyAllShown = () => copyText(formatLogLinesText(visible));

  const copySelection = () => copyText(selectedLogText(), false);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, closeContextMenu]);

  const onLogContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const selected = selectedLogText().trim();
    if (!selected) return;
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const exportVisible = async () => {
    if (visible.length === 0 || exporting) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const selected = await saveDialog({
      defaultPath: `psysonic-psylab-logs-${stamp}.log`,
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
      title: 'Export shown log lines',
    });
    if (!selected || Array.isArray(selected)) return;
    setExporting(true);
    try {
      const bytes = new TextEncoder().encode(`${formatLogLinesText(visible)}\n`);
      await writeFile(selected, bytes);
    } catch {
      /* user cancelled or write failed */
    } finally {
      setExporting(false);
    }
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
        <button
          type="button"
          className="perf-logs__btn"
          onClick={() => void copyAllShown()}
          disabled={visible.length === 0}
          title="Copy all lines currently shown in the log view"
        >
          <Copy size={14} />
          {copyState === 'ok' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
        </button>
        <button
          type="button"
          className="perf-logs__btn"
          onClick={() => void exportVisible()}
          disabled={visible.length === 0 || exporting}
          title="Export shown lines to a file"
        >
          <Download size={14} />
          {exporting ? 'Exporting…' : 'Export'}
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
        onContextMenu={onLogContextMenu}
        role="log"
        aria-live="off"
        data-selectable
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
          visible.map(line => (
            <div key={line.seq} data-seq={line.seq} className="perf-logs__line">
              {line.text}
            </div>
          ))
        )}
      </div>

      <div className="perf-logs__status">
        <span>
          {visible.length.toLocaleString()} shown · {lines.length.toLocaleString()} buffered
          {overflowed && ' · buffer overflowed (oldest dropped)'}
        </span>
        {!follow && (
          <button
            type="button"
            className="perf-logs__jump"
            onClick={jumpToLatest}
          >
            Jump to latest
          </button>
        )}
      </div>

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="context-menu perf-logs__context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={e => e.preventDefault()}
        >
          <button
            type="button"
            className="context-menu-item perf-logs__context-item"
            onClick={() => {
              void copySelection();
              closeContextMenu();
            }}
          >
            <Copy size={14} />
            Copy
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
