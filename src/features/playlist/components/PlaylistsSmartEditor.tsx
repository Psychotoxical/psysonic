import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import PlaylistCreateFields from '@/features/playlist/components/PlaylistCreateFields';
import PlaylistsSmartEditorAdvanced from '@/features/playlist/components/PlaylistsSmartEditorAdvanced';
import PlaylistsSmartEditorBasic from '@/features/playlist/components/PlaylistsSmartEditorBasic';
import PlaylistsSmartEditorJson from '@/features/playlist/components/PlaylistsSmartEditorJson';
import { defaultSmartFilters, type SmartFilters } from '@/features/playlist/utils/playlistsSmart';
import {
  applySmartEditorJson,
  createSmartEditorSession,
  requestSmartEditorMode,
  type SmartEditorMode,
  type SmartEditorSession,
} from '@/features/playlist/utils/smartPlaylistEditor';
import {
  resolveCustomSmartRuleFields,
  resolveSmartPlaylistCapabilities,
} from '@/features/playlist/utils/smartPlaylistFields';
import {
  parseSmartRulesDocument,
  validateSmartRulesDocument,
} from '@/features/playlist/utils/smartPlaylistRules';
import {
  formatSmartPreviewTrackLabel,
  type SmartPreviewTrack,
} from '@/features/playlist/utils/formatSmartPreviewTrack';
import type { SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';

interface PlaylistOption {
  id: string;
  name: string;
}

type PreviewTrack = SmartPreviewTrack;

interface Props {
  session: SmartEditorSession;
  setSession: React.Dispatch<React.SetStateAction<SmartEditorSession>>;
  smartFilters: SmartFilters;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  availableGenres: string[];
  genreQuery: string;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  editingSmartId: string | null;
  creatingSmartBusy: boolean;
  genresReady: boolean;
  createServerId: string;
  setCreateServerId: (serverId: string) => void;
  createServerOptions: Array<{ id: string; label: string }>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  onSave: () => void;
  onCancel: () => void;
  onSaveCopy?: () => void;
  onResetToServer?: () => void;
  onPreview: () => Promise<PreviewTrack[]>;
  serverIdentity?: SubsonicServerIdentity;
  playlistOptions?: PlaylistOption[];
  ownerUsername?: string;
}

export default function PlaylistsSmartEditor({
  session, setSession, smartFilters, setSmartFilters, availableGenres,
  genreQuery, setGenreQuery, editingSmartId, creatingSmartBusy, genresReady,
  createServerId, setCreateServerId, createServerOptions,
  setCreatingSmart, setEditingSmartId, onSave, onCancel, onSaveCopy, onResetToServer,
  onPreview, serverIdentity, playlistOptions = [], ownerUsername,
}: Props) {
  const { t } = useTranslation();
  const capabilities = useMemo(
    () => resolveSmartPlaylistCapabilities(serverIdentity),
    [serverIdentity],
  );
  const customFieldSettings = useAuthStore(state => state.smartPlaylistCustomFields);
  const customFields = useMemo(
    () => resolveCustomSmartRuleFields(customFieldSettings),
    [customFieldSettings],
  );
  const [previewTracks, setPreviewTracks] = useState<PreviewTrack[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const jsonDraftState = useMemo(() => {
    if (session.mode !== 'json') return { document: session.document, error: null };
    try {
      return {
        document: parseSmartRulesDocument(JSON.parse(session.jsonDraft) as unknown),
        error: null,
      };
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : 'Invalid JSON',
      };
    }
  }, [session.document, session.jsonDraft, session.mode]);
  const validation = jsonDraftState.document
    ? validateSmartRulesDocument(jsonDraftState.document, {
    currentPlaylistId: editingSmartId ?? undefined,
    capabilities,
    customFields,
    })
    : [];
  const blocking = validation.filter(issue => issue.severity === 'error');
  const hasBlockingIssues = jsonDraftState.error !== null || blocking.length > 0;

  const setMode = (mode: SmartEditorMode) => {
    setSession(current => {
      const next = requestSmartEditorMode(
        current.mode === 'basic' ? { ...current, filters: smartFilters } : current,
        mode,
        { allGenres: availableGenres },
      );
      if (next.mode === 'basic') setSmartFilters(next.filters);
      return next;
    });
  };

  const closeEditor = () => {
    onCancel();
    setCreatingSmart(false);
    setEditingSmartId(null);
    setSmartFilters(defaultSmartFilters);
    setSession(createSmartEditorSession());
    setGenreQuery('');
  };

  return (
    <div style={{ marginBottom: 'var(--space-4)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', background: 'var(--bg-card)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <PlaylistCreateFields
          name={smartFilters.name}
          nameLabel={t('queue.playlistName')}
          namePlaceholder={t('smartPlaylists.name')}
          onNameChange={name => setSmartFilters(value => ({ ...value, name }))}
          serverId={createServerId}
          onServerChange={setCreateServerId}
          serverOptions={createServerOptions}
          showServer={!editingSmartId}
        />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.comment')}</span>
          <input
            className="input"
            placeholder={t('smartPlaylists.commentPlaceholder')}
            value={session.comment}
            onChange={event => setSession(current => ({ ...current, comment: event.target.value }))}
          />
        </label>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input
              type="checkbox"
              checked={session.public}
              onChange={event => setSession(current => ({ ...current, public: event.target.checked }))}
            />
            {t('smartPlaylists.public')}
          </label>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('smartPlaylists.owner')}: {session.owner || ownerUsername || '—'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {session.evaluatedAt || session.lastEvaluatedAt
              ? t('smartPlaylists.lastEvaluated', { when: session.evaluatedAt || session.lastEvaluatedAt })
              : t('smartPlaylists.neverEvaluated')}
          </span>
        </div>
        <div role="tablist" aria-label="Smart playlist editor modes" className="smart-playlist-mode-toggle" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button type="button" role="tab" aria-selected={session.mode === 'basic'} className={`btn ${session.mode === 'basic' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setMode('basic')}>
            {t('smartPlaylists.modeBasic')}
          </button>
          <button type="button" role="tab" aria-selected={session.mode === 'advanced'} className={`btn ${session.mode === 'advanced' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setMode('advanced')}>
            {t('smartPlaylists.modeAdvanced')}
          </button>
          <button type="button" role="tab" aria-selected={session.mode === 'json'} className={`btn ${session.mode === 'json' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setMode('json')}>
            {t('smartPlaylists.modeJson')}
          </button>
        </div>
        {session.basicBlockedPaths.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('smartPlaylists.modeBasicUnavailable')}
          </div>
        )}
        {session.mode === 'basic' && (
          <PlaylistsSmartEditorBasic
            smartFilters={smartFilters}
            setSmartFilters={setSmartFilters}
            availableGenres={availableGenres}
            genreQuery={genreQuery}
            setGenreQuery={setGenreQuery}
          />
        )}
        {session.mode === 'advanced' && (
          <PlaylistsSmartEditorAdvanced
            document={session.document}
            onDocumentChange={document => setSession(current => ({
              ...current,
              document,
              jsonDraft: JSON.stringify(document.raw, null, 2),
              jsonError: null,
            }))}
            capabilities={capabilities}
            customFields={customFields}
            playlistOptions={playlistOptions.filter(option => option.id !== editingSmartId)}
            genreSuggestions={availableGenres}
            issues={validation}
          />
        )}
        {session.mode === 'json' && (
          <PlaylistsSmartEditorJson
            session={session}
            onDraftChange={jsonDraft => setSession(current => ({ ...current, jsonDraft, jsonError: null }))}
            onApply={() => setSession(current => applySmartEditorJson(current, current.jsonDraft, { allGenres: availableGenres }))}
            jsonError={jsonDraftState.error ?? session.jsonError}
            issues={validation}
          />
        )}
        {previewTracks && (
          <div style={{ fontSize: 13, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-1)' }}>
              {t('smartPlaylists.previewHint')}
            </div>
            <div style={{ fontWeight: 600 }}>{t('smartPlaylists.previewCount', { count: previewTracks.length })}</div>
            {previewTracks.length === 0 && <div>{t('smartPlaylists.previewEmpty')}</div>}
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-5)' }}>
              {previewTracks.slice(0, 12).map((track, index) => (
                <li key={track.id ?? `${track.title ?? track.name ?? 'track'}-${index}`}>
                  {formatSmartPreviewTrackLabel(track)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {previewError && (
          <div style={{ fontSize: 12, color: 'var(--danger, #c0392b)' }}>{previewError}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {onResetToServer && editingSmartId && (
            <button type="button" className="btn btn-surface" onClick={onResetToServer}>
              {t('smartPlaylists.resetToServer')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-surface"
            onClick={() => {
              setSmartFilters(defaultSmartFilters);
              setSession(createSmartEditorSession({
                name: smartFilters.name,
                owner: session.owner || ownerUsername,
              }));
            }}
          >
            {t('smartPlaylists.clear')}
          </button>
          {session.mode !== 'json' && (
            <button type="button" className="btn btn-surface" onClick={() => setMode('json')}>
              {t('smartPlaylists.previewJson')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-surface"
            disabled={previewBusy || hasBlockingIssues}
            onClick={() => {
              setPreviewBusy(true);
              setPreviewError(null);
              void onPreview()
                .then(tracks => setPreviewTracks(tracks))
                .catch(() => setPreviewError(t('smartPlaylists.previewFailed')))
                .finally(() => setPreviewBusy(false));
            }}
          >
            {t('smartPlaylists.preview')}
          </button>
          {onSaveCopy && editingSmartId && (
            <button type="button" className="btn btn-surface" onClick={onSaveCopy} disabled={hasBlockingIssues}>
              {t('smartPlaylists.saveCopy')}
            </button>
          )}
          <button type="button" className="btn btn-surface" onClick={closeEditor}>
            {t('playlists.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={creatingSmartBusy || !genresReady || hasBlockingIssues}>
            <Plus size={15} /> {editingSmartId ? t('smartPlaylists.save') : t('smartPlaylists.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
