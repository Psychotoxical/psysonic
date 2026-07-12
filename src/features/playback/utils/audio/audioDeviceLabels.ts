import type { AudioOutputDeviceEntry } from '@/lib/api/audio';

function shortDeviceKey(key: string): string {
  const colon = key.indexOf(':');
  if (colon >= 0) {
    const tail = key.slice(colon + 1).replace(/[{}]/g, '');
    if (tail.length > 12) return `…${tail.slice(-8)}`;
    return tail;
  }
  return key.length > 48 ? `…${key.slice(-20)}` : key;
}

/** Sort by readable label; current OS default first. */
export function sortAudioDeviceEntries(
  devices: AudioOutputDeviceEntry[],
  osDefaultDeviceKey: string | null,
): AudioOutputDeviceEntry[] {
  return [...devices].sort((a, b) => {
    const aDef = osDefaultDeviceKey && a.key === osDefaultDeviceKey;
    const bDef = osDefaultDeviceKey && b.key === osDefaultDeviceKey;
    if (aDef !== bDef) return aDef ? -1 : 1;
    const byLabel = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    if (byLabel !== 0) return byLabel;
    return a.key.localeCompare(b.key);
  });
}

export function buildAudioDeviceSelectOptions(
  devices: AudioOutputDeviceEntry[],
  defaultLabel: string,
  osDefaultDeviceKey: string | null,
  osDefaultMark: string,
  pinnedDevice: string | null,
  notInListSuffix: string,
): { value: string; label: string }[] {
  const labelCounts = new Map<string, number>();
  for (const d of devices) {
    labelCounts.set(d.label, (labelCounts.get(d.label) ?? 0) + 1);
  }
  const pinned = pinnedDevice?.trim() || null;
  const pinnedNotListed = !!(pinned && !devices.some(d => d.key === pinned));
  const ghost: { value: string; label: string }[] = pinnedNotListed
    ? (() => {
        const entry = devices.find(d => d.key === pinned);
        const base = entry?.label ?? pinned;
        let label = `${base} · ${notInListSuffix}`;
        if (osDefaultDeviceKey && pinned === osDefaultDeviceKey) label = `${label} · ${osDefaultMark}`;
        return [{ value: pinned, label }];
      })()
    : [];
  return [
    { value: '', label: defaultLabel },
    ...ghost,
    ...devices.map((d) => {
      const dup = (labelCounts.get(d.label) ?? 0) > 1;
      let label = dup ? `${d.label} · ${shortDeviceKey(d.key)}` : d.label;
      if (osDefaultDeviceKey && d.key === osDefaultDeviceKey) label = `${label} · ${osDefaultMark}`;
      return { value: d.key, label };
    }),
  ];
}

/** Makes raw ALSA device names more readable on Linux (legacy keys without Rust labels). */
export function formatAudioDeviceLabel(name: string): string {
  const cardMatch = name.match(/CARD=([^,]+)/);
  if (!cardMatch) return name;
  const card = cardMatch[1];
  const devM = name.match(/DEV=(\d+)/);
  const devNum = devM ? parseInt(devM[1], 10) : null;
  const subM = name.match(/SUBDEV=(\d+)/);
  const subNum = subM ? parseInt(subM[1], 10) : null;

  if (name.startsWith('iec958:')) return `${card} (S/PDIF)`;
  if (name.startsWith('hdmi:')) {
    const d = devNum !== null ? devNum : 0;
    return `${card} (HDMI · DEV ${d})`;
  }
  if (name.startsWith('sysdefault:')) {
    if (devNum !== null && devNum > 0) return `${card} (default · PCM ${devNum})`;
    return card;
  }
  if (name.startsWith('plughw:')) {
    if (devNum !== null) {
      const sub = subNum !== null ? ` · sub ${subNum}` : '';
      return `${card} (plug · PCM ${devNum}${sub})`;
    }
    return card;
  }
  if (name.startsWith('hw:')) {
    if (devNum !== null) {
      const sub = subNum !== null ? ` · sub ${subNum}` : '';
      return `${card} (hw · PCM ${devNum}${sub})`;
    }
    return `${card} (hw)`;
  }
  if (name.startsWith('front:')) return `${card} (Front)`;
  if (name.startsWith('surround')) return `${card} (${name.split(':')[0]})`;
  const iface = name.split(':')[0];
  if (iface && !['default', 'pulse', 'pipewire'].includes(iface)) {
    if (devNum !== null) return `${card} (${iface} · PCM ${devNum})`;
    return `${card} (${iface})`;
  }
  return card;
}

/** @deprecated Use `sortAudioDeviceEntries` with Rust-provided labels. */
export function sortAudioDeviceIds(devices: string[], osDefaultDeviceId: string | null): string[] {
  return [...devices].sort((a, b) => {
    const aDef = osDefaultDeviceId && a === osDefaultDeviceId;
    const bDef = osDefaultDeviceId && b === osDefaultDeviceId;
    if (aDef !== bDef) return aDef ? -1 : 1;
    const la = formatAudioDeviceLabel(a);
    const lb = formatAudioDeviceLabel(b);
    const byLabel = la.localeCompare(lb, undefined, { sensitivity: 'base' });
    if (byLabel !== 0) return byLabel;
    return a.localeCompare(b);
  });
}
