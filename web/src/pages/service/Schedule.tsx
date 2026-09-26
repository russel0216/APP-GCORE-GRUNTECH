import { PmSchedule } from './Reports';

/**
 * Service Schedule — every visit kind on one calendar (item 8).
 *
 * Until the SVC package replaces this with the month grid, `/g-ops/visits`
 * keeps rendering the PM schedule it always did, so the menu entry never
 * falls through to "Not built yet" while the screen is being rebuilt.
 */
export function ServiceSchedule() {
  return <PmSchedule />;
}
