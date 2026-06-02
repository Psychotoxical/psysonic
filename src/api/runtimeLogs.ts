import { invoke } from '@tauri-apps/api/core';
import type { LoggingMode } from '../store/authStoreTypes';

export interface RuntimeLogLine {
  seq: number;
  text: string;
}

export interface RuntimeLogTail {
  lines: RuntimeLogLine[];
  lastSeq: number;
  dropped: boolean;
}

/**
 * Incremental tail of the backend runtime log ring buffer.
 *
 * @param afterSeq highest seq already held by the caller; omit/`null` for the
 *   initial fetch of the most recent `max` lines.
 * @param max cap on returned lines (most recent kept).
 */
export async function tailRuntimeLogs(
  afterSeq: number | null,
  max: number,
): Promise<RuntimeLogTail> {
  return invoke<RuntimeLogTail>('tail_runtime_logs', {
    afterSeq: afterSeq ?? null,
    max,
  });
}

/** Read the current backend logging mode (off | normal | debug). */
export async function getLoggingMode(): Promise<LoggingMode> {
  const mode = await invoke<string>('get_logging_mode');
  return (mode === 'off' || mode === 'debug') ? mode : 'normal';
}
