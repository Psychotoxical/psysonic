// Shared types for the shortcut-action subsystem. The contract overview lives
// in the barrel, `shortcutActions.ts`.

export type TranslateLike = (key: string, options?: any) => string;

/** One bindable slot (in-app OR global). `defaultBinding` is the out-of-box
 * chord, or `null` for "unbound by default". `hidden` keeps the action out of
 * the Settings shortcut-list UI (still bindable / dispatchable). */
export type ShortcutSlot = { defaultBinding: string | null; hidden?: boolean };

/** Passed to an action's `run`. `previewPolicy` decides whether an active
 * track-preview is interrupted: 'stop' for explicit UI / in-app keys, 'ignore'
 * for hardware media keys. */
export type ActionContext = {
  navigate: (to: string, options?: any) => void;
  previewPolicy: 'stop' | 'ignore';
};

/** Passed to `executeCliPlayerCommand` — the raw `cli:player-command` payload
 * plus a navigate fn. */
export type CliContext = {
  navigate: (to: string, options?: any) => void;
  payload: any;
};

/** Registry entry for one shortcut action. `inApp` / `global` /
 * `runInMiniWindow` are the three independent trigger surfaces; `cli` and
 * `run` are surface-independent. See the contract block in `shortcutActions.ts`. */
export type ShortcutActionMeta = {
  /** Localized display label for the Settings UI. */
  getLabel: (t: TranslateLike) => string;
  /** Present ⇒ bindable to a main-window keyboard chord (id becomes a `KeyAction`). */
  inApp?: ShortcutSlot;
  /** Present ⇒ registrable as an OS-level global hotkey (id becomes a `GlobalAction`). */
  global?: ShortcutSlot;
  /** Whether the action may run when triggered from the mini-player window. */
  runInMiniWindow: boolean;
  /** The handler. */
  run: (ctx: ActionContext) => void;
  /** Present ⇒ exposed to `psysonic --player <verb>`. `command` overrides the
   * CLI verb used for no-arg dispatch (defaults to the action id). */
  cli?: { verb: string; description: string; command?: string };
};
