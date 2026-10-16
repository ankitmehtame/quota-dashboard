/** Convert a collector tool name to a safe filename and configuration key. */
export function normalizeUsageToolId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("tool ID must be a non-empty string");
  const input = value.trim().normalize("NFKC");
  if (input === "." || input === ".." || input.includes("/") || input.includes("\\") || input.includes("..")) {
    throw new Error(`Unsafe tool ID: ${value}`);
  }
  const normalized = input.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 128);
  if (!normalized) throw new Error(`Tool ID cannot be used as a filename: ${value}`);
  if (normalized === "raw" || normalized.startsWith("raw.") || ["__proto__", "constructor", "prototype"].includes(normalized)) {
    throw new Error(`Reserved tool ID: ${value}`);
  }
  return normalized;
}

export function isUsageSourceId(value: unknown): value is string {
  try { return normalizeUsageToolId(value) === value && value !== "shared"; } catch { return false; }
}
