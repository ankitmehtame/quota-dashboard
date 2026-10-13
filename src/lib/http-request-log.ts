export type HttpRequestLog = {
  arrival: string;
  completion(status: number, latencyMs: number, aborted: boolean): string;
};

/** Structured request lines deliberately receive only the URL pathname, never its query. */
export function createHttpRequestLog(input: {
  id: string;
  method: string;
  pathname: string;
  startedAt: number;
}): HttpRequestLog {
  const identity = `id=${input.id} method=${input.method} path=${input.pathname}`;
  return {
    arrival: `http arrival ${identity}`,
    completion: (status, latencyMs, aborted) => `http complete ${identity} status=${status} latency=${Math.max(0, latencyMs).toFixed(1)}ms${aborted ? " aborted=true" : ""}`,
  };
}
