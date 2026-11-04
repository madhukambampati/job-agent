/**
 * Calendar days in the machine's local time zone. toISOString() is UTC, which
 * rolls to "tomorrow" every evening in Toronto and broke the ledger's dates
 * and the daily cap.
 */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return localDay(d);
}
