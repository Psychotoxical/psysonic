import { useId } from 'react';
import type { TFunction } from 'i18next';
import CustomSelect from '@/ui/CustomSelect';
import { allNormalizedAddresses } from '@/lib/server/serverEndpoint';
import {
  STREAM_FORMAT_OPTIONS,
  STREAM_MAX_BITRATE_OPTIONS,
  sanitizeStreamMaxBitRateKbps,
  sanitizeStreamRequestFormat,
  type StreamMaxBitRateKbps,
  type StreamRequestFormat,
} from '@/lib/audio/streamQuality';

/** Controlled per-address streaming quality editor for a saved Navidrome profile. */
export function ServerStreamQualityEditor({
  url,
  alternateUrl,
  open,
  qualityByAddress,
  formatByAddress,
  onOpenChange,
  onQualityChange,
  onFormatChange,
  t,
}: {
  url: string;
  alternateUrl?: string;
  open: boolean;
  qualityByAddress: Record<string, StreamMaxBitRateKbps>;
  formatByAddress: Record<string, StreamRequestFormat>;
  onOpenChange: (open: boolean) => void;
  onQualityChange: (address: string, quality: StreamMaxBitRateKbps) => void;
  onFormatChange: (address: string, format: StreamRequestFormat) => void;
  t: TFunction;
}) {
  const panelId = `server-stream-quality-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const addresses = allNormalizedAddresses({ url, alternateUrl });
  if (addresses.length === 0) return null;

  return (
    <div className="form-group" style={{ marginBottom: '0.75rem' }}>
      <button
        type="button"
        className="btn btn-ghost btn-ghost--flat"
        style={{ fontSize: 13, padding: '4px 0' }}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {open ? '▾' : '▸'} {t('settings.streamQualityTitle')}
      </button>
      {open && (
        <div
          id={panelId}
          data-settings-search={t('settings.streamQualityTitle')}
          style={{ marginTop: 8 }}
        >
          <p style={{ fontSize: 11, opacity: 0.75, margin: '0 0 8px' }}>
            {t('settings.streamQualityPerAddressDesc')}
          </p>
          {addresses.map(address => (
            <div key={address} style={{ marginBottom: 10 }}>
              <div
                title={address}
                style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 5 }}
              >
                {address}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 170px', minWidth: 0 }}>
                  <CustomSelect
                    ariaLabel={`${t('settings.streamQualityTitle')} · ${address}`}
                    value={String(qualityByAddress[address] ?? 0)}
                    onChange={value => onQualityChange(
                      address,
                      sanitizeStreamMaxBitRateKbps(Number(value)),
                    )}
                    options={STREAM_MAX_BITRATE_OPTIONS.map(kbps => ({
                      value: String(kbps),
                      label: kbps === 0
                        ? t('settings.streamQualityOriginal')
                        : t('settings.streamQualityKbps', { kbps }),
                    }))}
                  />
                </div>
                <div style={{ flex: '1 1 110px', minWidth: 0 }}>
                  <CustomSelect
                    ariaLabel={`${t('settings.streamFormatLabel')} · ${address}`}
                    value={formatByAddress[address] ?? 'auto'}
                    onChange={value => onFormatChange(
                      address,
                      sanitizeStreamRequestFormat(value),
                    )}
                    options={STREAM_FORMAT_OPTIONS.map(option => ({
                      value: option,
                      label: option === 'auto'
                        ? t('settings.streamFormatAuto')
                        : option.toUpperCase(),
                    }))}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
