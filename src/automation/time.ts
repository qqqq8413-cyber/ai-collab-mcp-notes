// Authorization windows and evidence ordering compare instants, never strings:
// '2026-09-26T00:00:00Z' sorts after '2026-09-26T00:00:00.900Z' because '.' < 'Z'.
// Accepted form is an RFC 3339 date-time with an explicit Z or ±HH:MM offset and at
// most millisecond precision, so every accepted value names exactly one epoch
// millisecond and no comparison depends on rounding.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Epoch milliseconds for a valid timestamp; undefined for anything else. */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = INSTANT.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHours = Number(match[9] ?? 0), offsetMinutes = Number(match[10] ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return undefined;
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  // Rejects overflowing calendar dates such as 02-30, and two-digit years that
  // Date.UTC would silently map into the 1900s.
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return undefined;
  const offset = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return wall.getTime() - offset;
}

export function isInstant(value: unknown): value is string {
  return parseInstant(value) !== undefined;
}
