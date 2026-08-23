import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import CustomSelect from '@/ui/CustomSelect';
import PlaylistsSmartFieldPicker from '@/features/playlist/components/PlaylistsSmartFieldPicker';
import PlaylistsSmartValuePicker from '@/features/playlist/components/PlaylistsSmartValuePicker';
import {
  clampSmartRuleNumber,
  findSmartRuleField,
  getSmartRuleOperatorsForField,
  type SmartPlaylistCapabilities,
  type SmartRuleFieldDefinition,
} from '@/features/playlist/utils/smartPlaylistFields';
import { YEAR_MAX, YEAR_MIN } from '@/features/playlist/utils/playlistsSmart';
import {
  isValidSmartRuleDate,
  setSmartRuleValue,
  type SmartRuleLeafNode,
  type SmartRuleValidationIssue,
  type SmartRulesDocument,
} from '@/features/playlist/utils/smartPlaylistRules';

interface PlaylistOption {
  id: string;
  name: string;
}

interface Props {
  node: SmartRuleLeafNode;
  document: SmartRulesDocument;
  onDocumentChange: (document: SmartRulesDocument) => void;
  capabilities: SmartPlaylistCapabilities;
  customFields: readonly SmartRuleFieldDefinition[];
  playlistOptions: PlaylistOption[];
  genreSuggestions?: readonly string[];
  issues?: readonly SmartRuleValidationIssue[];
}

function controlIssueClass(issues: readonly SmartRuleValidationIssue[]): string {
  if (issues.some(issue => issue.severity === 'error')) return 'smart-query-control-error';
  if (issues.length > 0) return 'smart-query-control-warning';
  return '';
}

function isYearField(field: SmartRuleFieldDefinition | undefined): boolean {
  return field?.type === 'number' && /year$/i.test(field.name);
}

function isPlaylistOperator(operator: string): boolean {
  return operator === 'inPlaylist' || operator === 'notInPlaylist';
}

function rangePartValid(value: unknown, field: SmartRuleFieldDefinition | undefined): boolean {
  if (field?.type === 'date') return isValidSmartRuleDate(value);
  return typeof value === 'number' && Number.isFinite(value);
}

function rangePartIssueClass(
  value: unknown,
  peer: unknown,
  field: SmartRuleFieldDefinition | undefined,
  issueClass: string,
): string {
  if (!issueClass) return '';
  const selfOk = rangePartValid(value, field);
  const peerOk = rangePartValid(peer, field);
  if (selfOk && peerOk) return issueClass;
  return selfOk ? '' : issueClass;
}

function playlistIdValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && 'id' in value) {
    return String((value as { id?: unknown }).id ?? '');
  }
  return '';
}

function currentYear(): number {
  return new Date().getFullYear();
}

function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function defaultValueFor(
  field: SmartRuleFieldDefinition,
  operator: string,
): unknown {
  if (isPlaylistOperator(operator) || field.type === 'playlist') return '';
  if (operator === 'isMissing' || operator === 'isPresent') return true;
  if (operator === 'inTheRange') {
    if (field.type === 'date') return [todayIsoDate(), todayIsoDate()];
    if (isYearField(field)) return [YEAR_MIN, YEAR_MAX];
    if (field.min != null && field.max != null) return [field.min, field.max];
    return [field.min ?? 0, field.max ?? 0];
  }
  if (operator === 'inTheLast' || operator === 'notInTheLast') return 1;
  if (operator === 'gt' || operator === 'lt') {
    return isYearField(field) ? currentYear() : 1;
  }
  switch (field.type) {
    case 'boolean':
      return true;
    case 'number':
      return isYearField(field) ? currentYear() : 0;
    case 'date':
      return todayIsoDate();
    default:
      return '';
  }
}

export default function PlaylistsSmartRuleRow({
  node, document, onDocumentChange, capabilities, customFields, playlistOptions,
  genreSuggestions = [], issues = [],
}: Props) {
  const { t } = useTranslation();
  const isPlaylistOp = isPlaylistOperator(node.operator);
  const field = findSmartRuleField(isPlaylistOp ? 'playlist' : node.field, customFields);
  const fieldIssues = issues.filter(issue => (
    issue.code === 'unknown_field' || issue.code === 'unsupported_field'
  ));
  const operatorIssues = issues.filter(issue => (
    issue.code === 'unknown_operator' || issue.code === 'unsupported_operator'
  ));
  const valueIssues = issues.filter(issue => (
    issue.code === 'invalid_value' || issue.code === 'self_reference'
  ));
  const fieldIssueClass = controlIssueClass(fieldIssues);
  const operatorIssueClass = controlIssueClass(operatorIssues);
  const valueIssueClass = controlIssueClass(valueIssues);
  const operators = useMemo(() => (
    field ? getSmartRuleOperatorsForField(field, capabilities) : []
  ), [capabilities, field]);

  const replaceLeaf = (operator: string, fieldName: string, value: unknown) => {
    const playlist = isPlaylistOperator(operator);
    const nextValue = playlist
      ? { id: typeof value === 'string' ? value : playlistIdValue(value) }
      : { [fieldName]: value };
    onDocumentChange(setSmartRuleValue(document, node.path, { [operator]: nextValue }));
  };

  const currentValue = isPlaylistOp ? playlistIdValue(node.value) : node.value;

  return (
    <div className="smart-query-rule">
      <PlaylistsSmartFieldPicker
        value={isPlaylistOp ? 'playlist' : node.field}
        className={fieldIssueClass}
        ariaInvalid={fieldIssues.some(issue => issue.severity === 'error')}
        capabilities={capabilities}
        customFields={customFields}
        onChange={nextField => {
          const nextOps = getSmartRuleOperatorsForField(nextField, capabilities);
          const operator = nextOps.some(item => item.name === node.operator)
            ? node.operator
            : nextOps[0]?.name ?? 'is';
          replaceLeaf(operator, nextField.name, defaultValueFor(nextField, operator));
        }}
      />
      <CustomSelect
        value={node.operator}
        className={operatorIssueClass}
        ariaInvalid={operatorIssues.some(issue => issue.severity === 'error')}
        options={operators.map(operator => ({
          value: operator.name,
          label: t(`smartPlaylists.operator_${operator.name}`),
        }))}
        onChange={operator => {
          const keepPlaylistValue = isPlaylistOp && isPlaylistOperator(operator);
          replaceLeaf(
            operator,
            isPlaylistOp ? 'playlist' : node.field,
            keepPlaylistValue
              ? currentValue
              : field ? defaultValueFor(field, operator) : currentValue,
          );
        }}
      />
      {renderValueInput({
        t,
        operator: node.operator,
        field,
        value: currentValue,
        playlistOptions,
        genreSuggestions,
        issueClass: valueIssueClass,
        ariaInvalid: valueIssues.some(issue => issue.severity === 'error'),
        onChange: value => replaceLeaf(node.operator, isPlaylistOp ? 'id' : node.field, value),
      })}
    </div>
  );
}

function renderValueInput({
  t, operator, field, value, playlistOptions, genreSuggestions, issueClass, ariaInvalid, onChange,
}: {
  t: TFunction;
  operator: string;
  field: SmartRuleFieldDefinition | undefined;
  value: unknown;
  playlistOptions: PlaylistOption[];
  genreSuggestions: readonly string[];
  issueClass: string;
  ariaInvalid: boolean;
  onChange: (value: unknown) => void;
}) {
  if (isPlaylistOperator(operator) || field?.type === 'playlist') {
    return (
      <PlaylistsSmartValuePicker
        value={typeof value === 'string' ? value : ''}
        options={playlistOptions.map(option => ({ value: option.id, label: option.name }))}
        onChange={onChange}
        ariaLabel={t('smartPlaylists.value')}
        className={issueClass}
        ariaInvalid={ariaInvalid}
      />
    );
  }
  if (operator === 'isMissing' || operator === 'isPresent') return null;
  if (field?.type === 'boolean') {
    return (
      <CustomSelect
        value={value === false ? 'false' : 'true'}
        options={[
          { value: 'true', label: t('smartPlaylists.booleanTrue') },
          { value: 'false', label: t('smartPlaylists.booleanFalse') },
        ]}
        onChange={next => onChange(next === 'true')}
        ariaLabel={t('smartPlaylists.booleanValue')}
        className={issueClass}
        ariaInvalid={ariaInvalid}
      />
    );
  }
  if (operator === 'inTheRange') {
    const range = Array.isArray(value) ? value : [value, value];
    const isDate = field?.type === 'date';
    const leftClass = rangePartIssueClass(range[0], range[1], field, issueClass);
    const rightClass = rangePartIssueClass(range[1], range[0], field, issueClass);
    return (
      <div className="smart-query-rule-value">
        {isDate ? (
          <>
            <DateValueInput
              value={String(range[0] ?? '')}
              onChange={next => onChange([next, range[1]])}
              className={leftClass}
              ariaInvalid={ariaInvalid && !!leftClass}
            />
            <DateValueInput
              value={String(range[1] ?? '')}
              onChange={next => onChange([range[0], next])}
              className={rightClass}
              ariaInvalid={ariaInvalid && !!rightClass}
            />
          </>
        ) : (
          <>
            <NumberValueInput
              value={range[0]}
              field={field}
              className={leftClass}
              ariaInvalid={ariaInvalid && !!leftClass}
              ariaLabel={isYearField(field) ? t('smartPlaylists.year') : undefined}
              onChange={next => onChange([next, range[1]])}
            />
            <NumberValueInput
              value={range[1]}
              field={field}
              className={rightClass}
              ariaInvalid={ariaInvalid && !!rightClass}
              ariaLabel={isYearField(field) ? t('smartPlaylists.year') : undefined}
              onChange={next => onChange([range[0], next])}
            />
          </>
        )}
      </div>
    );
  }
  if (operator === 'inTheLast' || operator === 'notInTheLast') {
    return (
      <NumberValueInput
        value={value}
        min={1}
        className={issueClass}
        ariaInvalid={ariaInvalid}
        onChange={onChange}
      />
    );
  }
  if (field?.type === 'date' || operator === 'before' || operator === 'after') {
    return (
      <DateValueInput
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        className={issueClass}
        ariaInvalid={ariaInvalid}
      />
    );
  }
  if (field?.type === 'number' || operator === 'gt' || operator === 'lt') {
    return (
      <NumberValueInput
        value={value}
        field={field}
        className={issueClass}
        ariaInvalid={ariaInvalid}
        ariaLabel={isYearField(field) ? t('smartPlaylists.year') : undefined}
        onChange={onChange}
      />
    );
  }
  if (field?.name === 'genre' && genreSuggestions.length > 0) {
    return (
      <PlaylistsSmartValuePicker
        value={typeof value === 'string' ? value : String(value ?? '')}
        options={genreSuggestions.map(genre => ({ value: genre, label: genre }))}
        onChange={onChange}
        ariaLabel={t('smartPlaylists.value')}
        className={issueClass}
        ariaInvalid={ariaInvalid}
      />
    );
  }
  return (
    <input
      className={`input ${issueClass}`}
      aria-invalid={ariaInvalid || undefined}
      value={typeof value === 'string' ? value : String(value ?? '')}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function NumberValueInput({
  value,
  onChange,
  field,
  min,
  max,
  className = '',
  ariaInvalid,
  ariaLabel,
}: {
  value: unknown;
  onChange: (value: number) => void;
  field?: SmartRuleFieldDefinition;
  min?: number;
  max?: number;
  className?: string;
  ariaInvalid?: boolean;
  ariaLabel?: string;
}) {
  const low = min ?? field?.min;
  const high = max ?? field?.max;
  return (
    <input
      className={`input ${className}`}
      type="number"
      min={low}
      max={high}
      aria-invalid={ariaInvalid || undefined}
      aria-label={ariaLabel}
      value={typeof value === 'number' ? value : ''}
      onChange={event => {
        const next = Number(event.target.value);
        onChange(Number.isFinite(next) ? clampSmartRuleNumber(next, { min: low, max: high }) : next);
      }}
    />
  );
}

function DateValueInput({
  value,
  onChange,
  className = '',
  ariaInvalid,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaInvalid?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <input
      className={`input smart-query-date-input ${className}`}
      aria-invalid={ariaInvalid || undefined}
      aria-label={t('smartPlaylists.typeDate')}
      placeholder={t('smartPlaylists.datePlaceholder')}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  );
}
