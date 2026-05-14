// ─── Shortcut-action subsystem ───────────────────────────────────────────────
//
// Barrel + contract reference. Split into:
//   shortcutTypes.ts            — shared types
//   shortcutActionRegistry.ts   — SHORTCUT_ACTION_REGISTRY + action id types
//   shortcutDispatch.ts         — runtime + CLI dispatch
//   shortcutBindings.ts         — derived in-app / global binding tables
// Existing call sites import from this module unchanged.
//
// ── The contract ─────────────────────────────────────────────────────────────
//
// Every shortcut action is one entry in `SHORTCUT_ACTION_REGISTRY`, keyed by a
// stable id (`ShortcutAction`). Its `ShortcutActionMeta` declares which of three
// independent *trigger surfaces* the action is exposed on — an action may opt
// into any combination:
//
//   • inApp?   — bindable to a keyboard chord while the MAIN window is focused.
//                Presence of the `inApp` slot makes the id a `KeyAction`; the
//                slot's `defaultBinding` is the out-of-box chord (or null =
//                unbound), `hidden` keeps it out of the Settings UI list.
//                Surfaced via IN_APP_SHORTCUT_ACTIONS / DEFAULT_IN_APP_BINDINGS;
//                matched at runtime by `shortcuts/runtime.ts`.
//   • global?  — registrable as an OS-LEVEL global hotkey (fires even when the
//                app is unfocused). Presence makes the id a `GlobalAction`;
//                surfaced via GLOBAL_SHORTCUT_ACTIONS / DEFAULT_GLOBAL_SHORTCUTS.
//                `isGlobalShortcutActionId` is the runtime guard.
//   • runInMiniWindow — whether the action may run when triggered FROM the
//                mini-player window. `canRunShortcutActionInMiniWindow` gates
//                cross-window `shortcut:run-action` events.
//
// Two extra, surface-independent fields:
//   • cli?     — exposes the action to `psysonic --player <verb>`. No-arg CLI
//                verbs are auto-collected and dispatched by
//                `executeCliPlayerCommand`; arg-carrying commands (play-id,
//                seek-relative, set-volume, set-repeat, set-rating-current)
//                are handled explicitly there.
//   • run(ctx) — the handler. `ctx.previewPolicy` ('stop' | 'ignore') decides
//                whether an active track-preview is interrupted: media keys
//                pass 'ignore', explicit UI / in-app keys pass 'stop'.
//
// Dispatch entry points: `executeRuntimeAction` (any trigger surface) and
// `executeCliPlayerCommand` (CLI). `isShortcutAction` validates an arbitrary
// string against the registry.

export type {
  TranslateLike,
  ShortcutSlot,
  ActionContext,
  CliContext,
  ShortcutActionMeta,
} from './shortcutTypes';

export {
  SHORTCUT_ACTION_REGISTRY,
  type ShortcutAction,
  type KeyAction,
  type GlobalAction,
} from './shortcutActionRegistry';

export {
  isShortcutAction,
  isGlobalShortcutActionId,
  canRunShortcutActionInMiniWindow,
  executeRuntimeAction,
  executeCliPlayerCommand,
  type RuntimeAction,
} from './shortcutDispatch';

export {
  IN_APP_SHORTCUT_ACTIONS,
  GLOBAL_SHORTCUT_ACTIONS,
  DEFAULT_IN_APP_BINDINGS,
  DEFAULT_GLOBAL_SHORTCUTS,
} from './shortcutBindings';
