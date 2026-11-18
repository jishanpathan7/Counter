// Time helpers that work in the institute's time zone without extra libraries.

const partsCache = new Map();

function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return partsCache.get(tz);
}

function zonedParts(tz, ts) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

function offsetMs(tz, ts) {
  const p = zonedParts(tz, ts);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 'YYYY-MM-DD' for the given instant in the time zone. */
export function localDate(tz, ts) {
  const p = zonedParts(tz, ts);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday, in the time zone. */
export function localWeekday(tz, ts) {
  return zonedParts(tz, ts).weekday;
}

/** ISO UTC timestamp for a wall-clock date ('YYYY-MM-DD') and time ('HH:MM') in the time zone. */
export function zonedTimeToIso(tz, date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetMs(tz, guess);
  // Re-check once in case the offset differs at the real instant (DST edges).
  ts = guess - offsetMs(tz, ts);
  return new Date(ts).toISOString();
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** '4:10 PM' style label in the time zone. */
export function formatTime(tz, iso) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso))
    .toUpperCase();
}
