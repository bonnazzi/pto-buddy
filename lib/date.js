// lib/date.js

export function isISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseISODateUTC(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function daysBetweenUTC(start, end) {
  const ms = parseISODateUTC(end) - parseISODateUTC(start);
  return Math.floor(ms / (24 * 3600 * 1000));
}

export function calculateBusinessDays(startISO, endISO, { inclusive = true } = {}) {
  const start = parseISODateUTC(startISO);
  const end = parseISODateUTC(endISO);
  if (end < start) throw new Error("End date is before start date");

  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const dow = current.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return inclusive ? count : Math.max(0, count - 1);
}
