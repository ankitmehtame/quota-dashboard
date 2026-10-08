export type UsageSeverity = "warning" | "error" | null;

export function offlineUsageWarning(input: {
  local: boolean; brokerConnected: boolean; publisherStatus?: string;
  error: string | null; included: boolean; generatedAt: string | null;
  missingDates: string[]; today: string; now?: number;
}): boolean {
  if (input.local || !input.brokerConnected || input.publisherStatus !== "offline" || input.error || !input.included) return false;
  if (input.generatedAt !== null) {
    const timestamp = Date.parse(input.generatedAt);
    if (!Number.isFinite(timestamp) || timestamp > (input.now ?? Date.now()) + 60_000) return false;
  }
  const dates = [...new Set(input.missingDates)].sort();
  if (!dates.length) return true;
  if (dates.at(-1) !== input.today) return false;
  return dates.every((date, index) => {
    if (!index) return true;
    const previous = new Date(`${dates[index - 1]}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() + 1);
    return previous.toISOString().slice(0, 10) === date;
  });
}

export function aggregateUsageSeverity(severities: UsageSeverity[]): UsageSeverity {
  return severities.includes("error") ? "error" : severities.includes("warning") ? "warning" : null;
}
