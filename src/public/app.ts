type QuotaWindow = { name?: string; usedPercent?: number | null; usedValue?: number | null; limitValue?: number | null; requestCount?: number | null; unit?: string | null; resetAt?: string | null; windowSeconds?: number | null; valueLabel?: string | null; balanceLabel?: string | null; spentLabel?: string | null };
type Provider = { id: string; name: string; shortName: string; accent: string; description: string; enabled: boolean; configured: boolean; status: string };
type ModelUsageItem = { model: string; costUsd: number; totalTokens?: number };
type UsageModel = ModelUsageItem & { provider: string };
type UsageModelGroup = { provider: string; models: ModelUsageItem[] };
type UsageDay = { date: string; costUsd: number; totalTokens: number; byProvider?: Record<string, { costUsd: number; totalTokens: number }>; byModel?: UsageModelGroup[] };
type ChartRepresentation = "auto" | "day" | "week" | "month";
type ConcreteRepresentation = Exclude<ChartRepresentation, "auto">;
type UsageBucket = UsageDay & { from: string; to: string; days: UsageDay[] };
type UsageRecord = { hostId?: string; date: string; provider: string; model: string; inputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number };
type UsageHost = { hostId: string; generatedAt?: string | null; category?: string | null; status: string; error?: string | null; stale?: boolean; local?: boolean; active?: boolean; included?: boolean; complete?: boolean; usable?: boolean; disabledReason?: string | null };
type Usage = { totalCostUsd: number; totalTokens?: number; from?: string; to?: string; providers?: string[]; daily?: UsageDay[]; byModel?: UsageModel[]; byProvider?: Array<{ provider: string; costUsd: number; totalTokens: number }>; records?: UsageRecord[]; error?: string | null; hosts?: UsageHost[]; mqtt?: { configured: boolean; connection: string } };
type Dashboard = { version: string; providerOrder: string[]; providers: Record<string, Provider>; quotas: Record<string, { windows?: QuotaWindow[]; planType?: string; subscriptionActiveUntil?: string | null; resetCredits?: Array<{ id: string; title: string; description?: string | null; expiresAt?: string | null }>; fetchedAt?: string; error?: string | null }>; usage: Usage; serverNow: string; cache?: { fetchedAt?: string } };
type UsageResponse = { version: string; apiVersion: number; serverNow: string; timezone: string; from: string; to: string; usage: Usage };
type AppState = { days: number; range: string; representation: ChartRepresentation; dashboard: Dashboard | null; hostSelections: Map<string, boolean>; chartScrollLeft: number };
const timeFormatStorageKey = "quota-dashboard.time-format";
const storedTimeFormat = localStorage.getItem(timeFormatStorageKey);
const defaultHour12 = new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hour12 ?? true;
const state: AppState & { hour12: boolean } = { days: 1, range: "today", representation: "auto", dashboard: null, hostSelections: new Map(), chartScrollLeft: 0, hour12: storedTimeFormat === "12" || (storedTimeFormat !== "24" && defaultHour12) };
const $ = (selector: string): any => document.querySelector(selector);
const element = (target: EventTarget | null): HTMLElement => target as HTMLElement;
const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
let providerOrder = ["codex", "openrouter", "opencode-go", "ollama"];
const usageSourceOrder = ["codex", "opencode", "hermes", "antigravity"];
const usageSourceNames: Record<string, string> = { codex: "Codex", opencode: "OpenCode", hermes: "Hermes", antigravity: "Antigravity" };
const HOT_USAGE_POLL_INTERVAL_MS = 5_000;
const HOT_USAGE_RETRY_GRACE_PERIOD_MS = 15_000;
const HOT_USAGE_POLL_TIMEOUT_MS = 2 * 60 * 1000;
let activeChartTooltip: { anchor: HTMLElement; tooltip: HTMLElement } | null = null;
let activeQuotaTooltip: { anchor: HTMLElement; tooltip: HTMLElement } | null = null;
let activeHostStatusPopover: { anchor: HTMLButtonElement; popover: HTMLElement } | null = null;
let activeDetailsTrigger: HTMLButtonElement | null = null;
type HotUsageBaseline = Map<string, { generatedAt: number; error: string | null }>;
let hotUsagePoller: { timer: number; startedAt: number; baseline: HotUsageBaseline; targetHostIds: Set<string>; retryGraceHostIds: Set<string>; requestInFlight: boolean } | null = null;
let activeRefreshes = 0;

function positionChartTooltip(anchor: HTMLElement, tooltip: HTMLElement): void {
  const margin = 8;
  const gap = 10;
  tooltip.style.position = "fixed";
  tooltip.style.visibility = "hidden";

  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
  const centeredLeft = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
  const left = Math.min(Math.max(centeredLeft, margin), maxLeft);
  const aboveTop = anchorRect.top - tooltipRect.height - gap;
  const belowTop = anchorRect.bottom + gap;
  const maxTop = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
  const top = aboveTop >= margin ? aboveTop : belowTop <= maxTop ? belowTop : maxTop;

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.bottom = "auto";
  tooltip.style.transform = "none";
  tooltip.style.visibility = "visible";
}

function bindChartTooltips(chart: HTMLElement): void {
  chart.querySelectorAll<HTMLElement>(".chart-segment").forEach((segment) => {
    const tooltip = segment.querySelector<HTMLElement>(".chart-tooltip");
    if (!tooltip) return;
    segment.addEventListener("pointerenter", () => {
      activeChartTooltip = { anchor: segment, tooltip };
      positionChartTooltip(segment, tooltip);
    });
    segment.addEventListener("pointerleave", () => {
      if (activeChartTooltip?.tooltip === tooltip) activeChartTooltip = null;
    });
  });
}

function positionQuotaTooltip(anchor: HTMLElement, tooltip: HTMLElement): void {
  const margin = 8;
  const gap = 10;
  tooltip.classList.add("is-positioned");
  tooltip.style.position = "fixed";
  tooltip.style.visibility = "hidden";

  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
  const centeredLeft = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
  const left = Math.min(Math.max(centeredLeft, margin), maxLeft);
  const aboveTop = anchorRect.top - tooltipRect.height - gap;
  const belowTop = anchorRect.bottom + gap;
  const maxTop = Math.max(margin, window.innerHeight - tooltipRect.height - margin);
  const top = aboveTop >= margin ? aboveTop : belowTop <= maxTop ? belowTop : maxTop;

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.bottom = "auto";
  tooltip.style.transform = "none";
  tooltip.style.visibility = "visible";
}

function clearQuotaTooltip(tooltip: HTMLElement): void {
  tooltip.classList.remove("is-positioned");
  tooltip.style.position = "";
  tooltip.style.visibility = "";
  tooltip.style.left = "";
  tooltip.style.top = "";
  tooltip.style.bottom = "";
  tooltip.style.transform = "";
}

function bindQuotaTooltips(): void {
  document.querySelectorAll<HTMLElement>(".quota-now-marker").forEach((marker) => {
    const tooltip = marker.querySelector<HTMLElement>(".quota-now-tooltip");
    if (!tooltip) return;
    const show = () => {
      activeQuotaTooltip = { anchor: marker, tooltip };
      positionQuotaTooltip(marker, tooltip);
    };
    const hide = () => {
      if (document.activeElement === marker) return;
      if (activeQuotaTooltip?.tooltip === tooltip) activeQuotaTooltip = null;
      clearQuotaTooltip(tooltip);
    };
    marker.addEventListener("pointerenter", show);
    marker.addEventListener("pointerleave", hide);
    marker.addEventListener("focus", show);
    marker.addEventListener("blur", hide);
  });
}

function positionHostStatusPopover(anchor: HTMLElement, popover: HTMLElement): void {
  const margin = 8;
  const gap = 10;
  popover.style.position = "fixed";
  popover.style.visibility = "hidden";

  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - popoverRect.width - margin);
  const left = Math.min(Math.max(anchorRect.left + (anchorRect.width - popoverRect.width) / 2, margin), maxLeft);
  const aboveTop = anchorRect.top - popoverRect.height - gap;
  const belowTop = anchorRect.bottom + gap;
  const maxTop = Math.max(margin, window.innerHeight - popoverRect.height - margin);
  const top = aboveTop >= margin ? aboveTop : belowTop <= maxTop ? belowTop : maxTop;

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.style.visibility = "visible";
}

function closeHostStatusPopover(): void {
  if (!activeHostStatusPopover) return;
  activeHostStatusPopover.popover.hidden = true;
  activeHostStatusPopover.popover.style.position = "";
  activeHostStatusPopover.popover.style.left = "";
  activeHostStatusPopover.popover.style.top = "";
  activeHostStatusPopover.popover.style.visibility = "";
  activeHostStatusPopover.anchor.setAttribute("aria-expanded", "false");
  activeHostStatusPopover = null;
}

function toggleHostStatusPopover(anchor: HTMLButtonElement): void {
  if (activeHostStatusPopover?.anchor === anchor) {
    closeHostStatusPopover();
    return;
  }
  closeHostStatusPopover();
  const targetId = anchor.dataset.statusTarget;
  const popover = targetId ? document.getElementById(targetId) : null;
  if (!popover) return;
  popover.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  activeHostStatusPopover = { anchor, popover };
  positionHostStatusPopover(anchor, popover);
}

function money(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value ?? 0);
}

function usagePresetLabel(range: string): string {
  return ({ today: "Today", "calendar-week": "Week", "calendar-month": "Month", "calendar-year": "Year", "relative-7": "7D", "relative-15": "15D", "relative-30": "30D", "relative-90": "90D", "relative-180": "180D", "relative-365": "1Y" } as Record<string, string>)[range] || range;
}

function representationLabel(representation: ChartRepresentation): string {
  return ({ auto: "Auto", day: "Day", week: "Week", month: "Month" } as Record<ChartRepresentation, string>)[representation];
}

function defaultRepresentationForDays(days: number): ConcreteRepresentation {
  const safeDays = Math.max(1, Math.trunc(days) || 1);
  return safeDays > 90 ? "month" : safeDays > 30 ? "week" : "day";
}

function autoRepresentationForRange(range: string, days: number): ConcreteRepresentation {
  if (range === "today" || range === "calendar-week" || range === "calendar-month") return "day";
  if (range === "calendar-year") return "month";
  return defaultRepresentationForDays(days);
}

function activeRepresentation(): ConcreteRepresentation {
  return state.range === "today" || state.representation === "auto"
    ? autoRepresentationForRange(state.range, state.days)
    : state.representation;
}

function updateRepresentationControls(): void {
  const button = $("#representation-menu-button") as HTMLButtonElement | null;
  if (!button) return;
  const active = activeRepresentation();
  const selectedLabel = state.representation === "auto" ? `Auto · ${representationLabel(active)}` : representationLabel(active);
  const selectedValue = state.representation === "auto" ? "auto" : active;
  if (button.firstChild) button.firstChild.textContent = `${selectedLabel} `;
  button.setAttribute("aria-label", `View usage by ${selectedLabel.toLowerCase()}`);
  document.querySelectorAll<HTMLButtonElement>("[data-representation]").forEach((item) => {
    const value = item.dataset.representation as ChartRepresentation | undefined;
    item.classList.toggle("active", value === selectedValue);
    item.disabled = state.range === "today" && (value === "week" || value === "month");
  });
}

function localApiDate(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  // Use local noon so a DST transition at local midnight cannot move the
  // displayed calendar date to an adjacent day.
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

function calendarDate(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  // Usage dates are server-local calendar dates, so group them at UTC noon.
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
}

function compactUsageDateRange(from: string | undefined, to: string | undefined): string {
  const start = localApiDate(from);
  const end = localApiDate(to);
  if (!start || !end || start > end) return "—";
  const includeYear = start.getFullYear() !== new Date().getFullYear() || end.getFullYear() !== new Date().getFullYear();
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) });
  return formatter.formatRange(start, end);
}

function formatTokens(value: number | null | undefined): string {
  return (value || 0).toLocaleString();
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "not fetched";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}

function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "no reset reported";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "reset time unavailable";
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const duration = days > 0 ? `${days}d ${hours}h ${remainder}m` : hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
  const date = new Intl.DateTimeFormat([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: state.hour12 }).format(new Date(timestamp));
  return `resets in ${duration} · ${date}`;
}

function quotaValue(value: number | null | undefined, unit: string | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  const formatted = (value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return unit ? `${formatted} ${unit}` : formatted;
}

function quotaNowPosition(window: QuotaWindow | undefined, providerId: string): number | null {
  const now = Date.now();
  const resetAt = window?.resetAt ? Date.parse(window.resetAt) : NaN;
  if (Number.isFinite(resetAt)) {
    let startAt = window?.windowSeconds ? resetAt - window.windowSeconds * 1000 : null;
    if (startAt === null && providerId === "ollama" && window?.name === "monthly") {
      const resetDate = new Date(resetAt);
      const year = resetDate.getUTCFullYear();
      const month = resetDate.getUTCMonth();
      const day = Math.min(resetDate.getUTCDate(), new Date(Date.UTC(year, month, 0)).getUTCDate());
      startAt = Date.UTC(year, month - 1, day, resetDate.getUTCHours(), resetDate.getUTCMinutes(), resetDate.getUTCSeconds(), resetDate.getUTCMilliseconds());
    }
    if (startAt === null || now < startAt || now > resetAt) return null;
    return ((now - startAt) / (resetAt - startAt)) * 100;
  }
  if (providerId !== "ollama" || window?.name !== "monthly") return null;
  const current = new Date(now);
  const startAt = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
  const endAt = new Date(current.getFullYear(), current.getMonth() + 1, 1).getTime();
  return ((now - startAt) / (endAt - startAt)) * 100;
}

function formatRefreshTime(iso: string | null | undefined): string {
  return iso ? new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: state.hour12 }).format(new Date(iso)) : "unknown";
}

function formatRenewalDate(iso: string | null | undefined): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat([], { year: "numeric", month: "short", day: "numeric" }).format(new Date(iso));
}

function formatPercent(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function quotaCard(id: string, provider: Provider, quota: Dashboard["quotas"][string]): string {
  const windows = quota?.windows?.length ? quota.windows : [undefined];
  const status = provider.status === "disabled" ? "off" : provider.status === "error" ? "error" : provider.configured ? "connected" : "setup needed";
  const renewalDate = formatRenewalDate(quota?.subscriptionActiveUntil);
  const plan = quota?.planType || renewalDate
    ? `<div class="quota-plan">${quota?.planType ? `${escapeHtml(quota.planType)} plan` : ""}${quota?.planType && renewalDate ? '<span class="quota-renewal"> · </span>' : ""}${renewalDate ? `<span class="quota-renewal">Renews ${escapeHtml(renewalDate)}</span>` : ""}</div>`
    : "";
  const resetCredits = quota?.resetCredits?.length ? `<div class="quota-resets"><div class="quota-resets-title">Usage limit resets</div>${quota.resetCredits.map((credit) => {
    const expiry = formatRenewalDate(credit.expiresAt);
    return `<div class="quota-reset"><span class="quota-reset-title">${escapeHtml(credit.title)}</span><span class="quota-reset-expiry">${expiry ? `Expires ${escapeHtml(expiry)}` : "Expiration not reported"}</span></div>`;
  }).join("")}</div>` : "";
  const refreshedAt = quota?.fetchedAt || state.dashboard?.cache?.fetchedAt;
  const content = windows.map((window, index) => {
    const percent = window?.usedPercent;
    const value = window?.balanceLabel ? `<span class="quota-balance-primary">${escapeHtml(window.balanceLabel)}</span><span class="quota-balance-secondary">${escapeHtml(window.spentLabel || "")}</span>` : escapeHtml(window?.valueLabel || "Not available");
    const nowPosition = quotaNowPosition(window, provider.id);
    const nowExpected = nowPosition === null ? null : Math.floor(nowPosition * 10) / 10;
    const approximateNow = provider.id === "ollama" && window?.name === "monthly";
    const percentageValue = percent == null
      ? value
      : `<span class="quota-used-percent">${formatPercent(percent)}% <small>used</small></span>${nowExpected === null ? "" : `<span class="quota-expected-percent">/ ${formatPercent(nowExpected)}% elapsed</span>`}`;
    const label = windows.length > 1
      ? window?.valueLabel || ""
      : percent == null && window?.valueLabel
        ? ""
        : window?.valueLabel || (provider.id === "codex" ? "" : provider.configured ? "No balance reported" : "Configure credentials on server");
    const formattedLimit = quotaValue(window?.limitValue, window?.unit);
    const limitLabel = formattedLimit === null ? "" : `limit ${formattedLimit}`;
    const requestLabel = window?.requestCount == null ? "" : `${window.requestCount.toLocaleString("en-US")} ${window.requestCount === 1 ? "request" : "requests"}`;
    const footLabel = [label, limitLabel, requestLabel].filter(Boolean).join(" · ");
    const resetLabel = window?.resetAt ? timeUntil(window.resetAt) : provider.id === "ollama" && provider.configured ? "reset not reported" : "";
    const nowDescription = approximateNow
      ? window?.resetAt ? `${nowExpected}% of monthly window elapsed (start inferred)` : `${nowExpected}% of calendar month elapsed (approx.)`
      : `${nowExpected}% of window elapsed`;
    const showWindowName = windows.length > 1 || provider.id === "codex" || provider.id === "ollama";
    return `<div class="quota-window${index ? " quota-window-separated" : ""}">${showWindowName ? `<div class="quota-window-name">${escapeHtml(window?.name || "Usage")}</div>` : ""}<div class="quota-percent ${percent == null && !window?.valueLabel ? "unavailable" : percent == null ? "quota-balance" : "quota-percentage"}">${percentageValue}</div>${percent != null ? `<div class="bar"><span style="width:${Math.min(percent, 100)}%"></span>${nowPosition !== null ? `<button class="quota-now-marker" style="left:${nowPosition}%" type="button" aria-label="${approximateNow ? "Approximate current monthly position" : "Current quota window position"}"><span class="quota-now-tooltip"><strong>Now</strong><span>${nowDescription}</span><span>Snapshot: ${escapeHtml(formatRefreshTime(refreshedAt))}</span></span></button>` : ""}</div>` : ""}<div class="quota-foot">${footLabel ? `<span>${escapeHtml(footLabel)}</span>` : ""}<span>${resetLabel}</span></div></div>`;
  }).join("");
  const accent = /^[a-z-]+$/.test(provider.accent) ? provider.accent : "mint";
  return `<article class="quota-card" style="--accent: var(--${accent})"><div class="provider-head"><div><div class="provider-name">${escapeHtml(provider.shortName)}</div><div class="provider-sub">${escapeHtml(provider.description)}</div></div><span class="provider-badge">${escapeHtml(status)}</span></div>${plan}<div class="quota-main">${content}${resetCredits}${quota?.error ? `<div class="quota-error">${escapeHtml(quota.error)}</div>` : ""}</div></article>`;
}

function renderQuotas(data: Dashboard): void {
  $("#quota-grid").innerHTML = providerOrder.filter((id) => data.providers[id]?.enabled).map((id) => quotaCard(id, data.providers[id], data.quotas[id])).join("") || `<div class="quota-card"><div class="quota-empty">No providers enabled. Open Manage providers to begin.</div></div>`;
  activeQuotaTooltip = null;
  bindQuotaTooltips();
}

function recordTokens(record: UsageRecord): number {
  return record.inputTokens + record.cachedInputTokens + record.cacheCreationTokens + record.outputTokens + record.reasoningTokens;
}

function hostHealthy(host: UsageHost): boolean {
  return ["ok", "online"].includes(host.status) && !host.error && !host.stale && host.included !== false && host.complete !== false;
}

function enabledUsageProviders(usage: Usage): Set<string> | null {
  if (!usage.providers) return null;
  const providers = new Set(usage.providers);
  if (providers.has("opencode") || providers.has("hermes") || providers.has("antigravity")) providers.add("shared");
  return providers;
}

function recordsForHosts(usage: Usage, selectedHostIds: Set<string>): UsageRecord[] {
  const providers = enabledUsageProviders(usage);
  return (usage.records || []).filter((record) => record.hostId !== undefined && selectedHostIds.has(record.hostId) && (!providers || providers.has(record.provider)));
}

function summarizeSelectedRecords(records: UsageRecord[]): Pick<Usage, "daily" | "byModel" | "byProvider" | "totalCostUsd" | "totalTokens"> {
  const daily = new Map<string, UsageDay>();
  const byModel = new Map<string, UsageModel>();
  const byProvider = new Map<string, { provider: string; costUsd: number; totalTokens: number }>();
  for (const record of records) {
    const totalTokens = recordTokens(record);
    const day = daily.get(record.date) || { date: record.date, costUsd: 0, totalTokens: 0, byProvider: {}, byModel: [] };
    day.costUsd += record.costUsd;
    day.totalTokens += totalTokens;
    const dayProvider = day.byProvider?.[record.provider] || { costUsd: 0, totalTokens: 0 };
    dayProvider.costUsd += record.costUsd;
    dayProvider.totalTokens += totalTokens;
    day.byProvider = { ...day.byProvider, [record.provider]: dayProvider };
    let dayGroup = day.byModel?.find((group) => group.provider === record.provider);
    if (!dayGroup) {
      dayGroup = { provider: record.provider, models: [] };
      day.byModel = [...(day.byModel || []), dayGroup];
    }
    let dayModel = dayGroup.models.find((model) => model.model === record.model);
    if (!dayModel) {
      dayModel = { model: record.model, costUsd: 0, totalTokens: 0 };
      dayGroup.models.push(dayModel);
    }
    dayModel.costUsd += record.costUsd;
    dayModel.totalTokens = (dayModel.totalTokens || 0) + totalTokens;
    daily.set(record.date, day);

    const modelKey = `${record.provider}\u0000${record.model}`;
    const model = byModel.get(modelKey) || { provider: record.provider, model: record.model, costUsd: 0, totalTokens: 0 };
    model.costUsd += record.costUsd;
    model.totalTokens = (model.totalTokens || 0) + totalTokens;
    byModel.set(modelKey, model);
    const provider = byProvider.get(record.provider) || { provider: record.provider, costUsd: 0, totalTokens: 0 };
    provider.costUsd += record.costUsd;
    provider.totalTokens += totalTokens;
    byProvider.set(record.provider, provider);
  }
  return {
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    byProvider: [...byProvider.values()].sort((a, b) => b.costUsd - a.costUsd),
    totalCostUsd: records.reduce((total, record) => total + record.costUsd, 0),
    totalTokens: records.reduce((total, record) => total + recordTokens(record), 0),
  };
}

function hostUsable(usage: Usage, host: UsageHost): boolean {
  if (host.usable !== undefined) return host.usable;
  return Boolean(usage.records?.some((record) => record.hostId === host.hostId));
}

function hostHasRecords(usage: Usage, host: UsageHost): boolean {
  return Boolean(usage.records?.some((record) => record.hostId === host.hostId));
}

function reconcileHostSelections(usage: Usage): { hosts: UsageHost[]; usableHosts: UsageHost[]; selectedHostIds: Set<string> } {
  const hosts = usage.hosts || [];
  const usableHosts = hosts.filter((host) => hostUsable(usage, host));
  for (const host of usableHosts) {
    if (!state.hostSelections.has(host.hostId)) state.hostSelections.set(host.hostId, true);
  }
  return { hosts, usableHosts, selectedHostIds: new Set(usableHosts.filter((host) => state.hostSelections.get(host.hostId) !== false).map((host) => host.hostId)) };
}

function filterUsageByHosts(usage: Usage, selectedHostIds: Set<string>): Usage {
  if (!usage.records) return selectedHostIds.size ? { ...usage, daily: [], byModel: [], byProvider: [], totalCostUsd: Number.NaN, totalTokens: 0 } : { ...usage, daily: [], byModel: [], byProvider: [], totalCostUsd: 0, totalTokens: 0 };
  const records = recordsForHosts(usage, selectedHostIds);
  return { ...usage, records, ...summarizeSelectedRecords(records) };
}

function emptyUsageDay(date: string): UsageDay {
  return { date, costUsd: 0, totalTokens: 0, byProvider: {}, byModel: [] };
}

function usageDaysForRange(usage: Usage): UsageDay[] {
  const sourceDays = usage.daily || [];
  const daily = new Map(sourceDays.map((day) => [day.date, day]));
  const from = usage.from || sourceDays[0]?.date;
  const to = usage.to || sourceDays[sourceDays.length - 1]?.date;
  if (!from || !to || from > to || !calendarDate(from) || !calendarDate(to)) return sourceDays;
  const days: UsageDay[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) days.push(daily.get(date) || emptyUsageDay(date));
  return days;
}

function usagePeriodStart(date: string, representation: ConcreteRepresentation): string {
  const parsed = calendarDate(date);
  if (!parsed || representation === "day") return date;
  if (representation === "month") return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const weekday = parsed.getUTCDay();
  parsed.setUTCDate(parsed.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return parsed.toISOString().slice(0, 10);
}

function addUsageDay(bucket: UsageBucket, day: UsageDay): void {
  bucket.costUsd += day.costUsd;
  bucket.totalTokens += day.totalTokens;
  bucket.from = day.date < bucket.from ? day.date : bucket.from;
  bucket.to = day.date > bucket.to ? day.date : bucket.to;
  bucket.days.push(day);
  for (const [provider, value] of Object.entries(day.byProvider || {})) {
    const current = bucket.byProvider?.[provider] || { costUsd: 0, totalTokens: 0 };
    current.costUsd += value.costUsd;
    current.totalTokens += value.totalTokens;
    bucket.byProvider = { ...(bucket.byProvider || {}), [provider]: current };
  }
  for (const group of day.byModel || []) {
    let target = bucket.byModel?.find((item) => item.provider === group.provider);
    if (!target) {
      target = { provider: group.provider, models: [] };
      bucket.byModel = [...(bucket.byModel || []), target];
    }
    for (const model of group.models) {
      const current = target.models.find((item) => item.model === model.model);
      if (current) {
        current.costUsd += model.costUsd;
        current.totalTokens = (current.totalTokens || 0) + (model.totalTokens || 0);
      } else {
        target.models.push({ ...model, totalTokens: model.totalTokens || 0 });
      }
    }
  }
}

function usageBuckets(usage: Usage, representation: ConcreteRepresentation): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const day of usageDaysForRange(usage)) {
    const key = usagePeriodStart(day.date, representation);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { ...emptyUsageDay(day.date), from: day.date, to: day.date, days: [] };
      buckets.set(key, bucket);
    }
    addUsageDay(bucket, day);
  }
  return [...buckets.values()].sort((a, b) => a.from.localeCompare(b.from));
}

function usageBucketLabel(bucket: UsageBucket, representation: ConcreteRepresentation): string {
  return representation === "day" ? bucket.date : compactUsageDateRange(bucket.from, bucket.to);
}

function todaySpend(usage: Usage, hosts: UsageHost[], usableHosts: UsageHost[], selectedHostIds: Set<string>): { amount: number; known: boolean; partial: boolean } {
  // An explicit empty selection is a valid zero. No usable hosts means there
  // is no trustworthy source from which to infer a zero.
  if (!usableHosts.length) return { amount: 0, known: false, partial: false };
  if (!selectedHostIds.size) return { amount: 0, known: true, partial: false };
  if (!usage.records || !usage.to) return { amount: 0, known: false, partial: false };
  const selectedHosts = hosts.filter((host) => selectedHostIds.has(host.hostId));
  const records = recordsForHosts(usage, selectedHostIds);
  const currentRecords = records.filter((record) => record.date === usage.to);
  const hasTrustworthyAmount = selectedHosts.some(hostHealthy) || currentRecords.length > 0;
  return {
    amount: currentRecords.reduce((total, record) => total + record.costUsd, 0),
    known: hasTrustworthyAmount,
    partial: hasTrustworthyAmount && selectedHosts.some((host) => !hostHealthy(host)),
  };
}

function renderSpendMetrics(usage: Usage, hosts: UsageHost[], usableHosts: UsageHost[], selectedUsage: Usage, selectedHostIds: Set<string>): void {
  const dateRange = compactUsageDateRange(usage.from, usage.to);
  const noHostsSelected = usableHosts.length > 0 && selectedHostIds.size === 0;
  const selectedHosts = hosts.filter((host) => selectedHostIds.has(host.hostId));
  const periodKnown = noHostsSelected || Boolean(selectedUsage.records?.length) || selectedHosts.some(hostHealthy);
  const periodAmount = selectedUsage.totalCostUsd;
  $("#usage-total").textContent = money(periodKnown ? periodAmount : Number.NaN);
  $("#usage-total-caption").textContent = `Estimated spend · ${usagePresetLabel(state.range)} · ${dateRange}`;

  const todayMetric = $("#today-metric") as HTMLElement;
  todayMetric.hidden = state.range === "today";
  if (todayMetric.hidden) return;
  const today = todaySpend(usage, hosts, usableHosts, selectedHostIds);
  $("#today-total").textContent = money(today.known ? today.amount : Number.NaN);
  $("#today-caption").textContent = `Today so far${today.partial ? " · partial" : ""}`;
}

function renderUsage(usage: Usage, scrollMode: "newest" | "preserve" = "preserve"): void {
  closeHostStatusPopover();
  if (scrollMode === "preserve") {
    const scroll = document.querySelector<HTMLElement>(".chart-scroll");
    if (scroll) state.chartScrollLeft = scroll.scrollLeft;
  }
  const { hosts, usableHosts, selectedHostIds } = reconcileHostSelections(usage);
  const selectedUsage = filterUsageByHosts(usage, selectedHostIds);
  const noHostsSelected = usableHosts.length > 0 && selectedHostIds.size === 0;
  renderSpendMetrics(usage, hosts, usableHosts, selectedUsage, selectedHostIds);
  updateRepresentationControls();
  $("#axis-start").textContent = selectedUsage.from || "—";
  const sourceNames: Record<string, string> = { ...usageSourceNames, shared: "Shared" };
  const sourceColors: Record<string, string> = { codex: "mint", opencode: "violet", hermes: "orange", antigravity: "blue", shared: "neutral" };
  const enabledSources = new Set(usage.providers || []);
  $(".chart-legend").innerHTML = [...enabledSources].map((provider) => `<span class="legend-key ${sourceColors[provider] || "mint"}"></span> ${escapeHtml(sourceNames[provider] || provider)}`).join("") || "No local usage sources enabled";
  $("#usage-hosts").innerHTML = hosts.map((host, index) => {
    const usable = hostUsable(usage, host);
    const hasRecords = hostHasRecords(usage, host);
    const selected = usable && selectedHostIds.has(host.hostId);
    const healthy = hostHealthy(host);
    const detail = host.disabledReason || host.error || (host.included === false ? "Timezone mismatch" : host.complete === false ? "Range incomplete" : host.stale ? "Stale usage data" : host.status) || "Status unavailable";
    const stateLabel = !usable ? "unavailable" : selected ? healthy ? "selected, healthy" : "selected, unhealthy" : "unselected";
    const hostClass = `usage-host ${!usable ? "disabled" : selected ? healthy ? "selected healthy" : "selected unhealthy" : "unselected"}`;
    const needsStatusAlert = !healthy || !usable || !hasRecords;
    if (!needsStatusAlert) return `<button class="${hostClass}" type="button" data-host-id="${escapeHtml(host.hostId)}" aria-label="${escapeHtml(host.hostId)}: ${stateLabel}" aria-pressed="${selected}">${escapeHtml(host.hostId)}</button>`;
    const statusId = `usage-host-status-${index}`;
    const icon = healthy && usable && !hasRecords ? "i" : "!";
    const pillClass = !usable ? "disabled" : selected ? `selected ${healthy ? "healthy" : "unhealthy"}` : "unselected";
    return `<span class="usage-host-pill ${pillClass} ${healthy && usable && !hasRecords ? "informational" : ""}"><button class="${hostClass}" type="button" data-host-id="${escapeHtml(host.hostId)}" aria-label="${escapeHtml(host.hostId)}: ${stateLabel}, ${escapeHtml(detail)}" aria-pressed="${selected}" ${!usable ? "disabled" : ""}>${escapeHtml(host.hostId)}</button><button class="usage-host-alert" type="button" data-status-target="${statusId}" aria-label="Show status for ${escapeHtml(host.hostId)}: ${escapeHtml(detail)}" aria-controls="${statusId}" aria-expanded="false"><span aria-hidden="true">${icon}</span></button><span class="usage-host-status-popover" id="${statusId}" role="status" aria-live="polite" hidden><strong>${escapeHtml(host.hostId)}</strong><span>${escapeHtml(detail)}</span></span></span>`;
  }).join("") || `<span class="usage-host warning"><i></i>No usage hosts</span>`;
  document.querySelectorAll<HTMLButtonElement>("#usage-hosts .usage-host-alert").forEach((button) => button.addEventListener("click", () => toggleHostStatusPopover(button)));
  document.querySelectorAll<HTMLButtonElement>("#usage-hosts .usage-host:not(:disabled)").forEach((button) => button.addEventListener("click", () => {
    const hostId = button.dataset.hostId;
    if (!hostId) return;
    state.hostSelections.set(hostId, !selectedHostIds.has(hostId));
    renderUsage(usage, "preserve");
  }));
  const chart = $("#usage-chart");
  const representation = activeRepresentation();
  const axisCurrentLabel = representation === "day" ? "today" : representation === "week" ? "this week" : "this month";
  $("#axis-current-label").innerHTML = `<i></i> ${axisCurrentLabel}`;
  const hasUsage = Boolean(selectedUsage.records?.length || selectedUsage.daily?.length);
  const buckets = hasUsage ? usageBuckets(selectedUsage, representation) : [];
  const providers = [...enabledSources, ...(enabledSources.has("opencode") || enabledSources.has("hermes") || enabledSources.has("antigravity") ? ["shared"] : [])];
  const colors = sourceColors;
  const max = Math.max(...buckets.map((bucket) => bucket.costUsd), 0);
  const usageTooltip = (bucket: UsageBucket, hoveredProvider: string, segments: Array<{ provider: string; costUsd: number; totalTokens: number }>): string => {
    const sortedSegments = [...segments].sort((a, b) => b.costUsd - a.costUsd);
    const harnesses = sortedSegments.map((segment) => `<span class="harness-row ${segment.provider === hoveredProvider ? "hovered" : ""}"><i class="tooltip-harness-dot ${colors[segment.provider] || "mint"}"></i><span class="harness-name">${escapeHtml(sourceNames[segment.provider] || segment.provider)}</span><span class="harness-detail"> · ${money(segment.costUsd)} · ${formatTokens(segment.totalTokens)} tokens</span></span>`).join("");
    return `<span class="chart-tooltip"><strong>${money(bucket.costUsd)} total · ${formatTokens(bucket.totalTokens)} tokens</strong><span>${escapeHtml(usageBucketLabel(bucket, representation))}</span><div class="tooltip-separator"></div>${harnesses}</span>`;
  };
  const renderSegment = (bucket: UsageBucket, segment: { provider: string; costUsd: number; totalTokens: number }, segments: Array<{ provider: string; costUsd: number; totalTokens: number }>, height: number, offset = 0) => { const color = colors[segment.provider] || "mint"; return `<div class="chart-segment ${color}" style="height:${height}%;bottom:${offset}%">${usageTooltip(bucket, segment.provider, segments)}</div>`; };
  const todayOnly = selectedUsage.from === selectedUsage.to;
  const chartScroll = document.querySelector<HTMLElement>(".chart-scroll");
  chart.innerHTML = buckets.length ? buckets.map((bucket, bucketIndex) => {
    const segments = providers.map((provider) => ({ provider, costUsd: bucket.byProvider?.[provider]?.costUsd || 0, totalTokens: bucket.byProvider?.[provider]?.totalTokens || 0 })).filter((segment) => segment.costUsd > 0 || segment.totalTokens > 0);
    const fallback = segments.length ? segments : bucket.costUsd > 0 || bucket.totalTokens > 0 ? [{ provider: "other", costUsd: bucket.costUsd, totalTokens: bucket.totalTokens }] : [];
    const displayedTotal = fallback.reduce((total, segment) => total + segment.costUsd, 0);
    const label = usageBucketLabel(bucket, representation);
    if (todayOnly) {
      return (fallback.length ? fallback : [{ provider: "other", costUsd: 0, totalTokens: 0 }]).map((segment) => `<button class="chart-column today-harness" type="button" data-bucket-index="${bucketIndex}" aria-label="${escapeHtml(label)} ${escapeHtml(segment.provider)}: ${money(segment.costUsd)}"><div class="chart-stack">${segment.costUsd > 0 || segment.totalTokens > 0 ? `<div class="chart-segment ${colors[segment.provider] || "mint"}" style="height:${max ? Math.max(2, (segment.costUsd / max) * 100) : 2}%;bottom:0">${usageTooltip(bucket, segment.provider, fallback)}</div>` : ""}</div></button>`).join("");
    }
    const isCurrentBucket = bucket.to === selectedUsage.to;
    let offset = 0;
    const markup = fallback.map((segment) => {
      // Current segments are relative to their own stack. Older buckets use
      // chart-wide scale so their heights remain comparable.
      const height = isCurrentBucket
        ? displayedTotal > 0 ? (segment.costUsd / displayedTotal) * 100 : 0
        : max > 0 ? Math.max(2, (segment.costUsd / max) * 100) : 2;
      const html = renderSegment(bucket, segment, fallback, height, offset);
      offset += height;
      return html;
    }).join("");
    const stackHeight = max && displayedTotal > 0 ? (displayedTotal / max) * 100 : 0;
    const currentClass = isCurrentBucket && displayedTotal > 0 ? "current-day" : "";
    const currentHeight = isCurrentBucket ? `height:${stackHeight}% !important` : "";
    return `<button class="chart-column ${currentClass}" type="button" data-bucket-index="${bucketIndex}" aria-label="${escapeHtml(label)}: ${money(displayedTotal)}"><div class="chart-stack" style="${currentHeight}">${markup}</div></button>`;
  }).join("") : `<div class="chart-empty">${escapeHtml(noHostsSelected ? "No usage hosts selected" : usage.error || "No usage data in this range")}</div>`;
  const chartColumnCount = chart.querySelectorAll(":scope > .chart-column").length;
  chartScroll?.style.setProperty("--chart-min-width", `${Math.max(1, chartColumnCount) * 15}px`);
  activeChartTooltip = null;
  bindChartTooltips(chart);
  (chart.querySelectorAll("[data-bucket-index]") as NodeListOf<HTMLButtonElement>).forEach((bar) => bar.addEventListener("click", () => { activeDetailsTrigger = bar; openUsageDetails(buckets[Number(bar.dataset.bucketIndex)], representation); }));
  $("#models-list").innerHTML = selectedUsage.byModel?.length ? selectedUsage.byModel.map((model, index) => `<div class="model-row"><span class="model-rank">${String(index + 1).padStart(2, "0")}</span><span class="model-name"><span class="model-name-text" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</span>${model.provider ? `<small class="model-provider">${escapeHtml(sourceNames[model.provider] || model.provider)}</small>` : ""}</span><span class="model-value">${money(model.costUsd)}</span></div>`).join("") : `<div class="quota-empty">${escapeHtml(noHostsSelected ? "No hosts selected." : "No model breakdown available.")}</div>`;
  const scroll = chartScroll;
  if (scroll) {
    const restoreScroll = () => { scroll.scrollLeft = scrollMode === "newest" ? scroll.scrollWidth : Math.min(state.chartScrollLeft, Math.max(0, scroll.scrollWidth - scroll.clientWidth)); state.chartScrollLeft = scroll.scrollLeft; };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
}

function openUsageDetails(bucket: UsageBucket | undefined, representation: ConcreteRepresentation): void {
  if (!bucket) return;
  $("#usage-chart").classList.add("suppress-tooltips");
  const label = usageBucketLabel(bucket, representation);
  $("#day-details-title").textContent = representation === "day" ? label : `${representation === "week" ? "Week" : "Month"} · ${label}`;
  $("#day-details-summary").innerHTML = `<span><strong>${money(bucket.costUsd)}</strong> total</span><span><strong>${formatTokens(bucket.totalTokens)}</strong> tokens</span>`;
  const modelDetails = (bucket.byModel || []).map((group) => { const sortedModels = [...group.models].sort((a, b) => b.costUsd - a.costUsd); const providerName = usageSourceNames[group.provider] || group.provider; return `<section class="detail-group"><h3>${escapeHtml(providerName)}</h3>${sortedModels.map((model) => `<div class="detail-model"><span>${escapeHtml(model.model)}</span><span>${money(model.costUsd)} · ${formatTokens(model.totalTokens)} tokens</span></div>`).join("")}</section>`; }).join("");
  const dailyDetails = representation === "day" ? "" : `<section class="detail-group detail-days"><h3>By day</h3>${bucket.days.map((day) => `<div class="detail-model"><span>${escapeHtml(day.date)}</span><span>${money(day.costUsd)} · ${formatTokens(day.totalTokens)} tokens</span></div>`).join("")}</section>`;
  $("#day-details-content").innerHTML = modelDetails + dailyDetails || `<p class="quota-empty">No usage details available.</p>`;
  $("#day-details-dialog").showModal();
}

function renderStatus(data: Dashboard): void {
  const statuses = Object.values(data.providers);
  const enabled = statuses.filter((provider) => provider.enabled);
  const errors = enabled.filter((provider) => provider.status === "error");
  const hosts = data.usage.hosts || [];
  const hostProblems = hosts.filter((host) => !hostHealthy(host));
  const mqttProblem = data.usage.mqtt?.configured && data.usage.mqtt.connection !== "connected";
  const problems = errors.length + hostProblems.length + (mqttProblem ? 1 : 0);
  $("#status-copy").textContent = problems
    ? `${problems} source${problems === 1 ? "" : "s"} need attention · ${hosts.length} usage host${hosts.length === 1 ? "" : "s"}`
    : `${enabled.length} quota source${enabled.length === 1 ? "" : "s"} active · ${hosts.length} usage host${hosts.length === 1 ? "" : "s"} combined`;
  $("#updated-at").textContent = `updated ${relativeTime(data.serverNow)}`;
  $("#last-refresh").textContent = `Last refresh: ${formatRefreshTime(data.cache?.fetchedAt || data.serverNow)}`;
  $("#app-version").textContent = `Build ${data.version}`;
  $("#app-version").setAttribute("title", `Build ${data.version}`);
}

function renderClock(): void {
  const now = new Date();
  $("#now-time").textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: state.hour12 }).format(now);
  $("#now-date").textContent = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(now);
}

function usageQuery(): string {
  return `days=${state.days}&range=${encodeURIComponent(state.range === "today" ? "relative" : state.range.startsWith("relative-") ? "relative" : state.range)}`;
}

function setUsageLoading(loading: boolean): void {
  document.querySelector(".range-picker")?.classList.toggle("loading", loading);
  document.querySelectorAll<HTMLButtonElement>(".range-picker button").forEach((button) => { button.disabled = loading; });
}

async function startUsageRefresh(): Promise<void> {
  const response = await fetch("/api/v1/usage/refresh", { method: "POST" });
  if (!response.ok) throw new Error("Usage refresh could not be started");
}

function usageHotBaseline(usage: Usage | undefined): HotUsageBaseline {
  return new Map((usage?.hosts || []).map((host) => [host.hostId, {
    generatedAt: host.generatedAt ? Date.parse(host.generatedAt) : NaN,
    error: host.error || null,
  }]));
}

function usageHotTargetIds(usage: Usage | undefined): Set<string> {
  return new Set((usage?.hosts || []).filter((host) => host.active !== false).map((host) => host.hostId));
}

function stopHotUsagePolling(): void {
  if (!hotUsagePoller) return;
  window.clearTimeout(hotUsagePoller.timer);
  hotUsagePoller = null;
}

function evaluateHotUsagePoll(poller: NonNullable<typeof hotUsagePoller>, usage: Usage | null): boolean {
  if (hotUsagePoller !== poller) return true;
  const hosts = usage?.hosts || [];
  const targetHosts = [...poller.targetHostIds].map((hostId) => hosts.find((host) => host.hostId === hostId));
  const presentTargetHosts = targetHosts.filter((host): host is NonNullable<typeof host> => Boolean(host));
  const completionHosts = presentTargetHosts.filter((host) => host.active !== false && host.status !== "offline" && !host.error);
  const completionHostIds = new Set(completionHosts.map((host) => host.hostId));
  const unresolvedRetryHosts = [...poller.retryGraceHostIds].filter((hostId) => !completionHostIds.has(hostId));
  const graceExpired = Date.now() - poller.startedAt >= HOT_USAGE_RETRY_GRACE_PERIOD_MS;
  const retryGracePending = !graceExpired && unresolvedRetryHosts.length > 0;
  if (presentTargetHosts.length > 0) {
    const errorHost = presentTargetHosts.find((host) => host.error && host.error !== poller.baseline.get(host.hostId)?.error);
    if (errorHost?.error) {
      stopHotUsagePolling();
      const message = `Hot usage refresh failed: ${errorHost.error}`;
      showToast(message);
      $("#status-copy").textContent = message;
      return true;
    }
    const freshHotUsage = !retryGracePending && completionHosts.length > 0 && completionHosts.every((host) => {
      if (host.category !== "hot" || !host.generatedAt) return false;
      const generatedAt = Date.parse(host.generatedAt);
      const previous = poller.baseline.get(host.hostId);
      return Number.isFinite(generatedAt) && (!previous || !Number.isFinite(previous.generatedAt) || generatedAt > previous.generatedAt);
    });
    if (freshHotUsage) {
      stopHotUsagePolling();
      const message = unresolvedRetryHosts.length > 0
        ? `Hot usage refresh partially complete: ${unresolvedRetryHosts.join(", ")} did not recover`
        : "Hot usage refresh complete";
      showToast(message);
      if (unresolvedRetryHosts.length > 0) $("#status-copy").textContent = message;
      return true;
    }
  }
  if (usage && graceExpired) {
    const availableHosts = presentTargetHosts.filter((host) => host.active !== false && host.status !== "offline");
    const errorHosts = availableHosts.filter((host) => Boolean(host.error));
    if (availableHosts.length > 0 && errorHosts.length === availableHosts.length) {
      stopHotUsagePolling();
      const message = `Hot usage refresh failed: ${errorHosts.map((host) => `${host.hostId}: ${host.error}`).join("; ")}`;
      showToast(message);
      $("#status-copy").textContent = message;
      return true;
    }
    if (availableHosts.length === 0) {
      stopHotUsagePolling();
      const message = "Hot usage refresh failed: no eligible hosts are available";
      showToast(message);
      $("#status-copy").textContent = message;
      return true;
    }
  }
  if (Date.now() - poller.startedAt >= HOT_USAGE_POLL_TIMEOUT_MS) {
    stopHotUsagePolling();
    showToast("Hot usage refresh is still running");
    return true;
  }
  return false;
}

async function pollHotUsage(): Promise<void> {
  const poller = hotUsagePoller;
  if (!poller || poller.requestInFlight) return;
  poller.requestInFlight = true;
  try {
    const usage = await loadUsage(true);
    evaluateHotUsagePoll(poller, usage);
  } finally {
    if (hotUsagePoller === poller) {
      poller.requestInFlight = false;
      if (Date.now() - poller.startedAt < HOT_USAGE_POLL_TIMEOUT_MS) {
        poller.timer = window.setTimeout(() => void pollHotUsage(), HOT_USAGE_POLL_INTERVAL_MS);
      }
    }
  }
}

function startHotUsagePolling(baseline: HotUsageBaseline, initialUsage: Usage | null | undefined, startedAt: number, targetHostIds: Set<string>): void {
  stopHotUsagePolling();
  if (targetHostIds.size === 0) return;
  const retryGraceHostIds = new Set([...targetHostIds].filter((hostId) => Boolean(baseline.get(hostId)?.error)));
  const poller = { timer: 0, startedAt, baseline, targetHostIds, retryGraceHostIds, requestInFlight: false };
  hotUsagePoller = poller;
  if (evaluateHotUsagePoll(poller, initialUsage || null)) return;
  poller.timer = window.setTimeout(() => void pollHotUsage(), HOT_USAGE_POLL_INTERVAL_MS);
}

function beginRefresh(): boolean {
  if (activeRefreshes > 0) return false;
  activeRefreshes += 1;
  document.querySelectorAll<HTMLButtonElement>("#refresh-button, #usage-refresh-button").forEach((button) => { button.disabled = true; });
  return true;
}

function endRefresh(): void {
  activeRefreshes = Math.max(0, activeRefreshes - 1);
  if (activeRefreshes > 0) return;
  document.querySelectorAll<HTMLButtonElement>("#refresh-button, #usage-refresh-button").forEach((button) => { button.disabled = false; });
}

async function loadUsage(silent = false): Promise<Usage | null> {
  if (!state.dashboard) {
    await loadDashboard();
    const refreshedDashboard = state.dashboard as Dashboard | null;
    return refreshedDashboard ? refreshedDashboard.usage : null;
  }
  const scroll = document.querySelector<HTMLElement>(".chart-scroll");
  if (scroll) state.chartScrollLeft = scroll.scrollLeft;
  if (!silent) setUsageLoading(true);
  try {
    const response = await fetch(`/api/v1/usage?${usageQuery()}`);
    if (!response.ok) throw new Error("Usage request failed");
    const data = await response.json() as UsageResponse;
    state.dashboard = { ...state.dashboard, usage: data.usage, serverNow: data.serverNow };
    renderUsage(data.usage, "preserve");
    renderStatus(state.dashboard);
    return data.usage;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Usage request failed";
    if (!silent) {
      showToast(message);
      $("#status-copy").textContent = message;
    }
    return null;
  } finally {
    if (!silent) setUsageLoading(false);
  }
}

async function loadDashboard(refresh = false): Promise<void> {
  if (refresh) {
    const scroll = document.querySelector<HTMLElement>(".chart-scroll");
    if (scroll) state.chartScrollLeft = scroll.scrollLeft;
  }
  setUsageLoading(true);
  $("#usage-total").textContent = "—";
  $("#usage-total-caption").textContent = `Estimated spend · ${usagePresetLabel(state.range)} · —`;
  $("#today-total").textContent = "—";
  $("#today-caption").textContent = "Today so far";
  $("#today-metric").hidden = state.range === "today";
  $("#usage-chart").innerHTML = `<div class="chart-empty">Loading usage data…</div>`;
  $("#models-list").innerHTML = `<div class="chart-empty">Loading model data…</div>`;
  try {
    const response = await fetch(`/api/v1/dashboard?${usageQuery()}${refresh ? "&refresh=1" : ""}`);
    if (!response.ok) throw new Error("Dashboard request failed");
    state.dashboard = await response.json();
    const dashboard = state.dashboard;
    if (dashboard) { providerOrder = dashboard.providerOrder; renderQuotas(dashboard); renderUsage(dashboard.usage, refresh ? "preserve" : "newest"); renderStatus(dashboard); }
  } finally {
    setUsageLoading(false);
  }
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDateInput(value: string): boolean {
  return Boolean(localApiDate(value));
}

function renderColdUsageSettings(usage: Usage | undefined): void {
  const end = usage?.to && validDateInput(usage.to) ? usage.to : new Date().toISOString().slice(0, 10);
  const start = shiftDate(end, -6);
  const hosts = usage?.hosts || [];
  const hostOptions = [`<option value="">All usage hosts</option>`, ...hosts.map((host) => `<option value="${escapeHtml(host.hostId)}">${escapeHtml(host.hostId)}${host.local ? " (local)" : ""}</option>`)].join("");
  $("#usage-cold-settings").innerHTML = `<p class="settings-group">COLD USAGE BACKFILL</p><p class="dialog-copy cold-copy">Backfill persisted usage for one host or all hosts. Large cold jobs can take up to 30 minutes.</p><form id="cold-usage-form" class="cold-usage-form"><label class="cold-field"><span>Host</span><select id="cold-host">${hostOptions}</select></label><div class="cold-date-row"><label class="cold-field"><span>From</span><input id="cold-from" type="date" value="${escapeHtml(start)}" required /></label><label class="cold-field"><span>To</span><input id="cold-to" type="date" value="${escapeHtml(end)}" required /></label></div><fieldset class="cold-mode"><legend>Mode</legend><label><input type="radio" name="cold-mode" value="offline" checked /> Offline</label><label><input type="radio" name="cold-mode" value="online" /> Online</label></fieldset><button class="text-button cold-submit" type="submit">Start cold backfill <span>↗</span></button></form>`;
  const form = $("#cold-usage-form") as HTMLFormElement;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const from = ($("#cold-from") as HTMLInputElement).value;
    const to = ($("#cold-to") as HTMLInputElement).value;
    if (!validDateInput(from) || !validDateInput(to) || from > to) {
      showToast("Choose an ordered date range");
      return;
    }
    const hostId = ($("#cold-host") as HTMLSelectElement).value;
    const mode = (form.querySelector<HTMLInputElement>("input[name='cold-mode']:checked")?.value || "offline");
    const submit = form.querySelector<HTMLButtonElement>(".cold-submit");
    if (submit) submit.disabled = true;
    try {
      const response = await fetch("/api/v1/usage/cold", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(hostId ? { hostId } : {}), from, to, mode }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Cold backfill could not be started");
      showToast("Cold backfill accepted · up to 30 minutes");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Cold backfill could not be started");
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

async function loadSettings(): Promise<void> {
  const response = await fetch("/api/v1/providers");
  const data = await response.json();
  providerOrder = data.providerOrder;
  const quotaSettings = providerOrder.map((id, index) => { const provider = data.providers[id]; return `<div class="setting-row" data-provider-row="${id}"><div class="setting-copy"><div class="provider-name">${provider.name}</div><div class="provider-sub">${provider.description}${provider.configured ? " · configured" : " · credentials not detected"}</div></div><div class="order-actions"><button class="order-button" type="button" data-order-direction="up" data-provider="${id}" aria-label="Move ${provider.name} up" ${index === 0 ? "disabled" : ""}>↑</button><button class="order-button" type="button" data-order-direction="down" data-provider="${id}" aria-label="Move ${provider.name} down" ${index === providerOrder.length - 1 ? "disabled" : ""}>↓</button><input class="switch" type="checkbox" data-kind="provider" data-provider="${id}" ${provider.enabled ? "checked" : ""} aria-label="Enable ${provider.name}" /></div></div>`; }).join("");
  const usageNames: Record<string, string> = usageSourceNames;
  const usageSettings = usageSourceOrder.map((id) => `<label class="setting-row"><div class="setting-copy"><div class="provider-name">${usageNames[id]} usage</div><div class="provider-sub">Provider group from shared ccusage output</div></div><input class="switch" type="checkbox" data-kind="usage" data-provider="${id}" ${data.usageSources?.[id]?.enabled ? "checked" : ""} aria-label="Enable ${usageNames[id]} usage" /></label>`).join("");
   $("#provider-settings").innerHTML = `<p class="settings-group">DISPLAY</p><label class="setting-row"><div class="setting-copy"><div class="provider-name">12-hour clock</div><div class="provider-sub">Show times with AM and PM</div></div><input class="switch" type="checkbox" data-kind="time-format" ${state.hour12 ? "checked" : ""} aria-label="Use 12-hour clock" /></label><p class="settings-group">QUOTA PROVIDERS</p>${quotaSettings}<p class="settings-group">LOCAL USAGE SOURCES</p>${usageSettings}`;
   renderColdUsageSettings(state.dashboard?.usage);
  document.querySelectorAll<HTMLButtonElement>(".order-button").forEach((button) => button.addEventListener("click", async () => { const id = button.dataset.provider || ""; const index = providerOrder.indexOf(id); const nextIndex = index + (button.dataset.orderDirection === "up" ? -1 : 1); if (index < 0 || nextIndex < 0 || nextIndex >= providerOrder.length) return; const nextOrder = [...providerOrder]; [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]]; document.querySelectorAll<HTMLButtonElement>(".order-button").forEach((item) => { item.disabled = true; }); try { const save = await fetch("/api/v1/providers/order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order: nextOrder }) }); if (!save.ok) throw new Error("Provider order could not be saved"); providerOrder = nextOrder; if (state.dashboard) renderQuotas(state.dashboard); await loadSettings(); showToast("Provider order saved"); } catch (error) { showToast(error instanceof Error ? error.message : "Provider order could not be saved"); await loadSettings(); } }));
  document.querySelectorAll<HTMLInputElement>(".switch").forEach((input) => input.addEventListener("change", async (event) => { const target = event.target as HTMLInputElement; const id = target.dataset.provider || ""; const kind = target.dataset.kind || ""; if (kind === "time-format") { state.hour12 = target.checked; localStorage.setItem(timeFormatStorageKey, state.hour12 ? "12" : "24"); renderClock(); if (state.dashboard) { renderQuotas(state.dashboard); renderStatus(state.dashboard); } showToast(`${state.hour12 ? "12-hour" : "24-hour"} clock enabled`); return; } const path = kind === "usage" ? `/api/v1/usage-sources/${id}/enabled` : `/api/v1/providers/${id}/enabled`; await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: target.checked }) }); showToast(`${kind === "usage" ? usageNames[id] + " usage" : data.providers[id].name} ${target.checked ? "enabled" : "disabled"}`); await loadDashboard(true); }));
}

function showToast(message: string): void { const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2200); }

$("#refresh-button").addEventListener("click", async () => {
  if (!beginRefresh()) return;
  let baseline: HotUsageBaseline | null = null;
  let startedAt = 0;
  let refreshStarted = false;
  let refreshedUsage: Usage | null = null;
  try {
    stopHotUsagePolling();
    baseline = usageHotBaseline(state.dashboard?.usage);
    startedAt = Date.now();
    await startUsageRefresh();
    refreshStarted = true;
    await loadDashboard(true);
    refreshedUsage = state.dashboard?.usage || null;
    showToast("Quotas and usage refresh started");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Refresh failed");
  } finally {
    endRefresh();
    if (refreshStarted && refreshedUsage && baseline) startHotUsagePolling(baseline, refreshedUsage, startedAt, usageHotTargetIds(refreshedUsage));
  }
});
$("#usage-refresh-button").addEventListener("click", async () => {
  if (!beginRefresh()) return;
  let baseline: HotUsageBaseline | null = null;
  let startedAt = 0;
  let refreshStarted = false;
  let initialUsage: Usage | null = null;
  try {
    stopHotUsagePolling();
    baseline = usageHotBaseline(state.dashboard?.usage);
    startedAt = Date.now();
    await startUsageRefresh();
    refreshStarted = true;
    initialUsage = await loadUsage();
    showToast("Usage refresh started");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Usage refresh failed");
  } finally {
    endRefresh();
    if (refreshStarted && initialUsage && baseline) startHotUsagePolling(baseline, initialUsage, startedAt, usageHotTargetIds(initialUsage));
  }
});
$("#settings-button").addEventListener("click", async () => { await loadSettings(); $("#settings-dialog").showModal(); });
$("#manage-button").addEventListener("click", async () => { await loadSettings(); $("#settings-dialog").showModal(); });
$("#close-settings").addEventListener("click", () => $("#settings-dialog").close());
$("#close-day-details").addEventListener("click", () => $("#day-details-dialog").close());
$("#day-details-dialog").addEventListener("close", () => { $("#usage-chart").classList.remove("suppress-tooltips"); const trigger = activeDetailsTrigger; activeDetailsTrigger = null; if (trigger?.isConnected) trigger.focus(); else (document.activeElement as HTMLElement | null)?.blur?.(); });
function resetRangeMenuLabels(): void { document.querySelectorAll<HTMLElement>(".range-picker .range-menu").forEach((menu) => { const button = menu.querySelector<HTMLElement>(".range-menu-button"); const label = menu.querySelector("[data-range^='calendar-']") ? "Calendar" : "Relative"; if (button?.firstChild) button.firstChild.textContent = `${label} `; }); }
document.querySelectorAll<HTMLElement>("[data-range]").forEach((button) => button.addEventListener("click", async (event) => { const current = element(event.currentTarget); const value = current.dataset.range || "today"; state.range = value; state.days = value === "today" ? 1 : value.startsWith("relative-") ? Number(value.slice(9)) : value === "calendar-year" ? 365 : value === "calendar-month" ? 31 : 7; document.querySelectorAll<HTMLElement>(".range-tab").forEach((tab) => tab.classList.toggle("active", value === "today")); document.querySelectorAll<HTMLElement>(".range-menu-items button").forEach((item) => item.classList.toggle("active", item.dataset.range === value)); document.querySelectorAll<HTMLElement>(".range-picker .range-menu-button").forEach((menuButton) => { const menu = menuButton.parentElement; if (!menu) return; const selected = menu.querySelector(`[data-range="${value}"]`); menuButton.classList.toggle("active", Boolean(selected)); menuButton.setAttribute("aria-expanded", "false"); menu.querySelector(".range-menu-items")?.classList.remove("open"); }); if (value !== "today") { const menuButton = current.closest(".range-menu")?.querySelector<HTMLElement>(".range-menu-button"); if (menuButton?.firstChild) menuButton.childNodes[0].textContent = `${current.textContent} `; } else resetRangeMenuLabels(); updateRepresentationControls(); await loadUsage(); }));
document.querySelectorAll<HTMLElement>("[data-representation]").forEach((button) => button.addEventListener("click", (event) => { const value = element(event.currentTarget).dataset.representation as ChartRepresentation | undefined; if (!value) return; state.representation = value; closeRangeMenus(); updateRepresentationControls(); if (state.dashboard) renderUsage(state.dashboard.usage, "preserve"); }));
document.querySelectorAll<HTMLElement>(".range-menu-button").forEach((button) => button.addEventListener("click", (event) => { const currentButton = element(event.currentTarget); const parent = currentButton.parentElement; const menu = parent?.querySelector<HTMLElement>(".range-menu-items"); if (!menu) return; const willOpen = !menu.classList.contains("open"); closeRangeMenus(); if (willOpen) { menu.classList.add("open"); currentButton.setAttribute("aria-expanded", "true"); } }));
function closeRangeMenus() { document.querySelectorAll(".range-menu-items").forEach((menu) => menu.classList.remove("open")); document.querySelectorAll(".range-menu-button").forEach((button) => button.setAttribute("aria-expanded", "false")); }
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeRangeMenus(); closeHostStatusPopover(); } });
document.addEventListener("pointerdown", (event) => {
  if (!element(event.target).closest(".range-picker, .view-picker")) closeRangeMenus();
  if (activeHostStatusPopover && !element(event.target).closest(".usage-host-status-popover, .usage-host-alert")) closeHostStatusPopover();
});
document.addEventListener("focusin", (event) => {
  if (activeHostStatusPopover && !activeHostStatusPopover.anchor.closest(".usage-host-pill")?.contains(element(event.target))) closeHostStatusPopover();
});
updateRepresentationControls(); renderClock(); setInterval(renderClock, 30_000); setInterval(() => { if (state.dashboard) renderQuotas(state.dashboard); }, 60_000);
loadDashboard().catch((error) => { const message = error instanceof Error ? error.message : "Dashboard request failed"; $("#status-copy").textContent = message; showToast(message); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

function repositionActiveChartTooltip(): void {
  if (activeChartTooltip) positionChartTooltip(activeChartTooltip.anchor, activeChartTooltip.tooltip);
  if (activeQuotaTooltip) positionQuotaTooltip(activeQuotaTooltip.anchor, activeQuotaTooltip.tooltip);
  if (activeHostStatusPopover) positionHostStatusPopover(activeHostStatusPopover.anchor, activeHostStatusPopover.popover);
}

window.addEventListener("resize", repositionActiveChartTooltip);
window.addEventListener("scroll", repositionActiveChartTooltip, { passive: true });
window.addEventListener("beforeunload", stopHotUsagePolling);
