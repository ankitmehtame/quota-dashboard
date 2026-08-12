import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function dailyRows(document) {
  return Array.isArray(document?.daily) ? document.daily.filter((row) => row && typeof row === "object") : [];
}

function modelRows(row) {
  if (Array.isArray(row.modelBreakdowns)) return row.modelBreakdowns.filter((model) => model && typeof model === "object");
  return [{
    modelName: "unknown",
    inputTokens: row.inputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    outputTokens: row.outputTokens,
    cost: row.totalCost,
  }];
}

function usageRows(row) {
  if (Array.isArray(row.agents) && row.agents.length > 0) return row.agents;
  return [row];
}

function rowProvider(row) {
  const agents = Array.isArray(row.metadata?.agents)
    ? row.metadata.agents.filter((agent) => typeof agent === "string" && agent.trim()).map((agent) => agent.trim().toLowerCase())
    : [];
  if (agents.length === 1) return agents[0];
  if (agents.length > 1) return "shared";
  if (typeof row.agent === "string" && row.agent !== "all") return row.agent.trim().toLowerCase();
  return "unknown";
}

export function parseCcusage(document) {
  const records = [];
  for (const parentRow of dailyRows(document)) {
    for (const row of usageRows(parentRow)) {
    const date = row.date ?? row.period ?? parentRow.period;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const model of modelRows(row)) {
      const modelName = typeof model.modelName === "string" && model.modelName.trim() ? model.modelName.trim() : "unknown";
      records.push({
        date,
        provider: String(model.provider ?? model.source ?? row.provider ?? row.source ?? rowProvider(row)).trim().toLowerCase(),
        model: modelName,
        inputTokens: nonNegative(model.inputTokens),
        cachedInputTokens: nonNegative(model.cacheReadTokens),
        cacheCreationTokens: nonNegative(model.cacheCreationTokens),
        outputTokens: nonNegative(model.outputTokens),
        reasoningTokens: nonNegative(model.reasoningTokens),
        costUsd: nonNegative(model.cost),
      });
    }
  }
  }
  return records;
}

function emptySummary(status = "disabled", error = null, source = null) {
  return { status, error, source, daily: [], byModel: [], byProvider: [], totalCostUsd: 0, totalTokens: 0 };
}

function summarize(records) {
  const daily = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  for (const record of records) {
    const totalTokens = record.inputTokens + record.cachedInputTokens + record.cacheCreationTokens + record.outputTokens + record.reasoningTokens;
    const day = daily.get(record.date) ?? { date: record.date, costUsd: 0, totalTokens: 0, byProvider: {}, byModel: [] };
    day.costUsd += record.costUsd;
    day.totalTokens += totalTokens;
    daily.set(record.date, day);
    const model = byModel.get(`${record.provider}:${record.model}`) ?? { provider: record.provider, model: record.model, costUsd: 0, totalTokens: 0 };
    model.costUsd += record.costUsd;
    model.totalTokens += totalTokens;
    byModel.set(`${record.provider}:${record.model}`, model);
    const provider = byProvider.get(record.provider) ?? { provider: record.provider, costUsd: 0, totalTokens: 0 };
    provider.costUsd += record.costUsd;
    provider.totalTokens += totalTokens;
    byProvider.set(record.provider, provider);
    const dayProvider = day.byProvider[record.provider] ?? { costUsd: 0, totalTokens: 0 };
    dayProvider.costUsd += record.costUsd;
    dayProvider.totalTokens += totalTokens;
    day.byProvider[record.provider] = dayProvider;
    let modelGroup = day.byModel.find((entry) => entry.provider === record.provider);
    if (!modelGroup) {
      modelGroup = { provider: record.provider, models: [] };
      day.byModel.push(modelGroup);
    }
    let modelDetail = modelGroup.models.find((entry) => entry.model === record.model);
    if (!modelDetail) {
      modelDetail = { model: record.model, costUsd: 0, totalTokens: 0 };
      modelGroup.models.push(modelDetail);
    }
    modelDetail.costUsd += record.costUsd;
    modelDetail.totalTokens += totalTokens;
  }
  return {
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    byProvider: [...byProvider.values()].sort((a, b) => b.costUsd - a.costUsd),
    totalCostUsd: records.reduce((total, record) => total + record.costUsd, 0),
    totalTokens: records.reduce((total, record) => total + record.inputTokens + record.cachedInputTokens + record.cacheCreationTokens + record.outputTokens + record.reasoningTokens, 0),
  };
}

export async function readCcusageUsage({ from, to, timeZone }) {
  const binary = process.env.CCUSAGE_BIN?.trim() || "ccusage";
  try {
    const { stdout } = await execFileAsync(binary, ["daily", "--json", "--by-agent", "--since", from, "--until", to, "--timezone", timeZone], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    const records = parseCcusage(JSON.parse(stdout));
    return { status: "ok", error: null, source: binary, records, ...summarize(records) };
  } catch (error) {
    const detail = error?.code === "ENOENT" ? `${binary} was not found` : error?.message || "ccusage failed";
    return { ...emptySummary("error", detail, binary), records: [] };
  }
}

export async function readUsageSources(enabledProviders, range) {
  const result = await readCcusageUsage(range);
  if (result.status !== "ok") {
    return { ...result, sources: enabledProviders.map((provider) => ({ provider, status: result.status, error: result.error })) };
  }
  const selected = new Set(enabledProviders);
  if (selected.has("opencode") || selected.has("hermes")) selected.add("shared");
  const selectedRecords = (result.records || []).filter((record) => selected.has(record.provider));
  const summary = summarize(selectedRecords);
  return {
    status: "ok",
    error: null,
    source: binarySource(),
    sources: enabledProviders.map((provider) => ({ provider, status: "ok", error: null })),
    ...summary,
  };
}

function binarySource() {
  return process.env.CCUSAGE_BIN?.trim() || "ccusage";
}

export const readCodexUsage = (range) => readCcusageUsage(range);
