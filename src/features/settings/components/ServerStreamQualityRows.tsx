import { AudioLines } from 'lucide-react';
import type { TFunction } from 'i18next';
import CustomSelect from '@/ui/CustomSelect';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { isNavidromeServer } from '@/lib/server/subsonicServerIdentity';
import { allNormalizedAddresses } from '@/lib/server/serverEndpoint';
import {
  STREAM_FORMAT_OPTIONS,
  STREAM_MAX_BITRATE_OPTIONS,
  sanitizeStreamMaxBitRateKbps,
  sanitizeStreamRequestFormat,
} from '@/lib/audio/streamQuality';

/**
 * Per-ADDRESS streaming-quality (maxBitRate transcode cap) controls for one
 * saved server. Rendered only when the server's identity probe reports
 * Navidrome — the raw/transcode contract this feature depends on is verified
 * there. Each configured address (primary / alternate) gets its own cap, since
 * a LAN endpoint and a public reverse proxy are different transports; playback
 * applies the cap of the address the connect layer selected.
 */
export function ServerStreamQualityRows({ server, t }: { server: ServerProfile; t: TFunction }) {
  const identity = useAuthStore(s => s.subsonicServerIdentityByServer[server.id]);
  const streamQualityByAddress = useAuthStore(s => s.streamQualityByAddress);
  const setStreamQualityForAddress = useAuthStore(s => s.setStreamQualityForAddress);
  const streamFormatByAddress = useAuthStore(s => s.streamFormatByAddress);
  const setStreamFormatForAddress = useAuthStore(s => s.setStreamFormatForAddress);
  if (!isNavidromeServer(identity)) return null;
  const addresses = allNormalizedAddresses(server);
  if (addresses.length === 0) return null;
  return (
    <div
      data-settings-search={t('settings.streamQualityTitle')}
      style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid color-mix(in srgb, var(--text-muted) 18%, transparent)' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', minWidth: 0 }}>
        <AudioLines size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 500 }}>{t('settings.streamQualityTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
            {t('settings.streamQualityPerAddressDesc')}
          </div>
          {addresses.map((address) => (
            <div
              key={address}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginTop: '0.5rem' }}
            >
              <span
                style={{ fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={address}
              >
                {address}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                <div style={{ minWidth: 170 }}>
                  <CustomSelect
                    ariaLabel={`${t('settings.streamQualityTitle')} · ${address}`}
                    value={String(streamQualityByAddress[address] ?? 0)}
                    onChange={(v) => setStreamQualityForAddress(address, sanitizeStreamMaxBitRateKbps(Number(v)))}
                    options={STREAM_MAX_BITRATE_OPTIONS.map((kbps) => ({
                      value: String(kbps),
                      label: kbps === 0
                        ? t('settings.streamQualityOriginal')
                        : t('settings.streamQualityKbps', { kbps }),
                    }))}
                  />
                </div>
                <div style={{ minWidth: 110 }}>
                  <CustomSelect
                    ariaLabel={`${t('settings.streamFormatLabel')} · ${address}`}
                    value={streamFormatByAddress[address] ?? 'auto'}
                    onChange={(v) => setStreamFormatForAddress(address, sanitizeStreamRequestFormat(v))}
                    options={STREAM_FORMAT_OPTIONS.map((fmt) => ({
                      value: fmt,
                      label: fmt === 'auto' ? t('settings.streamFormatAuto') : fmt.toUpperCase(),
                    }))}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
