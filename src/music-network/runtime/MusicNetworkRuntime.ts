// MusicNetworkRuntime — the one public API the rest of the app talks to.
//
// Accounts, roles, scrobble fan-out, and enrichment all flow through here. The
// app never imports a wire, preset, or the registry directly. State lives behind
// the MusicNetworkStore port; side effects (browser open, id generation) behind
// RuntimeHost.

import type {
  Account,
  AccountPatch,
  PersistedAccount,
} from '../core/accounts';
import type { CapabilitySet } from '../core/capabilities';
import { MusicNetworkError } from '../core/errors';
import type {
  ArtistStats,
  PresetId,
  RecentTrack,
  ScrobbleEvent,
  StatsPeriod,
  TopItem,
  TopKind,
  TrackRef,
  TrackStats,
  UserProfile,
} from '../core/types';
import type { ConnectContext } from '../contracts/ScrobbleWire';
import { getPreset, requirePreset } from '../registry/presetRegistry';
import { requireWire } from '../registry/wireRegistry';
import { probeAccount } from './CapabilityProbe';
import { resolveEnrichment } from './EnrichmentRouter';
import { resolveWireContext } from './contextResolver';
import { dispatchNowPlaying, dispatchScrobble } from './ScrobbleOrchestrator';
import type { MusicNetworkStore, RuntimeHost } from './store';

export interface ConnectOptions {
  /** Connect-form field values (token, baseUrl, apiKey, apiSecret, …). */
  fields?: Record<string, string>;
  signal?: AbortSignal;
}

function deriveAuthBase(origin: string): string {
  return origin ? `${origin.replace(/\/$/, '')}/api/auth/` : '';
}

export class MusicNetworkRuntime {
  constructor(
    private readonly store: MusicNetworkStore,
    private readonly host: RuntimeHost,
  ) {}

  // ── Accounts ──────────────────────────────────────────────────────────────

  private toAccount(p: PersistedAccount): Account {
    const roles = getPreset(p.presetId)?.manifest.defaultRoles
      ?? { scrobble: false, enrichmentEligible: false };
    return { ...p, roles };
  }

  listAccounts(): Account[] {
    return this.store.getState().accounts.map(a => this.toAccount(a));
  }

  getAccount(id: string): Account | undefined {
    const p = this.store.getState().accounts.find(a => a.id === id);
    return p ? this.toAccount(p) : undefined;
  }

  private persist(accounts: PersistedAccount[]): void {
    this.store.setAccounts(accounts);
  }

  async connect(presetId: PresetId, options: ConnectOptions = {}): Promise<Account> {
    const preset = requirePreset(presetId);
    const wire = requireWire(preset.manifest.wireId);
    const fields = options.fields ?? {};

    const origin = (fields.baseUrl ?? '').trim().replace(/\/$/, '');
    const apiBase = preset.manifest.endpoints?.apiBase
      ?? `${origin}${preset.manifest.selfHostedApiSuffix ?? ''}`;
    const authBase = preset.manifest.endpoints?.authBase ?? deriveAuthBase(origin);
    const apiKey = preset.bundled?.apiKey ?? (fields.apiKey ?? '').trim();
    const apiSecret = preset.bundled?.apiSecret ?? (fields.apiSecret ?? '').trim();

    const ctx: ConnectContext = {
      presetId,
      wireId: preset.manifest.wireId,
      authStrategy: preset.manifest.authStrategy,
      baseUrl: apiBase,
      authBase,
      apiKey,
      apiSecret,
      fields,
      openExternal: this.host.openExternal,
      signal: options.signal,
    };

    const result = await wire.connect(ctx);

    const account: PersistedAccount = {
      id: this.host.newId(),
      presetId,
      wireId: preset.manifest.wireId,
      label: preset.manifest.displayName,
      // Fixed-host presets resolve their base from the manifest; store '' so the
      // preset stays the single source of truth. Self-hosted presets persist the
      // resolved base (origin + suffix).
      baseUrl: preset.manifest.endpoints?.apiBase ? '' : (result.baseUrl ?? apiBase),
      scrobbleEnabled: preset.manifest.defaultRoles.scrobble,
      sessionKey: result.sessionKey,
      username: result.username,
      apiKey,
      apiSecret,
      sessionError: false,
      capabilities: result.capabilities ?? {},
    };

    account.capabilities = await probeAccount(account).catch(() => account.capabilities);

    const state = this.store.getState();
    this.persist([...state.accounts, account]);

    // First enrichment-eligible account with no primary becomes the primary.
    if (preset.manifest.defaultRoles.enrichmentEligible && !state.enrichmentPrimaryId) {
      this.store.setEnrichmentPrimaryId(account.id);
    }

    return this.toAccount(account);
  }

  disconnect(accountId: string): void {
    const state = this.store.getState();
    const wire = (() => {
      const acc = state.accounts.find(a => a.id === accountId);
      return acc ? requireWire(acc.wireId) : undefined;
    })();
    const acc = state.accounts.find(a => a.id === accountId);
    if (acc && wire) wire.disconnect(resolveWireContext(acc));

    this.persist(state.accounts.filter(a => a.id !== accountId));
    if (state.enrichmentPrimaryId === accountId) {
      this.store.setEnrichmentPrimaryId(this.firstEligibleId());
    }
  }

  updateAccount(accountId: string, patch: AccountPatch): void {
    this.persist(
      this.store.getState().accounts.map(a =>
        a.id === accountId ? { ...a, ...patch } : a,
      ),
    );
  }

  // ── Roles ─────────────────────────────────────────────────────────────────

  private firstEligibleId(): string | null {
    const acc = this.store.getState().accounts.find(
      a => getPreset(a.presetId)?.manifest.defaultRoles.enrichmentEligible,
    );
    return acc?.id ?? null;
  }

  getEnrichmentPrimaryId(): string | null {
    return this.store.getState().enrichmentPrimaryId;
  }

  setEnrichmentPrimaryId(accountId: string | null): void {
    if (accountId === null) {
      this.store.setEnrichmentPrimaryId(null);
      return;
    }
    const acc = this.store.getState().accounts.find(a => a.id === accountId);
    if (!acc) {
      throw new MusicNetworkError('CAPABILITY_UNSUPPORTED', `Unknown account ${accountId}`);
    }
    if (!getPreset(acc.presetId)?.manifest.defaultRoles.enrichmentEligible) {
      throw new MusicNetworkError('CAPABILITY_UNSUPPORTED', `${acc.label} cannot be an enrichment primary`, {
        providerId: acc.presetId,
      });
    }
    this.store.setEnrichmentPrimaryId(accountId);
  }

  listEnrichmentCandidates(): Account[] {
    return this.listAccounts().filter(a => a.roles.enrichmentEligible);
  }

  // ── Scrobble fan-out ────────────────────────────────────────────────────────

  private scrobbleTargets(): PersistedAccount[] {
    const state = this.store.getState();
    if (!state.scrobblingMasterEnabled) return [];
    return state.accounts.filter(a => a.scrobbleEnabled && a.sessionKey);
  }

  private orchestratorDeps() {
    return {
      setSessionError: (id: string, invalid: boolean) =>
        this.updateAccount(id, { sessionError: invalid }),
    };
  }

  async dispatchScrobble(event: ScrobbleEvent): Promise<void> {
    await dispatchScrobble(this.scrobbleTargets(), event, this.orchestratorDeps());
  }

  async dispatchNowPlaying(event: ScrobbleEvent): Promise<void> {
    const targets = this.scrobbleTargets().filter(
      a => a.capabilities.nowPlaying?.status === 'yes',
    );
    await dispatchNowPlaying(targets, event, this.orchestratorDeps());
  }

  // ── Enrichment (single primary) ─────────────────────────────────────────────

  private primaryAccount(): PersistedAccount | undefined {
    const { accounts, enrichmentPrimaryId } = this.store.getState();
    return accounts.find(a => a.id === enrichmentPrimaryId);
  }

  private enrichment() {
    return resolveEnrichment(this.primaryAccount());
  }

  async isTrackLoved(ref: TrackRef): Promise<boolean> {
    const e = this.enrichment();
    return e ? e.wire.getTrackLoved(e.ctx, ref) : false;
  }

  async setTrackLoved(ref: TrackRef, loved: boolean): Promise<void> {
    const e = this.enrichment();
    if (e) await e.wire.loveTrack(e.ctx, ref, loved);
  }

  async syncLovedTracks(): Promise<Record<string, boolean>> {
    const e = this.enrichment();
    if (!e) return {};
    const tracks = await e.wire.getAllLovedTracks(e.ctx);
    const map: Record<string, boolean> = {};
    for (const t of tracks) map[`${t.title}::${t.artist}`] = true;
    return map;
  }

  async getSimilarArtists(artistName: string): Promise<string[]> {
    const e = this.enrichment();
    return e ? e.wire.getSimilarArtists(e.ctx, artistName) : [];
  }

  async getTrackStats(ref: TrackRef): Promise<TrackStats | null> {
    const e = this.enrichment();
    return e ? e.wire.getTrackStats(e.ctx, ref) : null;
  }

  async getArtistStats(artistName: string): Promise<ArtistStats | null> {
    const e = this.enrichment();
    return e ? e.wire.getArtistStats(e.ctx, artistName) : null;
  }

  async getUserProfile(): Promise<UserProfile | null> {
    const e = this.enrichment();
    return e ? e.wire.getUserProfile(e.ctx) : null;
  }

  async getTopItems(period: StatsPeriod, kind: TopKind, limit: number): Promise<TopItem[]> {
    const e = this.enrichment();
    return e ? e.wire.getTopItems(e.ctx, period, kind, limit) : [];
  }

  async getRecentTracks(limit: number): Promise<RecentTrack[]> {
    const e = this.enrichment();
    return e ? e.wire.getRecentTracks(e.ctx, limit) : [];
  }

  // ── URLs (enrichment primary) ───────────────────────────────────────────────

  profileUrl(): string | null {
    const e = this.enrichment();
    return e ? e.wire.buildProfileUrl(e.ctx) || null : null;
  }

  artistUrl(artistName: string): string | null {
    const e = this.enrichment();
    return e ? e.wire.buildArtistUrl(e.ctx, artistName) || null : null;
  }

  trackUrl(ref: TrackRef): string | null {
    const e = this.enrichment();
    return e ? e.wire.buildTrackUrl(e.ctx, ref) || null : null;
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  async probeCapabilities(accountId: string): Promise<CapabilitySet> {
    const acc = this.store.getState().accounts.find(a => a.id === accountId);
    if (!acc) throw new MusicNetworkError('PROBE_FAILED', `Unknown account ${accountId}`);
    const caps = await probeAccount(acc);
    this.updateAccount(accountId, { capabilities: caps });
    return caps;
  }

  clearSessionError(accountId: string): void {
    this.updateAccount(accountId, { sessionError: false });
  }
}
