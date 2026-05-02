export type TranslateLike = (key: string, options?: any) => string;
type ShortcutSlot = {
  defaultBinding: string | null;
};

type ShortcutActionMeta = {
  getLabel: (t: TranslateLike) => string;
  inApp?: ShortcutSlot;
  global?: ShortcutSlot;
  runInMiniWindow: boolean;
  cli?: {
    verb: string;
    description: string;
    command?: string;
  };
};

export const SHORTCUT_ACTION_REGISTRY = {
  'play-pause': {
    getLabel: t => t('settings.shortcutPlayPause'),
    inApp: { defaultBinding: 'Space' },
    global: { defaultBinding: null },
    runInMiniWindow: true,
  },
  next: {
    getLabel: t => t('settings.shortcutNext'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: true,
    cli: { verb: 'next', description: 'next track' },
  },
  prev: {
    getLabel: t => t('settings.shortcutPrev'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: true,
    cli: { verb: 'prev', description: 'previous track' },
  },
  'volume-up': {
    getLabel: t => t('settings.shortcutVolumeUp'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'volume-down': {
    getLabel: t => t('settings.shortcutVolumeDown'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'seek-forward': {
    getLabel: t => t('settings.shortcutSeekForward'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'seek-backward': {
    getLabel: t => t('settings.shortcutSeekBackward'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'toggle-queue': {
    getLabel: t => t('settings.shortcutToggleQueue'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'open-folder-browser': {
    getLabel: t => t('settings.shortcutOpenFolderBrowser', { folderBrowser: t('sidebar.folderBrowser') }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'fullscreen-player': {
    getLabel: t => t('settings.shortcutFullscreenPlayer'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
  },
  'native-fullscreen': {
    getLabel: t => t('settings.shortcutNativeFullscreen'),
    inApp: { defaultBinding: 'F11' },
    runInMiniWindow: false,
  },
  'open-mini-player': {
    getLabel: t => t('settings.shortcutOpenMiniPlayer'),
    inApp: { defaultBinding: null },
    runInMiniWindow: true,
  },
} as const satisfies Record<string, ShortcutActionMeta>;

export type ShortcutAction = keyof typeof SHORTCUT_ACTION_REGISTRY;
export type KeyAction = {
  [Action in ShortcutAction]: (typeof SHORTCUT_ACTION_REGISTRY)[Action] extends { inApp: ShortcutSlot } ? Action : never
}[ShortcutAction];
export type GlobalAction = {
  [Action in ShortcutAction]: (typeof SHORTCUT_ACTION_REGISTRY)[Action] extends { global: ShortcutSlot } ? Action : never
}[ShortcutAction];

export function isShortcutAction(action: string): action is ShortcutAction {
  return action in SHORTCUT_ACTION_REGISTRY;
}

export function isGlobalShortcutActionId(action: string): action is GlobalAction {
  return isShortcutAction(action) && 'global' in SHORTCUT_ACTION_REGISTRY[action];
}

export function canRunShortcutActionInMiniWindow(action: ShortcutAction): boolean {
  return SHORTCUT_ACTION_REGISTRY[action].runInMiniWindow;
}

export const IN_APP_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is KeyAction => 'inApp' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => ({
    id: action,
    getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
    defaultBinding: SHORTCUT_ACTION_REGISTRY[action].inApp.defaultBinding,
  }));

export const GLOBAL_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is GlobalAction => 'global' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => ({
    id: action,
    getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
    defaultBinding: SHORTCUT_ACTION_REGISTRY[action].global.defaultBinding,
  }));

export const DEFAULT_IN_APP_BINDINGS = Object.fromEntries(
  IN_APP_SHORTCUT_ACTIONS.map(action => [action.id, action.defaultBinding])
) as Record<KeyAction, string | null>;

export const DEFAULT_GLOBAL_SHORTCUTS: Partial<Record<GlobalAction, string>> = {};
for (const action of GLOBAL_SHORTCUT_ACTIONS) {
  if (action.defaultBinding !== null) {
    DEFAULT_GLOBAL_SHORTCUTS[action.id] = action.defaultBinding;
  }
}
