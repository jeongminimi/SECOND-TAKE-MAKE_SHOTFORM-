'use strict';

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Local wall-clock (YYYY-MM-DD, HH:MM) in timeZone → UTC ISO string. DST-safe (two-pass). */
function zonedToUtcIso(dateStr, timeStr, timeZone) {
  assertDate(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts).toISOString().replace('.000Z', 'Z');
}

/** Today's calendar date in timeZone. */
function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** UTC instant at the end (exclusive) of a local operating date. */
function endOfLocalDateUtc(dateStr, timeZone) {
  return zonedToUtcIso(addDays(dateStr, 1), '00:00', timeZone);
}

function addDays(dateStr, n) {
  assertDate(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Local calendar date of a UTC instant. */
function localDateOf(isoUtc, timeZone) {
  return todayIn(timeZone, new Date(isoUtc));
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function assertDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s)) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
    throw new Error(`Invalid date (expected YYYY-MM-DD): ${s}`);
  }
}

function fmtTimestamp(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

module.exports = { zonedToUtcIso, todayIn, endOfLocalDateUtc, addDays, localDateOf, daysBetween, assertDate, fmtTimestamp, tzOffsetMs };
