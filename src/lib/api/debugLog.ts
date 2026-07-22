/**
 * Tiny typed facade over the generated `frontend_debug_log` command — a
 * best-effort debug sink (Settings → Logging → Debug → Rust log buffer) used
 * from a handful of instrumentation helpers across the app. The command is
 * `Result`-wrapped, so the generated binding would leak a rejection to an
 * unhandled promise on a fire-and-forget call; the `.catch` swallows it,
 * matching the prior `void invoke(...).catch(() => {})` call sites. Calls that
 * omit `depth` remain level 1 for backward compatibility.
 */
import { commands } from '@/generated/bindings';
import {
  isDebugLoggingDepthEnabled,
  type DebugLoggingDepth,
} from '@/lib/perf/debugLoggingMode';

export function frontendDebugLog(
  scope: string,
  message: string,
  depth: DebugLoggingDepth = 1,
): void {
  if (!isDebugLoggingDepthEnabled(depth)) return;
  void commands.frontendDebugLog(scope, message).catch(() => {});
}
