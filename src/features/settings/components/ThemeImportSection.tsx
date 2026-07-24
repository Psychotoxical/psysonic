import { useState } from 'react';
import { Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { commands } from '@/generated/bindings';
import { open } from '@tauri-apps/plugin-dialog';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import { validateThemePackage, type ValidatedTheme } from '@/lib/themes/validateThemePackage';
import { parseAssetRefs } from '@/lib/themes/themeAssets';
import { installLocalAssets, type LocalAssetInput } from '@/lib/themes/themeAssetInstall';
import { removeThemeAssets } from '@/lib/themes/themeAssetStorage';
import { showToast } from '@/lib/dom/toast';
import ConfirmModal from '@/ui/ConfirmModal';

interface PendingImport {
  theme: ValidatedTheme;
  /** `assets/…` paths the CSS references, to be written on confirm. */
  refs: string[];
  /** Asset bytes extracted from the zip by Rust. */
  assets: LocalAssetInput[];
}

/**
 * Import a community theme from a local `.zip` (manifest.json + theme.css, plus
 * any `assets/` files). Rust extracts the entries (size-capped, outside the
 * webview); the full store contract validation runs before the theme is
 * persisted, and referenced assets are written to disk on confirm. Anything
 * off-contract is rejected with the exact reasons listed.
 */
export function ThemeImportSection() {
  const { t } = useTranslation();
  const install = useInstalledThemesStore(s => s.install);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [importing, setImporting] = useState(false);
  // A validated-but-not-yet-installed theme, awaiting the user's confirmation.
  const [pending, setPending] = useState<PendingImport | null>(null);

  const handleImport = async () => {
    setImportErrors(null);
    let selected: string | null = null;
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Theme', extensions: ['zip'] }],
      });
      if (typeof picked === 'string') selected = picked;
    } catch {
      return; // dialog dismissed / unavailable
    }
    if (!selected) return;

    setImporting(true);
    try {
      const res = await commands.importThemeZip(selected);
      if (res.status === 'error') throw new Error(res.error);
      const files = res.data;
      const result = validateThemePackage(files.manifest, files.css);
      if (!result.ok) {
        setImportErrors(result.errors);
        return;
      }
      // Validated — confirm with the user (name + author) before persisting.
      // Assets are written on confirm, so carry the zip's bytes through.
      setPending({
        theme: result.theme,
        refs: parseAssetRefs(result.theme.css),
        assets: files.assets.map(a => ({ rel: a.rel, bytes: new Uint8Array(a.bytes) })),
      });
    } catch (e) {
      setImportErrors([String(e)]);
    } finally {
      setImporting(false);
    }
  };

  const confirmInstall = async () => {
    if (!pending) return;
    const { theme, refs, assets } = pending;
    let assetBase: string | undefined;
    let assetRels: string[] | undefined;
    if (refs.length > 0) {
      const written = await installLocalAssets(theme.id, refs, assets);
      if (!written.ok) {
        await removeThemeAssets(theme.id);
        setPending(null);
        setImportErrors([
          written.reason === 'invalid'
            ? t('settings.themeImportAssetInvalid')
            : t('settings.themeImportAssetError'),
        ]);
        return;
      }
      assetBase = written.assetBase;
      assetRels = written.rels;
    } else {
      // No assets referenced — clear any directory a prior asset theme left.
      await removeThemeAssets(theme.id);
    }
    install({
      ...theme,
      installedAt: Date.now(),
      ...(assetBase ? { assetBase, assets: assetRels } : {}),
    });
    showToast(t('settings.themeImportSuccess', { name: theme.name }), 4000, 'success');
    setPending(null);
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleImport}
        disabled={importing}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          textAlign: 'left',
          padding: '14px 16px',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-md, 10px)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          cursor: importing ? 'default' : 'pointer',
        }}
      >
        <Upload size={20} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {importing ? t('settings.themeImporting') : t('settings.themeImportButton')}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.themeImportHint')}</span>
        </span>
      </button>

      {importErrors && (
        <div
          role="alert"
          style={{
            marginTop: '1rem',
            padding: '10px 12px',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius-md, 10px)',
            background: 'var(--bg-elevated)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <strong style={{ fontSize: 13, color: 'var(--danger)' }}>{t('settings.themeImportErrorTitle')}</strong>
            <button
              onClick={() => setImportErrors(null)}
              aria-label={t('common.close')}
              style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 0 }}
            >
              <X size={14} />
            </button>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {t('settings.themeImportErrorBody')}
          </p>
          {/* The raw contract diagnostics — useful to theme authors / bug reports,
              tucked away so end users aren't confronted with token names. */}
          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              {t('settings.themeImportErrorDetails')}
            </summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-muted)' }}>
              {importErrors.map((e, i) => (
                <li key={i} style={{ fontSize: 11.5, lineHeight: 1.5 }}>{e}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <ConfirmModal
        open={pending !== null}
        title={t('settings.themeImportConfirmTitle')}
        message={pending ? `${t('settings.themeImportConfirmBody', { name: pending.theme.name, author: pending.theme.author })} ${t('settings.themeImportConfirmRisk')}` : ''}
        confirmLabel={t('settings.themeStoreInstall')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void confirmInstall()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
