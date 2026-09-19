/**
 * Today, as the calendar sees it here.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to write this and
 * it is wrong: it gives the UTC date. The server keys attendance on the LOCAL
 * day (`dayKey()` in `api/src/shared/hr.ts`), so between midnight and 08:00 in
 * Manila the two disagree — the HR dashboard opened at 07:00 on the 20th asked
 * for the 19th, showed everybody absent, and the CSV extract pulled the wrong
 * day's attendance out with it. An attendance record is evidence; handing HR
 * yesterday's and labelling it today is not a cosmetic fault.
 *
 * Anything sending a bare calendar date to the API uses this.
 */
export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
