// Barrel for the shortcut-action subsystem. Split into:
//   shortcutTypes.ts            — shared types
//   shortcutActionRegistry.ts   — SHORTCUT_ACTION_REGISTRY + action id types
//   shortcutDispatch.ts         — runtime + CLI dispatch
//   shortcutBindings.ts         — derived in-app / global binding tables
// Existing call sites import from this module unchanged.

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
