/**
 * Renders an ISO 8601 timestamp in the viewer's local timezone with a readable
 * date + time. Returns "" for empty/invalid input so callers can keep their own
 * "—" fallback (e.g. `formatDateTime(r.activatedAt) || "—"`).
 *
 * Uses the browser's locale and timezone so audit timestamps stored in UTC
 * (DynamoDB ISO strings) are displayed in the operator's local time.
 *
 * @example
 *   formatDateTime("2026-07-16T00:27:01.661Z") // "Jul 15, 2026, 9:27:01 PM" (browser TZ/locale)
 *   formatDateTime("")                          // ""
 */
export function formatDateTime(iso: string): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
