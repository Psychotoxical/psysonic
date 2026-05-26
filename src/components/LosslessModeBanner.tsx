import { Gem } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

export default function LosslessModeBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleExit = () => {
    const params = new URLSearchParams(location.search);
    params.delete('lossless');
    const qs = params.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '' }, { replace: true });
  };

  return (
    <div className="lossless-mode-banner" role="status">
      <Gem size={16} aria-hidden className="lossless-mode-banner__icon" />
      <span>{t('losslessAlbums.modeBanner')}</span>
      <button type="button" className="btn btn-ghost lossless-mode-banner__exit" onClick={handleExit}>
        {t('losslessAlbums.modeBannerExit')}
      </button>
    </div>
  );
}
