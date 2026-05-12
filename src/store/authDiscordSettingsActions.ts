import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

export function createDiscordSettingsActions(set: SetState): Pick<
  AuthState,
  | 'setDiscordRichPresence'
  | 'setDiscordCoverSource'
  | 'setEnableBandsintown'
  | 'setDiscordTemplateDetails'
  | 'setDiscordTemplateState'
  | 'setDiscordTemplateLargeText'
> {
  return {
    setDiscordRichPresence: (v) => set({ discordRichPresence: v }),
    setDiscordCoverSource: (v) => set({ discordCoverSource: v }),
    setEnableBandsintown: (v) => set({ enableBandsintown: v }),
    setDiscordTemplateDetails: (v) => set({ discordTemplateDetails: v }),
    setDiscordTemplateState: (v) => set({ discordTemplateState: v }),
    setDiscordTemplateLargeText: (v) => set({ discordTemplateLargeText: v }),
  };
}
