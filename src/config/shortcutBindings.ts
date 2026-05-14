import type { ShortcutSlot } from './shortcutTypes';
import {
  SHORTCUT_ACTION_REGISTRY,
  type ShortcutAction,
  type KeyAction,
  type GlobalAction,
} from './shortcutActionRegistry';

const ALL_IN_APP_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is KeyAction => 'inApp' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => {
    const inApp = SHORTCUT_ACTION_REGISTRY[action].inApp as ShortcutSlot;
    return {
      id: action,
      getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
      defaultBinding: inApp.defaultBinding,
      hidden: inApp.hidden === true,
    };
  });

export const IN_APP_SHORTCUT_ACTIONS = ALL_IN_APP_SHORTCUT_ACTIONS.filter(action => !action.hidden);

export const GLOBAL_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is GlobalAction => 'global' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => ({
    id: action,
    getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
    defaultBinding: SHORTCUT_ACTION_REGISTRY[action].global.defaultBinding,
  }));

export const DEFAULT_IN_APP_BINDINGS = Object.fromEntries(
  ALL_IN_APP_SHORTCUT_ACTIONS.map(action => [action.id, action.defaultBinding])
) as Record<KeyAction, string | null>;

export const DEFAULT_GLOBAL_SHORTCUTS: Partial<Record<GlobalAction, string>> = {};
for (const action of GLOBAL_SHORTCUT_ACTIONS) {
  if (action.defaultBinding !== null) {
    DEFAULT_GLOBAL_SHORTCUTS[action.id] = action.defaultBinding;
  }
}
