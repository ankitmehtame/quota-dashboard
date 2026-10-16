import type { ProviderId, ProviderResult } from "./core.js";

export type QuotaAttempt = { configured: boolean; identity?: string; fetch: () => Promise<ProviderResult> };
type Entry = { cachedAt: number; value: ProviderResult };
type State = { generation: number; identity?: string; cached?: Entry; success?: ProviderResult; cooldownUntil?: number; backoff: number };

export function createQuotaCache(options: {
  prepare: (id: ProviderId) => Promise<QuotaAttempt>;
  now?: () => number;
  ttl?: (id: ProviderId) => number;
  onChange?: () => void;
}) {
  const now = options.now ?? Date.now;
  const states = new Map<ProviderId, State>();
  const inFlight = new Map<ProviderId, Promise<ProviderResult>>();
  const cachedCopies = new WeakMap<ProviderResult, ProviderResult>();
  function cachedCopy(value: ProviderResult): ProviderResult {
    const copy = { ...value, cached: true };
    cachedCopies.set(copy, value);
    return copy;
  }
  function isCurrent(id: ProviderId, value: ProviderResult): boolean {
    return states.get(id)?.cached?.value === (cachedCopies.get(value) ?? value);
  }
  const stateFor = (id: ProviderId): State => {
    let state = states.get(id);
    if (!state) { state = { generation: 0, backoff: 0 }; states.set(id, state); }
    return state;
  };
  const safeError = (configured: boolean): ProviderResult => ({ configured, status: "error", errorKind: "internal",
    error: "Quota request failed unexpectedly", windows: [], fetchedAt: new Date(now()).toISOString() });
  const ttlFor = (id: ProviderId) => options.ttl?.(id) ?? (id === "claude" ? 300_000 : 120_000);
  function expiresAt(id: ProviderId): number {
    const state = stateFor(id);
    return state.cooldownUntil ?? (state.cached ? state.cached.cachedAt + ttlFor(id) : now());
  }

  function invalidate(id: ProviderId) {
    const state = stateFor(id);
    state.generation++;
    state.success = undefined;
    // Do not erase a server cooldown when toggling a provider or changing accounts.
    if (state.cached && state.cooldownUntil && state.cooldownUntil > now()) {
      state.cached = { cachedAt: now(), value: { ...state.cached.value, windows: [], creditBalance: undefined,
        planType: undefined, subscriptionActiveUntil: undefined, resetCredits: undefined, stale: false,
        status: "error", errorKind: state.cached.value.errorKind ?? "response",
        error: state.cached.value.error ?? "Quota measurements cleared; refresh is paused until the current cooldown expires" } };
    } else state.cached = undefined;
    inFlight.delete(id);
    options.onChange?.();
  }

  // Credential checks in settings must not leave old-account snapshots available.
  // This observes identity without making an upstream request or bypassing cooldowns.
  function observe(id: ProviderId, identity: string, failure?: ProviderResult) {
    const state = stateFor(id);
    if (state.identity !== identity || failure) {
      invalidate(id);
      state.identity = identity;
      if (failure) {
        state.cached = { cachedAt: now(), value: { ...failure,
          ...(state.cooldownUntil !== undefined && state.cooldownUntil > now() ? { cooldownUntil: state.cooldownUntil } : {}) } };
      }
    }
  }

  function get(id: ProviderId, force = false): Promise<ProviderResult> {
    const state = stateFor(id);
    if (state.cooldownUntil && state.cooldownUntil > now() && state.cached) return Promise.resolve(cachedCopy(state.cached.value));
    const pending = inFlight.get(id);
    if (pending) return pending;
    const ttl = ttlFor(id);
    if (!force && state.cached && now() - state.cached.cachedAt < ttl &&
      !(state.cooldownUntil !== undefined && state.cooldownUntil <= now())) return Promise.resolve(cachedCopy(state.cached.value));

    const generation = state.generation;
    let configured = false;
    let promise: Promise<ProviderResult>;
    promise = Promise.resolve().then(async () => {
      const attempt = await options.prepare(id);
      configured = attempt.configured;
      if (state.generation !== generation) return safeError(configured);
      if (state.identity !== attempt.identity) {
        state.identity = attempt.identity;
        state.cached = undefined;
        state.success = undefined;
        options.onChange?.();
      }
      const value = await attempt.fetch();
      // Invalidation can happen while a request is awaiting the upstream response.
      if (state.generation !== generation) return safeError(configured);
      return value;
    }).catch(() => safeError(configured)).then((result) => {
      if (state.generation !== generation) return safeError(configured);
      let value = result;
      let cooldownUntil = value.cooldownUntil;
      if (value.errorKind === "rate_limit" && !(cooldownUntil !== undefined && cooldownUntil > now())) {
        cooldownUntil = now() + Math.min(300_000 * 2 ** state.backoff, 3_600_000);
        state.backoff = Math.min(state.backoff + 1, 4);
      }
      if (value.status === "ok") state.backoff = 0;
      state.cooldownUntil = cooldownUntil !== undefined && cooldownUntil > now() ? cooldownUntil : undefined;
      value = { ...value, ...(state.cooldownUntil !== undefined ? { cooldownUntil: state.cooldownUntil } : {}) };
      if (value.status === "ok") state.success = value;
      else if (["network", "server", "rate_limit"].includes(value.errorKind ?? "") && state.success) {
        // Copy only measurement fields. Never copy old status, errors, or credentials.
        const success = state.success;
        value = { ...value, windows: success.windows, fetchedAt: success.fetchedAt, creditBalance: success.creditBalance,
          planType: success.planType, subscriptionActiveUntil: success.subscriptionActiveUntil, resetCredits: success.resetCredits, stale: true };
      } else state.success = undefined;
      state.cached = { cachedAt: now(), value };
      options.onChange?.();
      return value;
    }).catch(() => {
      const value = safeError(configured);
      if (state.generation === generation) {
        state.success = undefined;
        state.cached = { cachedAt: now(), value };
      }
      return value;
    }).finally(() => {
      if (inFlight.get(id) === promise) inFlight.delete(id);
    });
    inFlight.set(id, promise);
    return promise;
  }
  return { get, invalidate, expiresAt, observe, isCurrent };
}
