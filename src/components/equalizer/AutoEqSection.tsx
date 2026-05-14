import { useTranslation } from 'react-i18next';
import { Search, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useAutoEq } from '../../hooks/useAutoEq';

/** Collapsible AutoEQ search panel inside the Equalizer. Owns its own search
 * state via {@link useAutoEq}. */
export default function AutoEqSection() {
  const { t } = useTranslation();
  const {
    autoEqOpen, autoEqQuery, autoEqResults, autoEqLoading, autoEqError, autoEqApplied,
    entriesLoading, setAutoEqQuery, setAutoEqError, setAutoEqResults,
    applyAutoEqResult, toggleOpen,
  } = useAutoEq();

  return (
    <div className="eq-autoeq-section">
      <button className="eq-autoeq-toggle" onClick={toggleOpen}>
        <Search size={13} />
        <span>{t('settings.eqAutoEqTitle')}</span>
        {autoEqOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {autoEqOpen && (
        <div className="eq-autoeq-body">
          <div className="eq-autoeq-search-row">
            <input
              className="input"
              placeholder={t('settings.eqAutoEqPlaceholder')}
              value={autoEqQuery}
              onChange={e => { setAutoEqQuery(e.target.value); setAutoEqError(null); }}
              autoFocus
              style={{ flex: 1, padding: '6px 12px', fontSize: 13 }}
            />
            {autoEqQuery && (
              <button className="eq-ctrl-btn" onClick={() => { setAutoEqQuery(''); setAutoEqResults([]); }}>
                <X size={13} />
              </button>
            )}
          </div>

          {(entriesLoading || autoEqLoading) && (
            <div className="eq-autoeq-status">{t('settings.eqAutoEqSearching')}</div>
          )}
          {autoEqError && (
            <div className="eq-autoeq-status eq-autoeq-error">{autoEqError}</div>
          )}
          {autoEqApplied && (
            <div className="eq-autoeq-status eq-autoeq-applied">✓ {autoEqApplied}</div>
          )}

          {autoEqResults.length > 0 && (
            <div className="eq-autoeq-results">
              {autoEqResults.map((r, i) => (
                <button
                  key={`${r.name}|${r.source}|${i}`}
                  className="eq-autoeq-result-btn"
                  onClick={() => applyAutoEqResult(r)}
                >
                  <span>{r.name}</span>
                  <span className="eq-autoeq-result-source">{r.source}</span>
                </button>
              ))}
            </div>
          )}

          {!entriesLoading && !autoEqLoading && !autoEqError && autoEqQuery.length >= 2 && autoEqResults.length === 0 && (
            <div className="eq-autoeq-status">{t('settings.eqAutoEqNoResults')}</div>
          )}
        </div>
      )}
    </div>
  );
}
