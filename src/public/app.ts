type QuotaWindow = { usedPercent?: number | null; resetAt?: string | null; windowSeconds?: number | null; valueLabel?: string | null; balanceLabel?: string | null; spentLabel?: string | null };
type Provider = { id: string; name: string; shortName: string; accent: string; description: string; enabled: boolean; configured: boolean; status: string };
type UsageModel = { model: string; costUsd: number; totalTokens?: number };
type UsageDay = { date: string; costUsd: number; totalTokens: number; byProvider?: Record<string, { costUsd: number; totalTokens: number }>; byModel?: Array<{ provider: string; models: UsageModel[] }> };
type Usage = { totalCostUsd: number; from?: string; to?: string; providers?: string[]; daily?: UsageDay[]; byModel?: UsageModel[]; error?: string | null };
type Dashboard = { version: string; providers: Record<string, Provider>; quotas: Record<string, { windows?: QuotaWindow[]; planType?: string; fetchedAt?: string; error?: string | null }>; usage: Usage; serverNow: string; cache?: { fetchedAt?: string } };
type AppState = { days: number; range: string; dashboard: Dashboard | null };
const state: AppState = { days: 1, range: "today", dashboard: null };
const $ = (selector: string): any => document.querySelector(selector);
const element = (target: EventTarget | null): HTMLElement => target as HTMLElement;
const providerOrder = ["codex", "openrouter", "opencode-go"];
const usageSourceOrder = ["codex", "opencode", "hermes"];
const usageSourceNames: Record<string, string> = { codex: "Codex", opencode: "OpenCode", hermes: "Hermes" };

function money(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value ?? 0);
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "not fetched";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}

function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "no reset reported";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const duration = days > 0 ? `${days}d ${hours}h ${remainder}m` : hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
  const date = new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return `resets in ${duration} · ${date}`;
}

function quotaNowPosition(window: QuotaWindow | undefined): number | null {
  if (!window?.resetAt || !window?.windowSeconds) return null;
  const resetAt = Date.parse(window.resetAt);
  const startAt = resetAt - window.windowSeconds * 1000;
  const now = Date.now();
  if (!Number.isFinite(resetAt) || now < startAt || now > resetAt) return null;
  return ((now - startAt) / (resetAt - startAt)) * 100;
}

function formatRefreshTime(iso: string | null | undefined): string {
  return iso ? new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "unknown";
}

function formatPercent(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function quotaCard(id: string, provider: Provider, quota: Dashboard["quotas"][string]): string {
  const window = quota?.windows?.[0];
  const percent = window?.usedPercent;
  const value = window?.balanceLabel ? `<span class="quota-balance-primary">${window.balanceLabel}</span><span class="quota-balance-secondary">${window.spentLabel || ""}</span>` : window?.valueLabel || "Not available";
  const status = provider.status === "disabled" ? "off" : provider.status === "error" ? "error" : provider.configured ? "connected" : "setup needed";
  const label = percent == null && window?.valueLabel ? "" : window?.valueLabel || (provider.id === "codex" ? "" : provider.configured ? "No balance reported" : "Configure credentials on server");
  const plan = quota?.planType ? `<div class="quota-plan">${quota.planType} plan</div>` : "";
  const nowPosition = quotaNowPosition(window);
  const nowExpected = nowPosition === null ? null : Math.floor(nowPosition * 10) / 10;
  const percentageValue = percent == null
    ? value
    : `<span class="quota-used-percent">${formatPercent(percent)}% <small>used</small></span>${nowExpected === null ? "" : `<span class="quota-expected-percent">/ ${formatPercent(nowExpected)}% elapsed</span>`}`;
  const refreshedAt = quota?.fetchedAt || state.dashboard?.cache?.fetchedAt;
  return `<article class="quota-card" style="--accent: var(--${provider.accent})"><div class="provider-head"><div><div class="provider-name">${provider.shortName}</div><div class="provider-sub">${provider.description}</div></div><span class="provider-badge">${status}</span></div>${plan}<div class="quota-main"> <div class="quota-percent ${percent == null && !window?.valueLabel ? "unavailable" : percent == null ? "quota-balance" : "quota-percentage"}">${percentageValue}</div>${percent != null ? `<div class="bar"><span style="width:${Math.min(percent, 100)}%"></span>${nowPosition !== null ? `<button class="quota-now-marker" style="left:${nowPosition}%" type="button" aria-label="Current quota window position"><span class="quota-now-tooltip"><strong>Now</strong><span>${nowExpected}% of window elapsed</span><span>Snapshot: ${formatRefreshTime(refreshedAt)}</span></span></button>` : ""}</div>` : ""}<div class="quota-foot">${label ? `<span>${label}</span>` : ""}<span>${window?.resetAt ? timeUntil(window.resetAt) : ""}</span></div>${quota?.error ? `<div class="quota-error">${quota.error}</div>` : ""}</div></article>`;
}

function renderQuotas(data: Dashboard): void {
  $("#quota-grid").innerHTML = providerOrder.filter((id) => data.providers[id]?.enabled).map((id) => quotaCard(id, data.providers[id], data.quotas[id])).join("") || `<div class="quota-card"><div class="quota-empty">No providers enabled. Open Manage providers to begin.</div></div>`;
}

function renderUsage(usage: Usage): void {
  $("#usage-total").textContent = money(usage.totalCostUsd);
  $("#axis-start").textContent = usage.from || "—";
  const sourceNames: Record<string, string> = { codex: "Codex", opencode: "OpenCode", hermes: "Hermes", shared: "Shared" };
  const sourceColors: Record<string, string> = { codex: "mint", opencode: "violet", hermes: "orange", shared: "blue" };
  const enabledSources = new Set(usage.providers || []);
  $(".chart-legend").innerHTML = [...enabledSources].map((provider) => `<span class="legend-key ${sourceColors[provider] || "mint"}"></span> ${sourceNames[provider] || provider}`).join("") || "No local usage sources enabled";
  const chart = $("#usage-chart");
  const daily = usage.daily || [];
  const providers = [...enabledSources, ...(enabledSources.has("opencode") || enabledSources.has("hermes") ? ["shared"] : [])];
  const colors = sourceColors;
  const max = Math.max(...daily.map((day) => day.costUsd), 0);
  const usageTooltip = (day: UsageDay, hoveredProvider: string, segments: Array<{ provider: string; costUsd: number; totalTokens: number }>): string => {
    const sortedSegments = [...segments].sort((a, b) => b.costUsd - a.costUsd);
    const harnesses = sortedSegments.map((segment) => `<span class="harness-row ${segment.provider === hoveredProvider ? "hovered" : ""}"><i class="tooltip-harness-dot ${colors[segment.provider] || "mint"}"></i><span class="harness-name">${segment.provider}</span><span class="harness-detail"> · ${money(segment.costUsd)} · ${segment.totalTokens.toLocaleString()} tokens</span></span>`).join("");
    return `<span class="chart-tooltip"><strong>${money(day.costUsd)} total</strong><span>${day.date}</span><div class="tooltip-separator"></div>${harnesses}</span>`;
  };
  const renderSegment = (day: UsageDay, segment: { provider: string; costUsd: number; totalTokens: number }, segments: Array<{ provider: string; costUsd: number; totalTokens: number }>, height: number, offset = 0) => { const color = colors[segment.provider] || "mint"; return `<div class="chart-segment ${color}" style="height:${height}%;bottom:${offset}%">${usageTooltip(day, segment.provider, segments)}</div>`; };
  const todayOnly = usage.from === usage.to;
  chart.innerHTML = daily.length ? daily.map((day, dayIndex) => { const segments = providers.map((provider) => ({ provider, costUsd: day.byProvider?.[provider]?.costUsd || 0, totalTokens: day.byProvider?.[provider]?.totalTokens || 0 })).filter((segment) => segment.costUsd > 0 || segment.totalTokens > 0); const fallback = segments.length ? segments : [{ provider: "other", costUsd: day.costUsd, totalTokens: day.totalTokens }]; const displayedTotal = fallback.reduce((total, segment) => total + segment.costUsd, 0); if (todayOnly) return fallback.map((segment) => `<div class="chart-column today-harness" data-day-index="${dayIndex}" tabindex="0" aria-label="${day.date} ${segment.provider}: ${money(segment.costUsd)}"><div class="chart-stack"><div class="chart-segment ${colors[segment.provider] || "mint"}" style="height:${max ? Math.max(2, (segment.costUsd / max) * 100) : 2}%;bottom:0">${usageTooltip(day, segment.provider, fallback)}</div></div></div>`).join(""); const isCurrentDay = day.date === usage.to; let offset = 0; const markup = fallback.map((segment) => { const height = isCurrentDay ? (displayedTotal > 0 ? (segment.costUsd / displayedTotal) * 100 : 0) : (max ? Math.max(2, (segment.costUsd / max) * 100) : 2); const html = renderSegment(day, segment, fallback, height, offset); offset += height; return html; }).join(""); const stackHeight = max ? Math.max(2, (displayedTotal / max) * 100) : 2; return `<div class="chart-column ${isCurrentDay && !todayOnly ? "current-day" : ""}" data-day-index="${dayIndex}" tabindex="0" aria-label="${day.date}: ${money(displayedTotal)}"><div class="chart-stack" style="${isCurrentDay && !todayOnly ? `height:${stackHeight}% !important` : ""}">${markup}</div></div>`; }).join("") : `<div class="chart-empty">${usage.error || "No usage data in this range"}</div>`;
  (chart.querySelectorAll("[data-day-index]") as NodeListOf<HTMLElement>).forEach((bar) => bar.addEventListener("click", () => openDayDetails(daily[Number(bar.dataset.dayIndex)])));
  $("#models-list").innerHTML = usage.byModel?.length ? usage.byModel.slice(0, 5).map((model, index) => `<div class="model-row"><span class="model-rank">0${index + 1}</span><span class="model-name" title="${model.model}">${model.model}</span><span class="model-value">${money(model.costUsd)}</span></div>`).join("") : `<div class="quota-empty">No model breakdown available.</div>`;
}

function openDayDetails(day: UsageDay | undefined): void {
  if (!day) return;
  $("#usage-chart").classList.add("suppress-tooltips");
  $("#day-details-title").textContent = day.date;
  $("#day-details-content").innerHTML = (day.byModel || []).map((group) => `<section class="detail-group"><h3>${group.provider}</h3>${group.models.map((model) => `<div class="detail-model"><span>${model.model}</span><span>${money(model.costUsd)} · ${(model.totalTokens || 0).toLocaleString()} tokens</span></div>`).join("")}</section>`).join("") || `<p class="quota-empty">No model details available.</p>`;
  $("#day-details-dialog").showModal();
}

function renderStatus(data: Dashboard): void {
  const statuses = Object.values(data.providers);
  const enabled = statuses.filter((provider) => provider.enabled);
  const errors = enabled.filter((provider) => provider.status === "error");
  $("#status-copy").textContent = errors.length ? `${errors.length} source${errors.length > 1 ? "s" : ""} need attention` : `${enabled.length} source${enabled.length === 1 ? "" : "s"} active · local time and provider reports combined`;
  $("#updated-at").textContent = `updated ${relativeTime(data.serverNow)}`;
  $("#last-refresh").textContent = `Last refresh: ${formatRefreshTime(data.cache?.fetchedAt || data.serverNow)}`;
  $("#app-version").textContent = `Build ${data.version}`;
  $("#app-version").setAttribute("title", `Build ${data.version}`);
}

function renderClock(): void {
  const now = new Date();
  $("#now-time").textContent = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(now);
  $("#now-date").textContent = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(now);
}

async function loadDashboard(refresh = false): Promise<void> {
  document.querySelector(".range-picker")?.classList.add("loading");
  document.querySelectorAll<HTMLButtonElement>(".range-picker button").forEach((button) => { button.disabled = true; });
  $("#usage-total").textContent = "—";
  $("#usage-chart").innerHTML = `<div class="chart-empty">Loading usage data…</div>`;
  $("#models-list").innerHTML = `<div class="chart-empty">Loading model data…</div>`;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const response = await fetch(`/api/v1/dashboard?days=${state.days}&range=${encodeURIComponent(state.range === "today" ? "relative" : state.range.startsWith("relative-") ? "relative" : state.range)}&timezone=${encodeURIComponent(timezone)}${refresh ? "&refresh=1" : ""}`);
    if (!response.ok) throw new Error("Dashboard request failed");
    state.dashboard = await response.json();
    const dashboard = state.dashboard;
    if (dashboard) { renderQuotas(dashboard); renderUsage(dashboard.usage); renderStatus(dashboard); }
  } finally {
    document.querySelector(".range-picker")?.classList.remove("loading");
  document.querySelectorAll<HTMLButtonElement>(".range-picker button").forEach((button) => { button.disabled = false; });
  }
}

async function loadSettings(): Promise<void> {
  const response = await fetch("/api/v1/providers");
  const data = await response.json();
  const quotaSettings = providerOrder.map((id) => { const provider = data.providers[id]; return `<label class="setting-row"><div class="setting-copy"><div class="provider-name">${provider.name}</div><div class="provider-sub">${provider.description}${provider.configured ? " · configured" : " · credentials not detected"}</div></div><input class="switch" type="checkbox" data-kind="provider" data-provider="${id}" ${provider.enabled ? "checked" : ""} aria-label="Enable ${provider.name}" /></label>`; }).join("");
  const usageNames: Record<string, string> = usageSourceNames;
  const usageSettings = usageSourceOrder.map((id) => `<label class="setting-row"><div class="setting-copy"><div class="provider-name">${usageNames[id]} usage</div><div class="provider-sub">Provider group from shared ccusage output</div></div><input class="switch" type="checkbox" data-kind="usage" data-provider="${id}" ${data.usageSources?.[id]?.enabled ? "checked" : ""} aria-label="Enable ${usageNames[id]} usage" /></label>`).join("");
  $("#provider-settings").innerHTML = `<p class="settings-group">QUOTA PROVIDERS</p>${quotaSettings}<p class="settings-group">LOCAL USAGE SOURCES</p>${usageSettings}`;
  document.querySelectorAll<HTMLInputElement>(".switch").forEach((input) => input.addEventListener("change", async (event) => { const target = event.target as HTMLInputElement; const id = target.dataset.provider || ""; const kind = target.dataset.kind || ""; const path = kind === "usage" ? `/api/v1/usage-sources/${id}/enabled` : `/api/v1/providers/${id}/enabled`; await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: target.checked }) }); showToast(`${kind === "usage" ? usageNames[id] + " usage" : data.providers[id].name} ${target.checked ? "enabled" : "disabled"}`); await loadDashboard(true); }));
}

function showToast(message: string): void { const toast = $("#toast"); toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2200); }

$("#refresh-button").addEventListener("click", async () => { try { await loadDashboard(true); showToast("Data refreshed"); } catch (error) { showToast(error instanceof Error ? error.message : "Refresh failed"); } });
$("#settings-button").addEventListener("click", async () => { await loadSettings(); $("#settings-dialog").showModal(); });
$("#manage-button").addEventListener("click", async () => { await loadSettings(); $("#settings-dialog").showModal(); });
$("#close-settings").addEventListener("click", () => $("#settings-dialog").close());
$("#close-day-details").addEventListener("click", () => $("#day-details-dialog").close());
$("#day-details-dialog").addEventListener("close", () => { $("#usage-chart").classList.remove("suppress-tooltips"); (document.activeElement as HTMLElement | null)?.blur?.(); });
document.querySelectorAll<HTMLElement>("[data-range]").forEach((button) => button.addEventListener("click", async (event) => { const current = element(event.currentTarget); const value = current.dataset.range || "today"; state.range = value; state.days = value === "today" ? 1 : value.startsWith("relative-") ? Number(value.slice(9)) : value === "calendar-year" ? 365 : value === "calendar-month" ? 31 : 7; document.querySelectorAll<HTMLElement>(".range-tab").forEach((tab) => tab.classList.toggle("active", value === "today")); document.querySelectorAll<HTMLElement>(".range-menu-items button").forEach((item) => item.classList.toggle("active", item.dataset.range === value)); document.querySelectorAll<HTMLElement>(".range-menu-button").forEach((menuButton) => { const menu = menuButton.parentElement; if (!menu) return; const selected = menu.querySelector(`[data-range="${value}"]`); menuButton.classList.toggle("active", Boolean(selected)); menuButton.setAttribute("aria-expanded", "false"); menu.querySelector(".range-menu-items")?.classList.remove("open"); }); if (value !== "today") { const menuButton = current.closest(".range-menu")?.querySelector<HTMLElement>(".range-menu-button"); if (menuButton?.firstChild) menuButton.childNodes[0].textContent = `${current.textContent} `; } await loadDashboard(); }));
document.querySelectorAll<HTMLElement>(".range-menu-button").forEach((button) => button.addEventListener("click", (event) => { const parent = element(event.currentTarget).parentElement; if (!parent) return; const menu = parent.querySelector<HTMLElement>(".range-menu-items"); if (!menu) return; const open = menu.classList.toggle("open"); element(event.currentTarget).setAttribute("aria-expanded", String(open)); }));
function closeRangeMenus() { document.querySelectorAll(".range-menu-items").forEach((menu) => menu.classList.remove("open")); document.querySelectorAll(".range-menu-button").forEach((button) => button.setAttribute("aria-expanded", "false")); }
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeRangeMenus(); });
document.addEventListener("pointerdown", (event) => { if (!element(event.target).closest(".range-picker")) closeRangeMenus(); });
renderClock(); setInterval(renderClock, 30_000); setInterval(() => { if (state.dashboard) renderQuotas(state.dashboard); }, 60_000);
loadDashboard().catch((error) => { const message = error instanceof Error ? error.message : "Dashboard request failed"; $("#status-copy").textContent = message; showToast(message); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
