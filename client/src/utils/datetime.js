// Shared datetime helpers for <input type="datetime-local"> and local-day
// bucketing.
//
// datetime-local inputs speak "YYYY-MM-DDTHH:mm" in the user's LOCAL
// timezone. Date#toISOString() is UTC — seeding an input from it shifts the
// shown time by the UTC offset (8h in the past for UTC+8 users), and
// submitting the naive local string as if it were UTC shifts it again on the
// server. Always convert through these helpers instead.

// Date | ISO string | epoch ms → "YYYY-MM-DDTHH:mm" in local time.
// Returns '' for invalid input.
export function toLocalInputValue(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "YYYY-MM-DDTHH:mm" (local, as produced by a datetime-local input) → UTC ISO
// string for the API. `new Date(value)` parses date-time strings without a
// timezone designator as local time, which is exactly what the input emits.
// Returns '' for empty/invalid input.
export function localInputValueToIso(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

// Local-timezone "YYYY-MM-DD" day key. Unlike toISOString().slice(0, 10)
// (which buckets by UTC), this never shifts late-evening / early-morning
// times onto a neighboring day for users away from UTC.
export function ymdLocal(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
