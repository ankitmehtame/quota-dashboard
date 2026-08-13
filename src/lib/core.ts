export const PROVIDER_IDS = ["codex", "openrouter", "opencode-go"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export const USAGE_SOURCE_IDS = ["codex", "opencode", "hermes"] as const;
export type UsageSourceId = typeof USAGE_SOURCE_IDS[number];

export type QuotaWindow = {
  name: string;
  usedPercent: number | null;
  usedValue: number | null;
  limitValue: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  resetAt: string | null;
  windowSeconds: number | null;
  valueLabel: string | null;
  balanceLabel: string | null;
  spentLabel: string | null;
  source: string;
};

export type ProviderResult = {
  configured: boolean;
  status: string;
  error: string | null;
  fetchedAt: string;
  windows: QuotaWindow[];
  planType?: string | null;
  subscriptionActiveUntil?: string | null;
};

export type ProviderConfig = { enabled: boolean };
export type UsageSourceConfig = { enabled: boolean };
export type AppConfig = {
  providers: Record<ProviderId, ProviderConfig>;
  usageSources: Record<UsageSourceId, UsageSourceConfig>;
};

export type DateRange = { from: string; to: string; timeZone: string };

type ConfigInput = {
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
  usageSources?: Partial<Record<UsageSourceId, Partial<UsageSourceConfig>>>;
};

export const PROVIDER_DEFINITIONS: Record<ProviderId, {
  name: string;
  shortName: string;
  accent: string;
  description: string;
  capabilities: Record<string, boolean>;
}> = {
  codex: {
    name: "Codex / ChatGPT",
    shortName: "Codex",
    accent: "mint",
    description: "Local transcript usage through ccusage",
    capabilities: {
      quota: true,
      usage: true,
      usedPercent: false,
      remainingValue: false,
      resetAt: false,
      historicalUsage: true,
      cost: true,
      tokenCounts: true,
    },
  },
  openrouter: {
    name: "OpenRouter",
    shortName: "OpenRouter",
    accent: "violet",
    description: "API key balance and spending limit",
    capabilities: {
      quota: true,
      usage: true,
      usedPercent: true,
      remainingValue: true,
      resetAt: false,
      historicalUsage: false,
      cost: true,
      tokenCounts: false,
    },
  },
  "opencode-go": {
    name: "OpenCode Go",
    shortName: "Go",
    accent: "blue",
    description: "Rolling, weekly, and monthly dashboard windows",
    capabilities: {
      quota: true,
      usage: false,
      usedPercent: true,
      remainingValue: false,
      resetAt: true,
      historicalUsage: false,
      cost: false,
      tokenCounts: false,
    },
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  providers: {
    codex: { enabled: true },
    openrouter: { enabled: true },
    "opencode-go": { enabled: false },
  },
  usageSources: {
    codex: { enabled: true },
    opencode: { enabled: true },
    hermes: { enabled: true },
  },
};

export function clampPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

export function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatMoney(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function usageWindow(input: Partial<QuotaWindow> & { name: string }): QuotaWindow {
  return {
    name: input.name,
    usedPercent: clampPercent(input.usedPercent ?? NaN),
    usedValue: numberOrNull(input.usedValue),
    limitValue: numberOrNull(input.limitValue),
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? null,
    resetAt: input.resetAt ?? null,
    windowSeconds: numberOrNull(input.windowSeconds),
    valueLabel: input.valueLabel ?? null,
    balanceLabel: input.balanceLabel ?? null,
    spentLabel: input.spentLabel ?? null,
    source: input.source ?? "provider",
  };
}

export function providerStatus({ id, config, result = null }: { id: ProviderId; config?: ProviderConfig; result?: Partial<ProviderResult> | null }) {
  const definition = PROVIDER_DEFINITIONS[id];
  return {
    id,
    name: definition.name,
    shortName: definition.shortName,
    accent: definition.accent,
    description: definition.description,
    enabled: Boolean(config?.enabled),
    configured: Boolean(result?.configured),
    capabilities: definition.capabilities,
    status: result?.status ?? (config?.enabled ? "pending" : "disabled"),
    error: result?.error ?? null,
    fetchedAt: result?.fetchedAt ?? null,
  };
}

export function normalizeConfig(raw: unknown): AppConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const input = raw && typeof raw === "object" ? raw as ConfigInput : {};
  for (const id of PROVIDER_IDS) {
    if (input.providers?.[id] && typeof input.providers[id].enabled === "boolean") {
      config.providers[id].enabled = input.providers[id].enabled;
    }
  }
  for (const id of USAGE_SOURCE_IDS) {
    if (input.usageSources?.[id] && typeof input.usageSources[id].enabled === "boolean") {
      config.usageSources[id].enabled = input.usageSources[id].enabled;
    }
  }
  return config;
}

export function localDateRange(days = 30, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, rangeType = "relative"): DateRange {
  const safeDays = Math.min(365, Math.max(1, Math.trunc(Number(days)) || 30));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const start = new Date(`${today}T12:00:00Z`);
  if (rangeType === "calendar-week") {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    start.setUTCDate(start.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  } else if (rangeType === "calendar-month") {
    start.setUTCDate(1);
  } else if (rangeType === "calendar-year") {
    start.setUTCMonth(0, 1);
  } else {
    start.setUTCDate(start.getUTCDate() - safeDays + 1);
  }
  return {
    from: start.toISOString().slice(0, 10),
    to: today,
    timeZone,
  };
}
