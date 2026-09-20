export type ColdDayFailure = { date: string; error: unknown };

function nextDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Return a cold range newest-first without changing the public range semantics. */
export function reverseDateList(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let cursor = from; cursor <= to; cursor = nextDate(cursor)) dates.push(cursor);
  return dates.reverse();
}

/** Run every cold date, reporting failures without aborting the remaining dates. */
export async function processColdDays({
  from,
  to,
  run,
  onStart,
  onSuccess,
  onFailure,
}: {
  from: string;
  to: string;
  run: (date: string) => Promise<void>;
  onStart?: (date: string) => void;
  onSuccess?: (date: string) => void;
  onFailure?: (date: string, error: unknown) => void;
}): Promise<{ succeeded: number; failures: ColdDayFailure[] }> {
  let succeeded = 0;
  const failures: ColdDayFailure[] = [];
  for (const date of reverseDateList(from, to)) {
    onStart?.(date);
    try {
      await run(date);
      succeeded += 1;
      onSuccess?.(date);
    } catch (error) {
      failures.push({ date, error });
      onFailure?.(date, error);
    }
  }
  return { succeeded, failures };
}
