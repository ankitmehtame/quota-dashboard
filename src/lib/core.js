export const PROVIDER_IDS = ["codex", "openrouter", "togetherai", "opencode-go"];
export const USAGE_SOURCE_IDS = ["codex", "opencode", "hermes"];

export const PROVIDER_DEFINITIONS = {
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
  togetherai: {
    name: "Together AI",
    shortName: "Together",
    accent: "orange",
    description: "Organization prepaid balance",
    capabilities: {
      quota: true,
      usage: false,
      usedPercent: false,
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

export const DEFAULT_CONFIG = {
  providers: {
    codex: { enabled: true },
    openrouter: { enabled: true },
    togetherai: { enabled: true },
    "opencode-go": { enabled: false },
  },
  usageSources: {
    codex: { enabled: true },
    opencode: { enabled: true },
    hermes: { enabled: true },
  },
};

export function clampPercent(value) {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

export function numberOrNull(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatMoney(value) {
  if (!Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function usageWindow(input) {
  return {
    name: input.name,
    usedPercent: clampPercent(input.usedPercent),
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

export function providerStatus({ id, config, result = null }) {
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

export function normalizeConfig(raw) {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const id of PROVIDER_IDS) {
    if (raw?.providers?.[id] && typeof raw.providers[id].enabled === "boolean") {
      config.providers[id].enabled = raw.providers[id].enabled;
    }
  }
  for (const id of USAGE_SOURCE_IDS) {
    if (raw?.usageSources?.[id] && typeof raw.usageSources[id].enabled === "boolean") {
      config.usageSources[id].enabled = raw.usageSources[id].enabled;
    }
  }
  return config;
}

export function localDateRange(days = 30, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, rangeType = "relative") {
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
