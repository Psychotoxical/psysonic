import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Infinity as InfinityIcon } from 'lucide-react';
import PlaylistsSmartRuleGroup from '@/features/playlist/components/PlaylistsSmartRuleGroup';
import PlaylistsSmartSortRows from '@/features/playlist/components/PlaylistsSmartSortRows';
import {
  type SmartPlaylistCapabilities,
  type SmartRuleFieldDefinition,
} from '@/features/playlist/utils/smartPlaylistFields';
import { defaultSmartRuleGroup } from '@/features/playlist/utils/smartPlaylistEditor';
import {
  parseSmartRulesDocument,
  removeSmartRuleValue,
  setSmartRuleValue,
  type SmartRuleValidationIssue,
  type SmartRulesDocument,
} from '@/features/playlist/utils/smartPlaylistRules';

interface PlaylistOption {
  id: string;
  name: string;
}

interface Props {
  document: SmartRulesDocument;
  onDocumentChange: (document: SmartRulesDocument) => void;
  capabilities: SmartPlaylistCapabilities;
  customFields: SmartRuleFieldDefinition[];
  playlistOptions: PlaylistOption[];
  genreSuggestions?: readonly string[];
  issues?: readonly SmartRuleValidationIssue[];
}

function issueSeverityClass(issues: readonly SmartRuleValidationIssue[]): string {
  if (issues.some(issue => issue.severity === 'error')) return 'smart-query-has-error';
  if (issues.length > 0) return 'smart-query-has-warning';
  return '';
}

export default function PlaylistsSmartEditorAdvanced({
  document, onDocumentChange, capabilities, customFields, playlistOptions,
  genreSuggestions = [], issues = [],
}: Props) {
  const { t } = useTranslation();
  const hasLimit = typeof document.raw.limit === 'number';
  const hasPercent = typeof document.raw.limitPercent === 'number';
  const [limitMode, setLimitModeState] = useState<'none' | 'limit' | 'limitPercent'>(
    hasPercent ? 'limitPercent' : hasLimit ? 'limit' : 'none',
  );
  const [countDraft, setCountDraft] = useState(
    hasLimit ? String(document.raw.limit) : '50',
  );
  const [percentDraft, setPercentDraft] = useState(
    hasPercent ? String(document.raw.limitPercent) : '25',
  );

  // Sync drafts with external document changes during render (React's
  // recommended alternative to setState-in-effect).
  const [prevLimit, setPrevLimit] = useState(document.raw.limit);
  const [prevLimitPercent, setPrevLimitPercent] = useState(document.raw.limitPercent);
  if (document.raw.limit !== prevLimit || document.raw.limitPercent !== prevLimitPercent) {
    setPrevLimit(document.raw.limit);
    setPrevLimitPercent(document.raw.limitPercent);
    if (hasPercent) setLimitModeState('limitPercent');
    else if (hasLimit) setLimitModeState('limit');
    else setLimitModeState('none');
    if (hasLimit) setCountDraft(String(document.raw.limit));
    if (hasPercent) setPercentDraft(String(document.raw.limitPercent));
  }

  const withoutLimits = () => {
    let next = document;
    if (hasLimit) next = removeSmartRuleValue(next, '/limit');
    if (hasPercent) next = removeSmartRuleValue(next, '/limitPercent');
    return next;
  };

  const setLimitMode = (mode: 'none' | 'limit' | 'limitPercent') => {
    setLimitModeState(mode);
    const next = withoutLimits();
    if (mode === 'none') {
      if (next !== document) onDocumentChange(next);
      return;
    }
    if (mode === 'limitPercent') {
      const clamped = Math.min(100, Math.max(1, Math.trunc(Number(percentDraft) || 25)));
      setPercentDraft(String(clamped));
      onDocumentChange(setSmartRuleValue(next, '/limitPercent', clamped));
      return;
    }
    const count = Math.max(1, Math.trunc(Number(countDraft) || 50));
    setCountDraft(String(count));
    onDocumentChange(setSmartRuleValue(next, '/limit', count));
  };

  const setCount = (raw: string) => {
    setCountDraft(raw);
    if (raw === '') {
      if (hasLimit) onDocumentChange(removeSmartRuleValue(document, '/limit'));
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onDocumentChange(setSmartRuleValue(document, '/limit', Math.max(1, Math.trunc(next))));
  };

  const setPercent = (raw: string) => {
    setPercentDraft(raw);
    if (raw === '') {
      if (hasPercent) onDocumentChange(removeSmartRuleValue(document, '/limitPercent'));
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    const clamped = Math.min(100, Math.max(1, Math.trunc(next)));
    setPercentDraft(String(clamped));
    onDocumentChange(setSmartRuleValue(document, '/limitPercent', clamped));
  };

  return (
    <div className="smart-query-editor">
      {document.root ? (
        <PlaylistsSmartRuleGroup
          node={document.root}
          document={document}
          onDocumentChange={onDocumentChange}
          capabilities={capabilities}
          customFields={customFields}
          playlistOptions={playlistOptions}
          genreSuggestions={genreSuggestions}
          issues={issues}
          isRoot
        />
      ) : (
        <div className="smart-query-group">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onDocumentChange(parseSmartRulesDocument({
              ...document.raw,
              all: (defaultSmartRuleGroup().all as unknown[]),
            }))}
          >
            {t('smartPlaylists.addRule')}
          </button>
        </div>
      )}
      <div className="smart-query-footer">
        <PlaylistsSmartSortRows
          document={document}
          onDocumentChange={onDocumentChange}
          capabilities={capabilities}
          customFields={customFields}
          issues={issues.filter(issue => issue.path === '/sort')}
        />
        <div className={`smart-query-limit ${issueSeverityClass(
          issues.filter(issue => issue.path === '/limit' || issue.path === '/limitPercent'),
        )}`}>
          <span className="smart-query-limit-label">{t('smartPlaylists.limit')}</span>
          <div className="smart-query-limit-controls">
            <div className="smart-query-limit-mode" role="group" aria-label={t('smartPlaylists.limit')}>
              <button
                type="button"
                className={`btn ${limitMode === 'limit' ? 'btn-primary' : 'btn-surface'}`}
                aria-label={t('smartPlaylists.limitCount')}
                aria-pressed={limitMode === 'limit'}
                onClick={() => setLimitMode('limit')}
              >
                #
              </button>
              {capabilities.percentageLimit && (
                <button
                  type="button"
                  className={`btn ${limitMode === 'limitPercent' ? 'btn-primary' : 'btn-surface'}`}
                  aria-label={t('smartPlaylists.limitPercent')}
                  aria-pressed={limitMode === 'limitPercent'}
                  onClick={() => setLimitMode('limitPercent')}
                >
                  %
                </button>
              )}
              <button
                type="button"
                className={`btn ${limitMode === 'none' ? 'btn-primary' : 'btn-surface'}`}
                aria-label={t('smartPlaylists.limitUnlimited')}
                aria-pressed={limitMode === 'none'}
                onClick={() => setLimitMode('none')}
              >
                <InfinityIcon size={14} />
              </button>
            </div>
            {limitMode === 'limitPercent' && (
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                aria-label={t('smartPlaylists.limitPercent')}
                title={t('smartPlaylists.limitPercentHint')}
                value={percentDraft === '' ? 1 : percentDraft}
                onChange={event => setPercent(event.target.value)}
              />
            )}
            {limitMode === 'limit' && (
              <input
                className="input"
                type="number"
                min={1}
                aria-label={t('smartPlaylists.limitCount')}
                value={countDraft}
                onChange={event => setCount(event.target.value)}
              />
            )}
            {limitMode === 'limitPercent' && (
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                aria-label={t('smartPlaylists.limitPercent')}
                value={percentDraft}
                onChange={event => setPercent(event.target.value)}
              />
            )}
          </div>
          {issues
            .filter(issue => issue.path === '/limit' || issue.path === '/limitPercent')
            .map(issue => (
              <div key={`${issue.path}-${issue.code}`} className={`smart-query-issue smart-query-issue-${issue.severity}`}>
                {issue.message}
              </div>
            ))}
        </div>
      </div>
      <details className="smart-query-more">
        <summary>{t('smartPlaylists.moreOptions')}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <label
            className={issueSeverityClass(issues.filter(issue => issue.path === '/offset')) || undefined}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
          >
            <span>{t('smartPlaylists.offset')}</span>
            <input
              className="input"
              type="number"
              min={0}
              value={typeof document.raw.offset === 'number' ? document.raw.offset : 0}
              onChange={event => {
                const offset = Number(event.target.value);
                if (!offset) {
                  if (Object.prototype.hasOwnProperty.call(document.raw, 'offset')) {
                    onDocumentChange(removeSmartRuleValue(document, '/offset'));
                  }
                  return;
                }
                onDocumentChange(setSmartRuleValue(document, '/offset', offset));
              }}
            />
            {issues.filter(issue => issue.path === '/offset').map(issue => (
              <span key={`${issue.path}-${issue.code}`} className={`smart-query-issue smart-query-issue-${issue.severity}`}>
                {issue.message}
              </span>
            ))}
          </label>
        </div>
      </details>
    </div>
  );
}
