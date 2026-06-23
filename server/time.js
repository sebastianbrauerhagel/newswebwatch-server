// Timezone-aware "day" boundaries, so the dashboard's "today" means today in Oslo,
// not in UTC. Implemented with Intl so we need no date library.

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    map.hour === '24' ? 0 : Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - date.getTime();
}

// UTC epoch ms for wall-clock midnight of (y, m, d) in tz.
function zonedMidnightMs(y, m, d, tz) {
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzOffsetMs(new Date(utcGuess), tz);
  return utcGuess - offset;
}

function todayYMD(tz) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

// Returns { fromMs, toMs, date } for a given YYYY-MM-DD string (or today in tz if absent).
export function dayRange(dateStr, tz) {
  let y, m, d;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [y, m, d] = dateStr.split('-').map(Number);
  } else {
    ({ y, m, d } = todayYMD(tz));
  }
  const fromMs = zonedMidnightMs(y, m, d, tz);
  const toMs = zonedMidnightMs(y, m, d + 1, tz); // Date.UTC handles month/day overflow
  const date = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { fromMs, toMs, date };
}
