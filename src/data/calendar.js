/**
 * The wheel's calendar — the one place a date becomes a day of the year.
 *
 * DOY 0 is the WINTER SOLSTICE, Dec 21: the day at the top of the wheel. The
 * year runs clockwise from there, so Dec 31 is DOY 10, Jan 1 is DOY 11, Jun 21
 * is DOY 182 and Dec 20 is DOY 364. Every 365-point series, every stored normal,
 * every marker and every date label uses this numbering.
 *
 * It is a 365-day year: Feb 29 has no slot. A normal simply skips it — a 30-year
 * mean has plenty of other years for that slot — while a single observation or
 * event that lands on it can fold onto Mar 1 with `{ leapDay: 'mar1' }`.
 *
 * Nothing else in the app does month arithmetic. Each module used to carry its
 * own copy counting from Jan 1, with the solstice put at the top afterwards by
 * rotating the drawing — and independent copies of the same arithmetic are how
 * two displays drift apart without anyone noticing.
 */

export const N = 365;

export const DIM   = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MON_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MON_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Days before each month, counted from Jan 1.
const BEFORE = DIM.reduce((acc, n) => (acc.push(acc[acc.length - 1] + n), acc), [0]);

// Dec 21, counted from Jan 1.
const SOLSTICE_FROM_JAN1 = BEFORE[11] + 20;

const wrap = d => ((d % N) + N) % N;

/** Days since Jan 1 (0–364) → DOY. */
export const jan1ToDOY = days => wrap(days - SOLSTICE_FROM_JAN1);

/**
 * DOY → days since Jan 1 (0–364). The count an outside convention expects: the
 * solar declination formula, or the Julian day in a MODIS composite key.
 */
export const doyToJan1 = doy => wrap(Math.round(doy) + SOLSTICE_FROM_JAN1);

/** Month (1–12) and day of month → DOY. Feb 29 → null, or Mar 1's DOY with `{ leapDay: 'mar1' }`. */
export function monthDayToDOY(month, day, { leapDay = 'skip' } = {}) {
  if (month === 2 && day === 29) {
    if (leapDay !== 'mar1') return null;
    month = 3; day = 1;
  }
  return jan1ToDOY(BEFORE[month - 1] + day - 1);
}

/** 'YYYY-MM-DD' → DOY. Feb 29 is handled as in `monthDayToDOY`. */
export function dateToDOY(dateStr, opts) {
  const [, month, day] = dateStr.split('-').map(Number);
  return monthDayToDOY(month, day, opts);
}

/** DOY → { month: 0–11, day: 1–31 }. A fractional DOY rounds to the nearest day. */
export function doyToMonthDay(doy) {
  let d = doyToJan1(doy), month = 0;
  while (month < 11 && d >= DIM[month]) { d -= DIM[month]; month++; }
  return { month, day: d + 1 };
}

/** Month index (0–11) containing a DOY. */
export const doyMonth = doy => doyToMonthDay(doy).month;

/** "Mar 4" (or "March 4" when `long`) for a DOY. */
export function doyLabel(doy, long = false) {
  const { month, day } = doyToMonthDay(doy);
  return `${(long ? MON_L : MON_S)[month]} ${day}`;
}

/**
 * The DOY each month (Jan…Dec) begins on. December begins at DOY 345 and runs
 * on past the top of the wheel to DOY 10, so on the wheel it is drawn from 345
 * to 376 — an angle past a full turn is the same place.
 */
export const MONTH_START = BEFORE.slice(0, 12).map(jan1ToDOY);

/**
 * The months along a straight 0–365 axis, for a chart that unrolls the wheel.
 * The top of the wheel falls inside December, so December is the one month that
 * appears twice: Dec 21–31 opens the axis and Dec 1–20 closes it.
 *
 * @returns {{month:number, start:number, end:number}[]} in axis order; `end` is exclusive.
 */
export function monthSpans() {
  const spans = [];
  MONTH_START.forEach((start, month) => {
    const end = start + DIM[month];
    if (end <= N) spans.push({ month, start, end });
    else spans.push({ month, start, end: N }, { month, start: 0, end: end - N });
  });
  return spans.sort((a, b) => a.start - b.start);
}
