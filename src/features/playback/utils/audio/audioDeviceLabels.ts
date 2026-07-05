/** Makes raw ALSA device names more readable on Linux.
 *  Values are kept as-is (rodio needs the ALSA name); only the displayed label is cleaned.
 *  e.g. "sysdefault:CARD=U192k" → "U192k"
 *       "hw:CARD=U192k,DEV=0"   → "U192k (hw · PCM 0)"
 *       "hdmi:CARD=NVidia,DEV=1" → "NVidia (HDMI · DEV 1)"  (same DEV as in ALSA string)
 *       "iec958:CARD=PCH,DEV=0" → "PCH (S/PDIF)"
 *  Names without ALSA prefix (pipewire, pulse, default…) are returned unchanged. */
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
  // Other ALSA iface:card,dev — show plugin + PCM so identical cards differ
  const iface = name.split(':')[0];
  if (iface && !['default', 'pulse', 'pipewire'].includes(iface)) {
    if (devNum !== null) return `${card} (${iface} · PCM ${devNum})`;
    return `${card} (${iface})`;
  }
  return card;
}

/** Readable tail when two devices still share the same label (rare after formatAudioDeviceLabel). */
export function audioDeviceDuplicateHint(raw: string): string {
  const cardM = raw.match(/CARD=([^,]+)/);
  const devM = raw.match(/DEV=(\d+)/);
  const subM = raw.match(/SUBDEV=(\d+)/);
  const iface = raw.split(':')[0] || '';
  const parts: string[] = [];
  if (iface) parts.push(iface);
  if (cardM) parts.push(cardM[1]);
  if (devM) parts.push(`PCM ${devM[1]}`);
  if (subM) parts.push(`sub ${subM[1]}`);
  if (parts.length > 1) return parts.join(' · ');
  return raw.length > 56 ? `…${raw.slice(-53)}` : raw;
}

/** When several devices share the same display label, append a disambiguator. */
export function disambiguatedAudioDeviceLabel(raw: string, baseLabel: string, duplicateBase: boolean): string {
  if (!duplicateBase) return baseLabel;
  return `${baseLabel} · ${audioDeviceDuplicateHint(raw)}`;
}

/** cpal order is arbitrary; sort by readable label, current OS default first. */
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

export function buildAudioDeviceSelectOptions(
  devices: string[],
  defaultLabel: string,
  osDefaultDeviceId: string | null,
  osDefaultMark: string,
  pinnedDevice: string | null,
  notInListSuffix: string,
): { value: string; label: string }[] {
  const baseLabels = devices.map(formatAudioDeviceLabel);
  const countByBase = new Map<string, number>();
  for (const b of baseLabels) countByBase.set(b, (countByBase.get(b) ?? 0) + 1);
  const pinned = pinnedDevice?.trim() || null;
  const pinnedNotListed = !!(pinned && !devices.includes(pinned));
  const ghost: { value: string; label: string }[] = pinnedNotListed
    ? (() => {
        const base = formatAudioDeviceLabel(pinned);
        let label = `${base} · ${notInListSuffix}`;
        if (osDefaultDeviceId && pinned === osDefaultDeviceId) label = `${label} · ${osDefaultMark}`;
        return [{ value: pinned, label }];
      })()
    : [];
  return [
    { value: '', label: defaultLabel },
    ...ghost,
    ...devices.map((d, i) => {
      const base = baseLabels[i];
      const dup = (countByBase.get(base) ?? 0) > 1;
      let label = disambiguatedAudioDeviceLabel(d, base, dup);
      if (osDefaultDeviceId && d === osDefaultDeviceId) label = `${label} · ${osDefaultMark}`;
      return { value: d, label };
    }),
  ];
}
