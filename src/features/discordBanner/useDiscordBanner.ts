import { useState } from 'react';
import { useAuthStore } from '@/store/authStore';

const USAGE_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20 hours

interface UseDiscordBannerReturn {
  visible: boolean;
  dismiss: (permanent: boolean) => void;
}

export function useDiscordBanner(): UseDiscordBannerReturn {
  const dismissedPermanently = useAuthStore(s => s.discordBannerDismissed);
  const usageMs = useAuthStore(s => s.discordBannerAccumulatedUsageMs);
  const dismissDiscordBanner = useAuthStore(s => s.dismissDiscordBanner);
  const [sessionDismissed, setSessionDismissed] = useState(false);

  const visible = !dismissedPermanently && !sessionDismissed && usageMs >= USAGE_THRESHOLD_MS;

  const dismiss = (permanent: boolean): void => {
    if (permanent) dismissDiscordBanner();
    setSessionDismissed(true);
  };

  return { visible, dismiss };
}
