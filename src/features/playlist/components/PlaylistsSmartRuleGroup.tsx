import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyPlus, FolderPlus, Minus, Plus } from 'lucide-react';
import CustomSelect from '@/ui/CustomSelect';
import PlaylistsSmartRuleRow from '@/features/playlist/components/PlaylistsSmartRuleRow';
import {
  defaultSmartRuleGroup,
  defaultSmartRuleLeaf,
} from '@/features/playlist/utils/smartPlaylistEditor';
import {
  parseSmartRulesDocument,
  removeSmartRuleValue,
  setSmartRuleValue,
  type SmartRuleCombinator,
  type SmartRuleGroupNode,
  type SmartRulePath,
  type SmartRuleValidationIssue,
  type SmartRulesDocument,
} from '@/features/playlist/utils/smartPlaylistRules';
import type { SmartPlaylistCapabilities, SmartRuleFieldDefinition } from '@/features/playlist/utils/smartPlaylistFields';

interface PlaylistOption {
  id: string;
  name: string;
}

interface Props {
  node: SmartRuleGroupNode;
  document: SmartRulesDocument;
  onDocumentChange: (document: SmartRulesDocument) => void;
  capabilities: SmartPlaylistCapabilities;
  customFields: readonly SmartRuleFieldDefinition[];
  playlistOptions: PlaylistOption[];
  genreSuggestions?: readonly string[];
  issues?: readonly SmartRuleValidationIssue[];
  isRoot?: boolean;
  canRemove?: boolean;
  onDuplicate?: () => void;
}

function groupArrayPath(node: SmartRuleGroupNode, isRoot: boolean): SmartRulePath {
  const rootPath = `/${node.combinator}`;
  return isRoot || node.path === rootPath
    ? node.path
    : `${node.path}/${node.combinator}` as SmartRulePath;
}

export default function PlaylistsSmartRuleGroup({
  node, document, onDocumentChange, capabilities, customFields, playlistOptions,
  genreSuggestions = [], issues = [],
  isRoot = false, canRemove = false, onDuplicate,
}: Props) {
  const { t } = useTranslation();
  const canRemoveGroup = !isRoot && canRemove;
  const canRemoveRootChild = !isRoot || node.children.length > 1;
  const arrayPath = groupArrayPath(node, isRoot);
  const groupIssues = issues.filter(issue => (
    issue.path === node.path
    || issue.path === arrayPath
    || (isRoot && issue.path === '/')
  ));
  const groupIssueClass = groupIssues.some(issue => issue.severity === 'error')
    ? 'smart-query-has-error'
    : groupIssues.length > 0 ? 'smart-query-has-warning' : '';

  const setCombinator = (combinator: SmartRuleCombinator) => {
    if (combinator === node.combinator) return;
    const children = Array.isArray((node.raw as { [key: string]: unknown })[node.combinator])
      ? (node.raw as { [key: string]: unknown[] })[node.combinator]
      : [];
    const rootPath = `/${node.combinator}`;
    if (isRoot || node.path === rootPath) {
      const next = { ...document.raw } as Record<string, unknown>;
      delete next[node.combinator];
      next[combinator] = children;
      onDocumentChange(parseSmartRulesDocument(next));
      return;
    }
    onDocumentChange(setSmartRuleValue(document, node.path, { [combinator]: children }));
  };

  const addChild = (value: Record<string, unknown>) => {
    const arrayPath = groupArrayPath(node, isRoot);
    onDocumentChange(setSmartRuleValue(
      document,
      `${arrayPath}/${node.children.length}` as SmartRulePath,
      value,
    ));
  };

  const duplicateChild = (raw: unknown) => {
    addChild(structuredClone(raw) as Record<string, unknown>);
  };

  return (
    <div className={`smart-query-group ${groupIssueClass}`}>
      <div className="smart-query-group-head">
        <CustomSelect
          value={node.combinator}
          options={[
            { value: 'all', label: t('smartPlaylists.matchAll') },
            { value: 'any', label: t('smartPlaylists.matchAny') },
          ]}
          onChange={value => setCombinator(value as SmartRuleCombinator)}
          ariaLabel={t('smartPlaylists.match')}
        />
        <button
          type="button"
          className="btn btn-surface smart-query-icon-btn"
          aria-label={t('smartPlaylists.addRule')}
          onClick={() => addChild(defaultSmartRuleLeaf())}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="btn btn-surface smart-query-icon-btn"
          aria-label={t('smartPlaylists.addGroup')}
          onClick={() => addChild(defaultSmartRuleGroup())}
        >
          <FolderPlus size={16} />
        </button>
        {canRemoveGroup && onDuplicate && (
          <button
            type="button"
            className="btn btn-surface smart-query-icon-btn"
            aria-label={t('smartPlaylists.duplicateGroup')}
            onClick={onDuplicate}
          >
            <CopyPlus size={16} />
          </button>
        )}
        {canRemoveGroup && (
          <button
            type="button"
            className="btn btn-surface smart-query-icon-btn"
            aria-label={t('smartPlaylists.removeGroup')}
            onClick={() => onDocumentChange(removeSmartRuleValue(document, node.path))}
          >
            <Minus size={16} />
          </button>
        )}
      </div>
      {groupIssues.map(issue => (
        <div key={`${issue.path}-${issue.code}`} className={`smart-query-issue smart-query-issue-${issue.severity}`}>
          {issue.message}
        </div>
      ))}
      {node.children.map(child => {
        if (child.kind === 'group') {
          return (
            <PlaylistsSmartRuleGroup
              key={child.path}
              node={child}
              document={document}
              onDocumentChange={onDocumentChange}
              capabilities={capabilities}
              customFields={customFields}
              playlistOptions={playlistOptions}
              genreSuggestions={genreSuggestions}
              issues={issues}
              isRoot={false}
              canRemove
              onDuplicate={() => duplicateChild(child.raw)}
            />
          );
        }
        if (child.kind === 'rule') {
          const childIssues = issues.filter(issue => (
            issue.path === child.path || issue.path.startsWith(`${child.path}/`)
          ));
          return (
            <Fragment key={child.path}>
              <div className="smart-query-row">
                <PlaylistsSmartRuleRow
                  node={child}
                  document={document}
                  onDocumentChange={onDocumentChange}
                  capabilities={capabilities}
                  customFields={customFields}
                  playlistOptions={playlistOptions}
                  genreSuggestions={genreSuggestions}
                  issues={childIssues}
                />
                <button
                  type="button"
                  className="btn btn-surface smart-query-icon-btn"
                  aria-label={t('smartPlaylists.duplicateRule')}
                  onClick={() => duplicateChild(child.raw)}
                >
                  <CopyPlus size={16} />
                </button>
                {canRemoveRootChild && (
                  <button
                    type="button"
                    className="btn btn-surface smart-query-icon-btn"
                    aria-label={t('smartPlaylists.removeRule')}
                    onClick={() => onDocumentChange(removeSmartRuleValue(document, child.path))}
                  >
                    <Minus size={16} />
                  </button>
                )}
              </div>
              {childIssues.map(issue => (
                <div
                  key={`${issue.path}-${issue.code}`}
                  className={`smart-query-issue smart-query-rule-issue smart-query-issue-${issue.severity}`}
                >
                  {issue.message}
                </div>
              ))}
            </Fragment>
          );
        }
        const childIssues = issues.filter(issue => (
          issue.path === child.path || issue.path.startsWith(`${child.path}/`)
        ));
        return (
          <Fragment key={child.path}>
            <pre
              className={childIssues.length > 0 ? 'smart-query-has-warning' : undefined}
              style={{ fontSize: 12, overflow: 'auto', margin: 0 }}
            >
              {JSON.stringify(child.raw, null, 2)}
            </pre>
            {childIssues.map(issue => (
              <div key={`${issue.path}-${issue.code}`} className={`smart-query-issue smart-query-issue-${issue.severity}`}>
                {issue.message}
              </div>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
