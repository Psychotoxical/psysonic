/**
 * Tiny typed facade over the generated `frontend_debug_log` command — a
 * best-effort debug sink (Settings → Logging → Debug → Rust log buffer) used
 * from a handful of instrumentation helpers across the app. The command is
 * `Result`-wrapped, so the generated binding would leak a rejection to an
 * unhandled promise on a fire-and-forget call; the `.catch` swallows it,
 * matching the prior `void invoke(...).catch(() => {})` call sites.
 */
import { commands } from '@/generated/bindings';

export function frontendDebugLog(scope: string, message: string): void {
  void commands.frontendDebugLog(scope, message).catch(() => {});
}
