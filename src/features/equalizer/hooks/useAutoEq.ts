import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { commands } from '@/generated/bindings';
import { useEqStore } from '@/store/eqStore';
import { parseFixedBandEqString, type AutoEqVariant, type AutoEqResult } from '@/features/playback/utils/audio/autoEqParse';

/** AutoEQ search/apply state for the Equalizer. Loads the entries index lazily
 * when the section opens, filters client-side, and applies fetched profiles via
 * the EQ store. */
export function useAutoEq() {
  const { t } = useTranslation();
  const applyAutoEq = useEqStore(s => s.applyAutoEq);

  const [autoEqOpen, setAutoEqOpen] = useState(false);
  const [autoEqQuery, setAutoEqQuery] = useState('');
  const [autoEqResults, setAutoEqResults] = useState<AutoEqResult[]>([]);
  const [autoEqLoading, setAutoEqLoading] = useState(false);
  const [autoEqError, setAutoEqError] = useState<string | null>(null);
  const [autoEqApplied, setAutoEqApplied] = useState<string | null>(null);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const entriesCacheRef = useRef<Record<string, AutoEqVariant[]> | null>(null);

  // AutoEQ: load entries index lazily when section opens, then filter client-side
  async function ensureEntries() {
    if (entriesCacheRef.current) return;
    setEntriesLoading(true);
    setAutoEqError(null);
    try {
      const entriesRes = await commands.autoeqEntries();
      if (entriesRes.status === 'error') throw new Error(entriesRes.error);
      const json = entriesRes.data;
      entriesCacheRef.current = JSON.parse(json);
    } catch (e: unknown) {
      setAutoEqError(e instanceof Error ? e.message : t('settings.eqAutoEqError'));
    } finally {
      setEntriesLoading(false);
    }
  }

  useEffect(() => {
    const q = autoEqQuery.trim().toLowerCase();
    if (!entriesCacheRef.current || q.length < 1) { setAutoEqResults([]); return; }
    const flat: AutoEqResult[] = [];
    for (const [name, variants] of Object.entries(entriesCacheRef.current)) {
      if (!name.toLowerCase().includes(q)) continue;
      for (const v of variants) {
        flat.push({ name, source: v.source, rig: v.rig, form: v.form });
        if (flat.length >= 20) break;
      }
      if (flat.length >= 20) break;
    }
    setAutoEqResults(flat);
  // entriesLoading in deps: re-runs after entries finish loading so a query typed
  // during loading produces results immediately without needing a re-type.
  }, [autoEqQuery, entriesLoading]);

  async function applyAutoEqResult(result: AutoEqResult) {
    setAutoEqLoading(true);
    setAutoEqError(null);
    try {
      const fetchRes = await commands.autoeqFetchProfile(
        result.name,
        result.source,
        result.rig ?? null,
        result.form,
      );
      if (fetchRes.status === 'error') throw new Error(fetchRes.error);
      const text = fetchRes.data;
      if (!text) throw new Error(t('settings.eqAutoEqFetchError'));
      const { gains: newGains, preamp } = parseFixedBandEqString(text);
      applyAutoEq(result.name, newGains, preamp);
      setAutoEqApplied(result.name);
      setAutoEqQuery('');
      setAutoEqResults([]);
      setTimeout(() => setAutoEqApplied(null), 3000);
    } catch (e: unknown) {
      setAutoEqError(e instanceof Error ? e.message : t('settings.eqAutoEqFetchError'));
    } finally {
      setAutoEqLoading(false);
    }
  }

  const toggleOpen = () => {
    const opening = !autoEqOpen;
    setAutoEqOpen(opening);
    setAutoEqQuery('');
    setAutoEqResults([]);
    setAutoEqError(null);
    if (opening) ensureEntries();
  };

  return {
    autoEqOpen, autoEqQuery, autoEqResults, autoEqLoading, autoEqError, autoEqApplied,
    entriesLoading, setAutoEqQuery, setAutoEqError, setAutoEqResults,
    applyAutoEqResult, toggleOpen,
  };
}
