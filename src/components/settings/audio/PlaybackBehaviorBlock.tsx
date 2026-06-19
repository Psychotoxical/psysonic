import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import { SettingsGroup } from '../SettingsGroup';
import { SettingsToggle } from '../SettingsToggle';

interface Props {
  t: TFunction;
}

/**
 * Queue-behaviour settings. Currently just the independent
 * `preservePlayNextOrder` toggle, grouped under its own "Queue behaviour"
 * heading. (Track transitions and Normalization are now their own top-level
 * Audio categories; this block is slated to move to the Personalisation tab.)
 */
export function PlaybackBehaviorBlock({ t }: Props) {
  const auth = useAuthStore();

  return (
    <SettingsGroup title={t('settings.queueBehaviourTitle')}>
      <SettingsToggle
        label={t('settings.preservePlayNextOrder')}
        desc={t('settings.preservePlayNextOrderDesc')}
        checked={auth.preservePlayNextOrder}
        onChange={auth.setPreservePlayNextOrder}
      />
    </SettingsGroup>
  );
}
