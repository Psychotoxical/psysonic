import { useTranslation } from 'react-i18next';
import type { SmartEditorSession } from '@/features/playlist/utils/smartPlaylistEditor';
import {
  type SmartRuleValidationIssue,
} from '@/features/playlist/utils/smartPlaylistRules';

interface Props {
  session: SmartEditorSession;
  onDraftChange: (json: string) => void;
  onApply: () => void;
  jsonError: string | null;
  issues: SmartRuleValidationIssue[];
}

export default function PlaylistsSmartEditorJson({
  session, onDraftChange, onApply, jsonError, issues,
}: Props) {
  const { t } = useTranslation();
  const blocking = issues.some(issue => issue.severity === 'error');
  const warningPaths = [...new Set(
    issues.filter(issue => issue.severity === 'warning').map(issue => issue.path),
  )];

  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
      <textarea
        className="input"
        aria-label={t('smartPlaylists.modeJson')}
        value={session.jsonDraft}
        onChange={event => onDraftChange(event.target.value)}
        rows={18}
        style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', width: '100%', resize: 'vertical' }}
      />
      {jsonError && (
        <div style={{ color: 'var(--danger, #c0392b)', fontSize: 12, marginTop: 'var(--space-2)' }}>
          {t('smartPlaylists.jsonInvalid')} {jsonError}
        </div>
      )}
      {issues.map(issue => (
        <div
          key={`${issue.path}-${issue.code}`}
          style={{
            color: issue.severity === 'error' ? 'var(--danger, #c0392b)' : 'var(--text-muted)',
            fontSize: 12,
            marginTop: 'var(--space-1)',
          }}
        >
          {issue.path}: {issue.message}
        </div>
      ))}
      {warningPaths.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
          {t('smartPlaylists.unsupportedPaths', { paths: warningPaths.join(', ') })}
        </div>
      )}
      <div style={{ marginTop: 'var(--space-3)' }}>
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={!!jsonError || blocking}>
          {t('smartPlaylists.applyJson')}
        </button>
      </div>
    </section>
  );
}
