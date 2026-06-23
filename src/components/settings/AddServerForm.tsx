import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomHeaderEntry, CustomHeadersApplyTo, ServerProfile } from '../../store/authStoreTypes';
import { showToast } from '../../utils/ui/toast';
import {
  DEFAULT_CUSTOM_HEADERS_APPLY_TO,
  validateCustomHeaders,
} from '../../utils/server/serverHttpHeaders';
import {
  decodeServerMagicString,
  encodeServerMagicString,
  DECODED_PASSWORD_VISUAL_MASK,
  type ServerMagicPayload,
} from '../../utils/server/serverMagicString';
import { shortHostFromServerUrl } from '../../utils/server/serverDisplayName';
import { isLanUrl } from '../../utils/server/serverEndpoint';
import { resolveHostAddresses } from '../../api/network';

type FormState = {
  name: string;
  url: string;
  alternateUrl: string;
  shareUsesLocalUrl: boolean;
  username: string;
  password: string;
  customHeaders: CustomHeaderEntry[];
  customHeadersApplyTo: CustomHeadersApplyTo;
  customHeadersOpen: boolean;
};

/** Hostname for the DNS-based form hint, or null when the input is a literal IP. */
function hostnameForDnsHint(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // Literal IPv4 / IPv6 → no DNS lookup; isLanUrl alone classifies it.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (host.includes(':')) return null;
    if (host === 'localhost' || host.endsWith('.local')) return null;
    return host;
  } catch {
    return null;
  }
}

export function AddServerForm({
  onSave,
  onCancel,
  onDelete,
  initialInvite = null,
  editingServer = null,
}: {
  onSave: (data: Omit<ServerProfile, 'id'>) => void | Promise<void>;
  onCancel: () => void;
  onDelete?: () => void | Promise<void>;
  initialInvite?: ServerMagicPayload | null;
  editingServer?: ServerProfile | null;
}) {
  const { t } = useTranslation();
  const isEdit = editingServer != null;
  const [form, setForm] = useState<FormState>(
    editingServer
      ? {
          name: editingServer.name,
          url: editingServer.url,
          alternateUrl: editingServer.alternateUrl ?? '',
          shareUsesLocalUrl: editingServer.shareUsesLocalUrl ?? false,
          username: editingServer.username,
          password: editingServer.password,
          customHeaders: editingServer.customHeaders?.length
            ? editingServer.customHeaders.map(h => ({ ...h }))
            : [{ name: '', value: '' }],
          customHeadersApplyTo:
            editingServer.customHeadersApplyTo ?? DEFAULT_CUSTOM_HEADERS_APPLY_TO,
          customHeadersOpen: Boolean(editingServer.customHeaders?.length),
        }
      : {
          name: '',
          url: '',
          alternateUrl: '',
          shareUsesLocalUrl: false,
          username: '',
          password: '',
          customHeaders: [{ name: '', value: '' }],
          customHeadersApplyTo: DEFAULT_CUSTOM_HEADERS_APPLY_TO,
          customHeadersOpen: false,
        },
  );
  const [magicString, setMagicString] = useState('');
  const [blockPasswordReveal, setBlockPasswordReveal] = useState(false);
  // DNS-classified hint: 'lan' / 'public' / null (no hint, no lookup yet, or
  // literal IP — isLanUrl already classifies those without DNS).
  const [primaryDnsClass, setPrimaryDnsClass] = useState<'lan' | 'public' | null>(null);

  useEffect(() => {
    if (!initialInvite) return;
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBlockPasswordReveal(true);
    setForm(f => ({
      ...f,
      name: (initialInvite.name && initialInvite.name.trim()) || shortHostFromServerUrl(initialInvite.url),
      url: initialInvite.url,
      // v2 invites carry the host's dual-address fields. Pre-populate so the
      // receiver sees both addresses + the share preference rather than
      // re-typing them.
      alternateUrl: initialInvite.alternateUrl ?? '',
      shareUsesLocalUrl: initialInvite.shareUsesLocalUrl ?? false,
      username: initialInvite.username,
      password: initialInvite.password,
    }));
    setMagicString(encodeServerMagicString(initialInvite));
  }, [initialInvite]);

  const update = <K extends keyof FormState>(k: K) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value =
        e.target.type === 'checkbox'
          ? (e.target as HTMLInputElement).checked
          : e.target.value;
      setForm(f => ({ ...f, [k]: value }) as FormState);
    };

  const handleMagicStringChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setMagicString(v);
    const trimmed = v.trim();
    const decoded = decodeServerMagicString(trimmed);
    if (decoded) {
      setBlockPasswordReveal(true);
      setForm(f => ({
        ...f,
        name: (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        alternateUrl: decoded.alternateUrl ?? '',
        shareUsesLocalUrl: decoded.shareUsesLocalUrl ?? false,
        username: decoded.username,
        password: decoded.password,
      }));
    }
  };

  // Literal-IP classification — instant, no DNS needed.
  const primaryUrlIsLanLiteral = useMemo(() => {
    const trimmed = form.url.trim();
    if (!trimmed) return null as boolean | null;
    if (hostnameForDnsHint(trimmed) !== null) return null; // hostname — defer to DNS
    return isLanUrl(trimmed);
  }, [form.url]);

  // Effective LAN classification: literal IP shortcut OR DNS result.
  const primaryUrlIsLan = useMemo(() => {
    if (primaryUrlIsLanLiteral !== null) return primaryUrlIsLanLiteral;
    if (primaryDnsClass === null) return null;
    return primaryDnsClass === 'lan';
  }, [primaryUrlIsLanLiteral, primaryDnsClass]);

  const runDnsHint = async () => {
    const hostname = hostnameForDnsHint(form.url);
    if (!hostname) {
      setPrimaryDnsClass(null);
      return;
    }
    const addresses = await resolveHostAddresses(hostname);
    if (addresses.length === 0) {
      // DNS failed (no network, NXDOMAIN, …) → no hint, don't block.
      setPrimaryDnsClass(null);
      return;
    }
    const anyPublic = addresses.some(ip => !isLanUrl(`http://${ip}`));
    setPrimaryDnsClass(anyPublic ? 'public' : 'lan');
  };

  // Two-LAN client-side check before submit. Returns true on validation pass.
  const validateAddresses = (): boolean => {
    const url = form.url.trim();
    const alt = form.alternateUrl.trim();
    if (!url) return false;
    if (!alt) return true; // single-address — always fine.
    // For the LAN-LAN check we accept both the synchronous isLanUrl
    // classification (literal IPs + .local + localhost) and the DNS-resolved
    // class for the primary. The alternate goes through isLanUrl directly —
    // we don't run a second DNS lookup for it here; the verify step on save
    // will catch any deeper inconsistency.
    const primaryLan = primaryUrlIsLan ?? isLanUrl(url);
    const altLan = isLanUrl(alt);
    if (primaryLan && altLan) {
      showToast(t('settings.serverBothLanError'), 4500, 'error');
      return false;
    }
    return true;
  };

  const customHeadersPayload = (): Pick<
    ServerProfile,
    'customHeaders' | 'customHeadersApplyTo'
  > => {
    const rows = form.customHeaders
      .map(h => ({ name: h.name.trim(), value: h.value }))
      .filter(h => h.name || h.value);
    if (!rows.length) return {};
    return {
      customHeaders: rows,
      customHeadersApplyTo: form.customHeadersApplyTo,
    };
  };

  const submit = async () => {
    const ms = magicString.trim();
    if (ms) {
      const decoded = decodeServerMagicString(ms);
      if (!decoded) {
        showToast(t('login.magicStringInvalid'), 4000, 'error');
        return;
      }
      // v2 invites carry alternateUrl + shareUsesLocalUrl — must survive the
      // magic-string submit path (handleMagicStringChange already prefills
      // them into form state, but the magic-string branch forwards the
      // decoded payload directly so we have to pick them off here too).
      const altDecoded = decoded.alternateUrl?.trim() ?? '';
      await onSave({
        name: form.name.trim() || (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
        ...customHeadersPayload(),
        ...(altDecoded
          ? {
              alternateUrl: altDecoded,
              shareUsesLocalUrl: decoded.shareUsesLocalUrl ?? false,
            }
          : {}),
      });
      return;
    }
    if (!form.url.trim()) return;
    if (!validateAddresses()) return;

    const headerValidation = validateCustomHeaders(
      form.customHeaders.filter(h => h.name.trim() || h.value),
    );
    if (!headerValidation.ok) {
      const first = headerValidation.fieldErrors[0];
      showToast(t(first.messageKey, { defaultValue: first.messageKey }), 5000, 'error');
      return;
    }

    const altTrimmed = form.alternateUrl.trim();
    // If the user clears the second address, strip the share-flag as well so
    // we don't leave a dangling preference (spec §5.3 last row).
    const data: Omit<ServerProfile, 'id'> = {
      name: form.name.trim() || form.url.trim(),
      url: form.url.trim(),
      username: form.username.trim(),
      password: form.password,
      ...customHeadersPayload(),
      ...(altTrimmed
        ? {
            alternateUrl: altTrimmed,
            shareUsesLocalUrl: form.shareUsesLocalUrl,
          }
        : {}),
    };
    await onSave(data);
  };

  // Hint to show under the second-address field: only when the primary is
  // classified one way or the other and the second is still empty.
  const alternateUrlHint =
    !form.alternateUrl.trim() && primaryUrlIsLan !== null
      ? primaryUrlIsLan
        ? t('settings.serverAlternateUrlHintAddPublic')
        : t('settings.serverAlternateUrlHintAddLocal')
      : null;

  // Share checkbox visibility (spec §5.3):
  // - hidden when there is no second address
  // - shown the moment a user fills the second field (or both already exist
  //   on an edit). Default off; persists across save/load.
  const showShareCheckbox = form.alternateUrl.trim().length > 0;

  return (
    <form
      className="settings-card"
      style={{ marginTop: '1rem' }}
      onSubmit={e => { e.preventDefault(); void submit(); }}
    >
      <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '14px' }}>
        {isEdit ? t('settings.editServerTitle') : t('settings.addServerTitle')}
      </h3>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverName')}</label>
        <input className="input" type="text" value={form.name} onChange={update('name')} placeholder="My Navidrome" autoComplete="off" />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverUrl')}</label>
        <input
          className="input"
          type="text"
          value={form.url}
          onChange={update('url')}
          onBlur={() => { void runDnsHint(); }}
          placeholder={t('settings.serverUrlPlaceholder')}
          autoComplete="off"
        />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverAlternateUrl')}</label>
        <input
          className="input"
          type="text"
          value={form.alternateUrl}
          onChange={update('alternateUrl')}
          placeholder={
            primaryUrlIsLan === true
              ? t('settings.serverAlternateUrlPlaceholderPublic')
              : t('settings.serverAlternateUrlPlaceholderLocal')
          }
          autoComplete="off"
        />
        {alternateUrlHint && (
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
            {alternateUrlHint}
          </div>
        )}
      </div>
      {showShareCheckbox && (
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.shareUsesLocalUrl}
              onChange={update('shareUsesLocalUrl')}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span>{t('settings.shareUsesLocalUrl')}</span>
              <span style={{ fontSize: 11, opacity: 0.7 }}>
                {t('settings.shareUsesLocalUrlDesc')}
              </span>
            </span>
          </label>
        </div>
      )}
      <div className="form-row" style={{ marginBottom: '0.75rem' }}>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverUsername')}</label>
          <input
            className="input"
            type="text"
            value={form.username}
            onChange={update('username')}
            placeholder="admin"
            autoComplete="off"
            readOnly={blockPasswordReveal}
            style={blockPasswordReveal ? { cursor: 'default' } : undefined}
          />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverPassword')}</label>
          {blockPasswordReveal ? (
            <input
              className="input"
              type="text"
              readOnly
              value={DECODED_PASSWORD_VISUAL_MASK}
              autoComplete="off"
              aria-label={t('settings.serverPassword')}
              style={{ letterSpacing: '0.12em', cursor: 'default' }}
            />
          ) : (
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={update('password')}
              placeholder="••••••••"
            />
          )}
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 13, padding: '4px 0' }}
          onClick={() => setForm(f => ({ ...f, customHeadersOpen: !f.customHeadersOpen }))}
        >
          {form.customHeadersOpen ? '▾' : '▸'} {t('settings.customHeadersTitle')}
        </button>
        {form.customHeadersOpen && (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontSize: 11, opacity: 0.75, margin: '0 0 8px' }}>
              {t('settings.customHeadersHelp')}
            </p>
            {form.customHeaders.map((row, index) => (
              <div key={index} className="form-row" style={{ marginBottom: 6, gap: 8 }}>
                <input
                  className="input"
                  type="text"
                  value={row.name}
                  onChange={e => {
                    const name = e.target.value;
                    setForm(f => {
                      const customHeaders = f.customHeaders.map((h, i) =>
                        i === index ? { ...h, name } : h,
                      );
                      return { ...f, customHeaders };
                    });
                  }}
                  placeholder={t('settings.customHeadersNamePlaceholder')}
                  autoComplete="off"
                />
                <input
                  className="input"
                  type="password"
                  value={row.value}
                  onChange={e => {
                    const value = e.target.value;
                    setForm(f => ({
                      ...f,
                      customHeaders: f.customHeaders.map((h, i) =>
                        i === index ? { ...h, value } : h,
                      ),
                    }));
                  }}
                  placeholder={t('settings.customHeadersValuePlaceholder')}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={t('settings.customHeadersRemoveRow')}
                  onClick={() =>
                    setForm(f => ({
                      ...f,
                      customHeaders:
                        f.customHeaders.length <= 1
                          ? [{ name: '', value: '' }]
                          : f.customHeaders.filter((_, i) => i !== index),
                    }))
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, marginBottom: 8 }}
              onClick={() =>
                setForm(f => ({
                  ...f,
                  customHeaders: [...f.customHeaders, { name: '', value: '' }],
                }))
              }
            >
              {t('settings.customHeadersAddRow')}
            </button>
            <fieldset
              disabled={!form.customHeaders.some(h => h.name.trim() || h.value)}
              style={{ border: 'none', padding: 0, margin: 0 }}
            >
              <legend style={{ fontSize: 12, marginBottom: 4 }}>{t('settings.customHeadersApplyTo')}</legend>
              {(['public', 'local', 'both'] as const).map(kind => (
                <label key={kind} style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                  <input
                    type="radio"
                    name="customHeadersApplyTo"
                    checked={form.customHeadersApplyTo === kind}
                    onChange={() => setForm(f => ({ ...f, customHeadersApplyTo: kind }))}
                  />{' '}
                  {t(`settings.customHeadersApplyTo_${kind}`)}
                </label>
              ))}
            </fieldset>
            <p style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
              {t('settings.customHeadersNotInShare')}
            </p>
          </div>
        )}
      </div>
      {!isEdit && (
        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
          <label style={{ fontSize: 13 }}>{t('login.orMagicString')}</label>
          <input
            className="input"
            type="text"
            value={magicString}
            onChange={handleMagicStringChange}
            placeholder={t('login.magicStringPlaceholder')}
            autoComplete="off"
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center' }}>
        {isEdit && onDelete ? (
          <button type="button" className="btn btn-danger" onClick={() => void onDelete()}>
            {t('settings.deleteServer')}
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary">
            {isEdit ? t('common.save') : t('common.add')}
          </button>
        </div>
      </div>
    </form>
  );
}
