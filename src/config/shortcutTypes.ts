export type TranslateLike = (key: string, options?: any) => string;

export type ShortcutSlot = { defaultBinding: string | null; hidden?: boolean };

export type ActionContext = {
  navigate: (to: string, options?: any) => void;
  previewPolicy: 'stop' | 'ignore';
};

export type CliContext = {
  navigate: (to: string, options?: any) => void;
  payload: any;
};

export type ShortcutActionMeta = {
  getLabel: (t: TranslateLike) => string;
  inApp?: ShortcutSlot;
  global?: ShortcutSlot;
  runInMiniWindow: boolean;
  run: (ctx: ActionContext) => void;
  cli?: { verb: string; description: string; command?: string };
};
