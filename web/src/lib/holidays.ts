import { useEffect, useState } from 'react';
import { api } from './api';
import type { HolidayKeys } from './day';

/**
 * The holidays every working-day count skips (2026-10-17): `GET /holidays`,
 * fetched once a minute at most and shared by every form that counts days —
 * the costing sheet, the project form and the job order form — so they
 * agree with the API's own count (`shared/day.ts`).
 */
export interface Holiday {
  date: string;
  name: string;
  kind: 'REGULAR' | 'SPECIAL';
}

let cached: { at: number; list: Promise<Holiday[]> } | null = null;

export function loadHolidays(): Promise<Holiday[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.list;
  const list = api
    .get<{ holidays: Holiday[] }>('/holidays')
    .then((r) => r.holidays)
    .catch(() => {
      cached = null;
      return [] as Holiday[];
    });
  cached = { at: Date.now(), list };
  return list;
}

/** Forget the cached list — after Company Settings saves a new one. */
export function dropHolidays(): void {
  cached = null;
}

const EMPTY: HolidayKeys = new Set();

/** The holidays as day keys, for `workingDayKey` / `workingDaysBetween`; none until they load. */
export function useHolidayKeys(): HolidayKeys {
  const [keys, setKeys] = useState<HolidayKeys>(EMPTY);
  useEffect(() => {
    let live = true;
    void loadHolidays().then((list) => {
      if (live) setKeys(new Set(list.map((h) => h.date)));
    });
    return () => {
      live = false;
    };
  }, []);
  return keys;
}
