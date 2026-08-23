import { useTranslation } from 'react-i18next';
import { Minus, Plus } from 'lucide-react';
import CustomSelect from '@/ui/CustomSelect';
import PlaylistsSmartFieldPicker from '@/features/playlist/components/PlaylistsSmartFieldPicker';
import {
  emitSmartSortRows,
  parseSmartSortRows,
  type SmartSortRow,
} from '@/features/playlist/utils/smartPlaylistEditor';
import {
  parseSmartRulesDocument,
  removeSmartRuleValue,
  setSmartRuleValue,
  type SmartRuleValidationIssue,
  type SmartRulesDocument,
} from '@/features/playlist/utils/smartPlaylistRules';
import type { SmartPlaylistCapabilities, SmartRuleFieldDefinition } from '@/features/playlist/utils/smartPlaylistFields';

interface Props {
  document: SmartRulesDocument;
  onDocumentChange: (document: SmartRulesDocument) => void;
  capabilities: SmartPlaylistCapabilities;
  customFields: readonly SmartRuleFieldDefinition[];
  issues?: readonly SmartRuleValidationIssue[];
}

export default function PlaylistsSmartSortRows({
  document, onDocumentChange, capabilities, customFields, issues = [],
}: Props) {
  const { t } = useTranslation();
  const rows = parseSmartSortRows(document.raw.sort);
  const canAdd = capabilities.multiSort || rows.length === 0;
  const displayRows = rows.length > 0 ? rows : [{ field: 'album', direction: '+' as const }];

  const commit = (nextRows: SmartSortRow[]) => {
    const sort = emitSmartSortRows(nextRows);
    if (!sort) {
      if (Object.prototype.hasOwnProperty.call(document.raw, 'sort')) {
        onDocumentChange(removeSmartRuleValue(document, '/sort'));
      }
      return;
    }
    onDocumentChange(setSmartRuleValue(document, '/sort', sort));
  };

  return (
    <div className={`smart-query-sorts ${
      issues.some(issue => issue.severity === 'error')
        ? 'smart-query-has-error'
        : issues.length > 0 ? 'smart-query-has-warning' : ''
    }`}>
      <div className="smart-query-sorts-head">
        <span>{t('smartPlaylists.sortRows')}</span>
        <span>{t('smartPlaylists.sortOrder')}</span>
      </div>
      {displayRows.map((row, index) => (
        <div key={`${row.field}-${index}`} className="smart-query-footer-row">
          <PlaylistsSmartFieldPicker
            value={row.field}
            capabilities={capabilities}
            customFields={customFields}
            sortableOnly
            onChange={field => {
              const next = rows.length > 0 ? [...rows] : [];
              next[index] = { ...row, field: field.name };
              commit(next);
            }}
          />
          <CustomSelect
            value={row.direction}
            options={[
              { value: '+', label: t('smartPlaylists.sortAscending') },
              { value: '-', label: t('smartPlaylists.sortDescending') },
            ]}
            onChange={direction => {
              const next = rows.length > 0 ? [...rows] : [];
              next[index] = { ...row, direction: direction as '+' | '-' };
              commit(next);
            }}
            ariaLabel={t('smartPlaylists.sortOrder')}
          />
          {rows.length > 0 ? (
            <button
              type="button"
              className="btn btn-surface smart-query-icon-btn"
              aria-label={t('smartPlaylists.removeRule')}
              onClick={() => commit(rows.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Minus size={16} />
            </button>
          ) : <span />}
          {index === displayRows.length - 1 && canAdd ? (
            <button
              type="button"
              className="btn btn-surface smart-query-icon-btn"
              aria-label={t('smartPlaylists.addSort')}
              onClick={() => commit([...(rows.length > 0 ? rows : displayRows), { field: 'title', direction: '+' }])}
            >
              <Plus size={16} />
            </button>
          ) : <span />}
        </div>
      ))}
      {rows.length === 0 && Object.prototype.hasOwnProperty.call(document.raw, 'order') && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          order: {String(document.raw.order)}
        </div>
      )}
      {Object.prototype.hasOwnProperty.call(document.raw, 'order') && (
        <button
          type="button"
          className="btn btn-surface"
          onClick={() => onDocumentChange(parseSmartRulesDocument(
            Object.fromEntries(Object.entries(document.raw).filter(([key]) => key !== 'order')),
          ))}
        >
          {t('smartPlaylists.removeRule')} order
        </button>
      )}
      {issues.map(issue => (
        <div key={`${issue.path}-${issue.code}`} className={`smart-query-issue smart-query-issue-${issue.severity}`}>
          {issue.message}
        </div>
      ))}
    </div>
  );
}
