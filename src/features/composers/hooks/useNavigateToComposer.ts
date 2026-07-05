import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigateToComposerDetail } from '@/lib/navigation/albumDetailNavigation';

/** Navigate to composer detail, remembering the current page for the back button. */
export function useNavigateToComposer() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (composerId: string, opts?: { search?: string }) => {
      navigateToComposerDetail(navigate, location, composerId, opts);
    },
    [navigate, location],
  );
}
