/**
 * Calendar verification — the sales calendar's window rule and month grid.
 *
 *   npx tsx scripts/verify-calendar.ts      (the API should be running)
 *
 * Two things here are easy to get wrong and invisible when wrong:
 *
 *   · The activity window. `activityWhere()` is inclusive on both ends and a
 *     record filter drops the window altogether. A month window that ended on
 *     midnight would count that instant twice — once as the last instant of
 *     one grid and once as the first of the next — so `windowFor()` ends on
 *     23:59:59.999 and this script books an activity on the boundary to prove
 *     it lands in exactly one window.
 *   · The month grid's edge months. A month that starts on a Sunday has six
 *     leading days from the month before; a 28-day February that starts on a
 *     Monday has two whole trailing rows of March; December + 1 is January
 *     of the next year. Each one is pinned.
 *
 * The grid helpers live in `web/src/lib/day.ts`. They are DOM-free, and tsx
 * resolves the relative import across the package boundary, so this script
 * checks the same code the browser runs rather than a copy.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { activityEmailText, activityWhere, repeatOccurrences, sendDueReminders } from '../src/shared/activities';
import { seedActivityTypes } from '../src/shared/activityTypes';
import { annualDayIn, fillGreeting, occurrencesBetween, sendDueGreetings } from '../src/shared/celebrations';
import { GREETING_DEFAULTS } from '../src/shared/hr';
import { resolveUser } from '../src/permissions/resolve';
import { blockSpan, minutesLabel, placeInLanes, slotAt } from '../../web/src/lib/timeGrid';
// Imported for its side effect: it registers the sales-activity schedule provider.
import { scheduleFor } from '../src/routes/workspace';
import { manilaDayKey, manilaMonthKey } from '../src/shared/day';
// Cross-package import: tsx resolves it; the file has no DOM dependency.
import {
  addDays,
  addMonthsKey,
  dayKeyOf,
  firstOfMonth,
  isDayKey,
  isMonthKey,
  lastOfMonth,
  mondayOf,
  monthGrid,
  monthOf,
  parseDay,
  weekDays,
  windowFor,
} from '../../web/src/lib/day';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TAG = 'ZZCAL';
const BASE = `http://localhost:${env.port}/api`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.salesActivity.deleteMany({ where: { subject: { startsWith: TAG } } });
  // After the activities: a type in use refuses to go.
  await prisma.salesActivityType.deleteMany({ where: { key: { startsWith: TAG } } });
  // The greetings told real people too (the office bell): every title carries the TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.greeting.deleteMany({ where: { employee: { employeeNo: { startsWith: TAG } } } });
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifycal.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzcal_' } } });
}

/** A throwaway role holding exactly the permissions named — never a seeded one. */
async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, email: string, roleIds: string[]) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

async function apiGet(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function apiSend(token: string, method: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE calendar verification\n');
  await cleanup();

  // ══ Day keys ═══════════════════════════════════════════════════════════════
  console.log('Day keys (web/src/lib/day.ts)');

  check('parseDay gives local midnight', parseDay('2026-09-21').getTime() === new Date(2026, 8, 21).getTime());
  check('dayKeyOf round-trips parseDay', dayKeyOf(parseDay('2026-02-29')) !== '2026-02-29' && dayKeyOf(parseDay('2024-02-29')) === '2024-02-29');
  check('isDayKey refuses a day that does not exist', !isDayKey('2026-02-30') && !isDayKey('2026-9-1') && isDayKey('2026-09-01'));
  check('isMonthKey accepts YYYY-MM only', isMonthKey('2026-09') && !isMonthKey('2026-13') && !isMonthKey('2026-09-01'));
  check('mondayOf a Saturday is the Monday before', mondayOf('2026-10-03') === '2026-09-28');
  check('mondayOf a Monday is itself', mondayOf('2026-09-28') === '2026-09-28');
  check('addDays crosses a month end', addDays('2026-09-30', 1) === '2026-10-01' && addDays('2026-10-01', -1) === '2026-09-30');
  check('monthOf', monthOf('2026-10-03') === '2026-10');
  check('firstOfMonth / lastOfMonth', firstOfMonth('2024-02') === '2024-02-01' && lastOfMonth('2024-02') === '2024-02-29' && lastOfMonth('2026-02') === '2026-02-28');
  check('addMonthsKey December + 1 is January of the next year', addMonthsKey('2026-12', 1) === '2027-01');
  check('addMonthsKey January − 1 is December of the year before', addMonthsKey('2026-01', -1) === '2025-12');
  check('weekDays gives seven consecutive days from the Monday', (() => {
    const w = weekDays('2026-09-23'); // a Wednesday: normalised to its Monday
    return w.length === 7 && w[0] === '2026-09-21' && w[6] === '2026-09-27';
  })());

  // ══ The month grid ═════════════════════════════════════════════════════════
  console.log('\nThe month grid');

  const march = monthGrid('2026-03');
  check('a grid is always 42 cells', march.length === 42 && monthGrid('2027-02').length === 42);
  check('March 2026 starts on a Sunday, so the grid opens on Monday 23 February', march[0] === '2026-02-23', march[0]);
  check('the first cell of every grid is a Monday', parseDay(march[0]).getDay() === 1 && parseDay(monthGrid('2026-09')[0]).getDay() === 1);
  const feb27 = monthGrid('2027-02');
  check('February 2027 (28 days from a Monday) fills four rows; the last two are all March', feb27[0] === '2027-02-01' && feb27.slice(28).every((d) => monthOf(d) === '2027-03'));
  check('September 2026 grid runs 31 Aug → 11 Oct', monthGrid('2026-09')[0] === '2026-08-31' && monthGrid('2026-09')[41] === '2026-10-11');

  // ══ The fetch window ═══════════════════════════════════════════════════════
  console.log('\nThe fetch window');

  const sep = windowFor('month', '2026-09');
  check('month window starts at local midnight of the first grid day', sep.from.getTime() === new Date(2026, 7, 31, 0, 0, 0, 0).getTime());
  check('month window ends 2026-10-11T23:59:59.999 local, not the next midnight', sep.to.getTime() === new Date(2026, 9, 11, 23, 59, 59, 999).getTime(), sep.to.toString());
  const wk = windowFor('week', '2026-09-21');
  check('week window is Monday 00:00 → Sunday 23:59:59.999', wk.from.getTime() === new Date(2026, 8, 21).getTime() && wk.to.getTime() === new Date(2026, 8, 27, 23, 59, 59, 999).getTime());
  const dayWin = windowFor('day', '2026-09-23');
  check('a day window is that one day, midnight to 23:59:59.999', dayWin.from.getTime() === new Date(2026, 8, 23).getTime() && dayWin.to.getTime() === new Date(2026, 8, 23, 23, 59, 59, 999).getTime());

  // ══ The time grid (web/src/lib/timeGrid.ts) ════════════════════════════════
  console.log('\nThe time grid');
  const d0 = new Date(2026, 8, 23).getTime();
  const at = (h: number, m = 0) => d0 + (h * 60 + m) * 60_000;
  check('a block sits at its minutes from midnight, as tall as it is long', JSON.stringify(blockSpan(at(9, 30), at(11), d0)) === '{"top":570,"height":90}', JSON.stringify(blockSpan(at(9, 30), at(11), d0)));
  check('a five-minute call is still drawn 20 minutes tall', blockSpan(at(9), at(9, 5), d0)?.height === 20);
  check(
    'an activity across midnight is clipped to each day it touches, and absent from a day it does not',
    JSON.stringify(blockSpan(at(23), at(25), d0)) === '{"top":1380,"height":60}' &&
      JSON.stringify(blockSpan(at(23), at(25), d0 + 86_400_000)) === '{"top":0,"height":60}' &&
      blockSpan(at(1), at(2), d0 + 86_400_000) === null &&
      blockSpan(at(10), at(10), d0) === null,
  );
  const lanes = placeInLanes([
    { top: 540, height: 60, id: 'a' },
    { top: 570, height: 60, id: 'b' },
    { top: 600, height: 30, id: 'c' },
    { top: 780, height: 60, id: 'd' },
  ]);
  check(
    'overlapping blocks share the column in lanes; a later block takes the first lane free; a block alone has the column',
    lanes.map((l) => `${l.id}:${l.lane}/${l.lanes}`).join() === 'a:0/2,b:1/2,c:0/2,d:0/1',
    lanes.map((l) => `${l.id}:${l.lane}/${l.lanes}`).join(),
  );
  check('a click lands on the half hour, inside the day', slotAt(589) === 570 && slotAt(-5) === 0 && slotAt(1439) === 1410);
  check('the gutter reads as a clock', minutesLabel(0) === '12:00 AM' && minutesLabel(570) === '9:30 AM' && minutesLabel(13 * 60) === '1:00 PM');

  // ══ Birthdays and work anniversaries (shared/celebrations.ts) ═════════════
  console.log('\nBirthdays and work anniversaries');
  const feb29 = new Date('1992-02-29T00:00:00Z');
  check(
    'an annual date falls on its day each year; 29 February keeps to 28 February in a common year',
    annualDayIn(feb29, 2026) === '2026-02-28' && annualDayIn(feb29, 2028) === '2028-02-29' && annualDayIn(new Date('1990-10-08T00:00:00Z'), 2026) === '2026-10-08',
  );
  check(
    'occurrences in a window carry the years since; a window across New Year finds the next year’s; the date itself is no occasion',
    JSON.stringify(occurrencesBetween(new Date('1990-12-30T00:00:00Z'), '2026-12-20', '2027-01-05')) === '[{"day":"2026-12-30","years":36}]' &&
      JSON.stringify(occurrencesBetween(new Date('2026-01-02T00:00:00Z'), '2026-12-20', '2027-01-05')) === '[{"day":"2027-01-02","years":1}]' &&
      occurrencesBetween(new Date('2026-12-25T00:00:00Z'), '2026-12-20', '2026-12-31').length === 0,
  );
  check(
    'a greeting template fills in the person, the company and the years',
    fillGreeting('Happy work anniversary, {first} — {years} with {company}! ({n})', { name: 'Maria Santos', firstName: 'Maria', years: 1 }, 'Gruntech') ===
      'Happy work anniversary, Maria — 1 year with Gruntech! (1)',
  );

  // ══ activityWhere ══════════════════════════════════════════════════════════
  console.log('\nactivityWhere (api/src/shared/activities.ts)');

  const dflt = activityWhere({});
  const range = dflt.where.startsAt as { gte: Date; lte: Date };
  check('no window given → 14 days from now, inclusive both ends', range.lte.getTime() - range.gte.getTime() === 14 * 86400000 && dflt.orderBy.startsAt === 'asc');

  const rec = activityWhere({ leadId: 'lead-1', from: '2026-01-01', to: '2026-01-02' });
  check('a record filter drops the window and sorts newest first', rec.where.startsAt === undefined && rec.where.leadId === 'lead-1' && rec.orderBy.startsAt === 'desc');

  const win = activityWhere({ from: wk.from.toISOString(), to: wk.to.toISOString(), assignedToId: 'u1' });
  const w = win.where.startsAt as { gte: Date; lte: Date };
  check(
    'a window is gte/lte on the instants given, plus the person — booked for them or invited',
    w.gte.getTime() === wk.from.getTime() &&
      w.lte.getTime() === wk.to.getTime() &&
      JSON.stringify(win.where.OR) === JSON.stringify([{ assignedToId: 'u1' }, { invitees: { some: { userId: 'u1' } } }]),
    JSON.stringify(win.where),
  );

  // Fixtures on the boundary between two weeks.
  const role = await makeRole('zzcal_sales', `${TAG} sales`, ['gops.calendar.view_all']);
  const bystanderRole = await makeRole('zzcal_bystander', `${TAG} bystander`, ['gops.leads.view_own']);
  const sales = await makeUser(`${TAG} Sales`, 'sales@verifycal.local', [role.id]);
  const bystander = await makeUser(`${TAG} Bystander`, 'bystander@verifycal.local', [bystanderRole.id]);

  const weekA = windowFor('week', '2026-09-21');
  const weekB = windowFor('week', '2026-09-28');
  const mk = (subject: string, startsAt: Date) =>
    prisma.salesActivity.create({
      data: { subject: `${TAG} ${subject}`, assignedToId: sales.id, startsAt, durationMinutes: 30 },
    });
  const first = await mk('first instant', weekA.from);
  const last = await mk('last instant', weekA.to);
  const midnight = await mk('next midnight', weekB.from);
  await mk('mid week', new Date(2026, 8, 23, 10, 0));

  const inA = await prisma.salesActivity.findMany({
    ...activityWhere({ from: weekA.from.toISOString(), to: weekA.to.toISOString() }),
    select: { id: true },
  });
  const inB = await prisma.salesActivity.findMany({
    ...activityWhere({ from: weekB.from.toISOString(), to: weekB.to.toISOString() }),
    select: { id: true },
  });
  const idsA = new Set(inA.map((a) => a.id));
  const idsB = new Set(inB.map((a) => a.id));
  check('the first instant of a window is inside it (gte)', idsA.has(first.id));
  check('the last instant, 23:59:59.999, is inside it (lte)', idsA.has(last.id));
  check("the next window's midnight is NOT in this one — no double count", !idsA.has(midnight.id) && idsB.has(midnight.id));
  check("this window's last instant is not in the next one either", !idsB.has(last.id));

  const ordered = await prisma.salesActivity.findMany({
    ...activityWhere({ from: weekA.from.toISOString(), to: weekA.to.toISOString(), assignedToId: sales.id }),
    select: { startsAt: true },
  });
  check('a window lists oldest first', ordered.every((r, i) => i === 0 || r.startsAt >= ordered[i - 1].startsAt) && ordered.length === 3);

  // ══ Manila-pinned keys ═════════════════════════════════════════════════════
  console.log('\nManila-pinned keys (api/src/shared/day.ts)');

  check('16:30Z on 2 October is 3 October in Manila', manilaDayKey(new Date('2026-10-02T16:30:00Z')) === '2026-10-03');
  check('15:59Z on 2 October is still 2 October in Manila', manilaDayKey(new Date('2026-10-02T15:59:59Z')) === '2026-10-02');
  check('month key follows the same pin', manilaMonthKey(new Date('2026-09-30T16:30:00Z')) === '2026-10');

  // ══ Route guard (over HTTP) ════════════════════════════════════════════════
  console.log('\nRoute guard (over HTTP)');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route guard was NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const salesToken = signToken(sales.id, sales.email);
    const bystanderToken = signToken(bystander.id, bystander.email);
    const q = `?from=${encodeURIComponent(weekA.from.toISOString())}&to=${encodeURIComponent(weekA.to.toISOString())}&assignedToId=${sales.id}`;

    const ok = await apiGet(salesToken, `/activities${q}`);
    const rows = Array.isArray(ok.body) ? (ok.body as { id: string }[]) : [];
    const got = new Set(rows.map((r) => r.id));
    check('GET /activities honours the same inclusive window as activityWhere', ok.status === 200 && got.has(first.id) && got.has(last.id) && !got.has(midnight.id) && rows.length === 3, `${ok.status}, ${rows.length} rows`);

    const denied = await apiGet(bystanderToken, `/activities${q}`);
    check('without gops.calendar.view_all the calendar is refused', denied.status === 403, String(denied.status));

    const lookup = await apiGet(salesToken, '/users/lookup');
    const people = Array.isArray(lookup.body) ? (lookup.body as Record<string, unknown>[]) : [];
    check(
      'the person picker reads /users/lookup without admin.users, and it carries no password hash',
      lookup.status === 200 && people.some((p) => p.id === sales.id) && people.every((p) => !('passwordHash' in p)),
      String(lookup.status),
    );

    // The assignee picker narrows to people who can open the calendar at all.
    const holders = await apiGet(salesToken, '/users/lookup?holding=gops.calendar.view_all');
    const holderIds = new Set((Array.isArray(holders.body) ? (holders.body as { id: string }[]) : []).map((p) => p.id));
    check(
      '?holding=gops.calendar.view_all offers the sales user and not the bystander',
      holders.status === 200 && holderIds.has(sales.id) && !holderIds.has(bystander.id),
      String(holders.status),
    );

    // The notification deep link (?activity=<id>) opens through GET /activities/:id.
    const one = await apiGet(salesToken, `/activities/${first.id}`);
    const oneBody = one.body as { id?: string; startsAt?: string; assignedTo?: { id: string } };
    check(
      'GET /activities/:id returns the one activity the deep link names, with its assignee',
      one.status === 200 && oneBody.id === first.id && oneBody.assignedTo?.id === sales.id &&
        new Date(String(oneBody.startsAt)).getTime() === first.startsAt.getTime(),
      String(one.status),
    );
    const oneDenied = await apiGet(bystanderToken, `/activities/${first.id}`);
    check('GET /activities/:id is behind the same permission', oneDenied.status === 403, String(oneDenied.status));
    const missing = await apiGet(salesToken, '/activities/does-not-exist');
    check('an activity that is gone is a 404, which the page reports rather than hanging', missing.status === 404, String(missing.status));

    // ══ Starts and Ends, invitees, reminders ════════════════════════════════
    console.log('\nStarts and Ends, invitees, reminders');
    const colleague = await makeUser(`${TAG} Colleague`, 'colleague@verifycal.local', [role.id]);
    // Far ahead, so the reminder run below touches nothing real.
    const startsAt = new Date('2031-03-03T01:00:00Z');
    const endsAt = new Date('2031-03-03T02:30:00Z');
    const created = await apiSend(salesToken, 'POST', '/activities', {
      type: 'SITE_VISIT',
      subject: `${TAG} plant walk-through`,
      location: 'Cebu',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      inviteeIds: [colleague.id],
      reminderMinutes: 60,
    });
    const actId = String(created.body.id ?? '');
    check(
      'an activity is booked with Starts and Ends; the duration is derived and the end comes back',
      created.status === 201 && created.body.durationMinutes === 90 && new Date(String(created.body.endsAt)).getTime() === endsAt.getTime(),
      `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`,
    );
    const backwards = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} backwards`,
      startsAt: endsAt.toISOString(),
      endsAt: startsAt.toISOString(),
    });
    const oddReminder = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} odd reminder`,
      startsAt: startsAt.toISOString(),
      reminderMinutes: 30,
    });
    const outsider = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} outsider`,
      startsAt: startsAt.toISOString(),
      inviteeIds: [bystander.id],
    });
    check(
      'Ends before Starts, a reminder not on the list, and an invitee who cannot open the calendar are each refused',
      backwards.status === 400 && oddReminder.status === 400 && outsider.status === 400,
      `${backwards.status} ${oddReminder.status} ${outsider.status}`,
    );
    const invited = await prisma.notification.findFirst({ where: { userId: colleague.id, title: `Invited: ${TAG} plant walk-through` } });
    check(
      "the invitee is told on save, with a link to the activity's page",
      !!invited && invited.link === `/g-ops/calendar/activities/${actId}`,
      JSON.stringify(invited),
    );
    const theirs = await apiGet(salesToken, `/activities?from=2031-03-02T00:00:00Z&to=2031-03-04T00:00:00Z&assignedToId=${colleague.id}`);
    const theirRow = (Array.isArray(theirs.body) ? (theirs.body as { id: string; invitees: { userId: string }[] }[]) : []).find((a) => a.id === actId);
    check(
      "it is on the invitee's calendar, naming who is invited",
      !!theirRow && theirRow.invitees.some((i) => i.userId === colleague.id),
      String(theirs.status),
    );
    const day = await scheduleFor((await resolveUser(colleague.id))!, {
      from: new Date('2031-03-02T16:00:00Z'),
      to: new Date('2031-03-03T16:00:00Z'),
    });
    const row = day.find((r) => r.id === actId);
    check('and in their My Work for that day, saying whose it is', !!row && (row.sub ?? '').includes(`with ${sales.name}`), JSON.stringify(row));

    // ══ Going / Maybe / Not going / No reply (2026-10-08) ═══════════════════
    console.log('\nInvitee responses');
    const colleagueToken = signToken(colleague.id, colleague.email);
    const notInvited = await apiSend(salesToken, 'POST', `/activities/${actId}/respond`, { response: 'ACCEPTED' });
    check('only an invitee answers — whoever booked it has nothing to answer (403)', notInvited.status === 403, String(notInvited.status));
    const going = await apiSend(colleagueToken, 'POST', `/activities/${actId}/respond`, { response: 'ACCEPTED' });
    const goingRow = (going.body.invitees as { userId: string; response: string; respondedAt: string | null }[] | undefined)?.find((i) => i.userId === colleague.id);
    const tally = going.body.responses as { going: number; notGoing: number; maybe: number; noReply: number } | undefined;
    check(
      'an invitee says Going: the answer and its time are kept, and the activity tallies it',
      going.status === 200 && goingRow?.response === 'ACCEPTED' && !!goingRow.respondedAt && tally?.going === 1 && tally.noReply === 0,
      `${going.status} ${JSON.stringify(tally)}`,
    );
    const toldGoing = await prisma.notification.findFirst({
      where: { userId: sales.id, type: 'activity.responded', title: `${colleague.name} is going: ${TAG} plant walk-through` },
    });
    check("and whoever booked it is told, with a link to the activity's page", !!toldGoing && toldGoing.link === `/g-ops/calendar/activities/${actId}`, JSON.stringify(toldGoing));
    check('their My Work row says what they answered', ((await scheduleFor((await resolveUser(colleague.id))!, { from: new Date('2031-03-02T16:00:00Z'), to: new Date('2031-03-03T16:00:00Z') })).find((r) => r.id === actId)?.sub ?? '').includes('(invited, going)'));
    const declined = await apiSend(colleagueToken, 'POST', `/activities/${actId}/respond`, { response: 'DECLINED' });
    const afterDecline = (declined.body.responses as { going: number; notGoing: number } | undefined) ?? { going: -1, notGoing: -1 };
    check('changing the answer moves the tally', declined.status === 200 && afterDecline.going === 0 && afterDecline.notGoing === 1, JSON.stringify(afterDecline));
    const badAnswer = await apiSend(colleagueToken, 'POST', `/activities/${actId}/respond`, { response: 'PENDING' });
    check('"No reply" is not an answer anyone gives (400)', badAnswer.status === 400, String(badAnswer.status));
    const readBack = (await apiGet(salesToken, `/activities/${actId}`)).body as {
      invitees?: { userId: string; response: string; user?: { photoPath?: string | null } }[];
      responses?: { notGoing: number };
      googleCalendarUrl?: string | null;
    };
    check(
      'the activity reads back with every answer and the tally',
      readBack.invitees?.find((i) => i.userId === colleague.id)?.response === 'DECLINED' && readBack.responses?.notGoing === 1,
      JSON.stringify(readBack.responses),
    );
    // The page's "Open in Google Calendar ↗" (SCORO's event page): the hand-off
    // from shared/calendar-links, with the people on it as guests and the
    // activity's own page in the details.
    const google = readBack.googleCalendarUrl ?? '';
    check(
      "a planned activity's read carries the Google Calendar hand-off naming its page and the people on it",
      google.startsWith('https://calendar.google.com/calendar/render?') &&
        google.includes(encodeURIComponent(`/g-ops/calendar/activities/${actId}`)) &&
        decodeURIComponent(google).includes(colleague.email) &&
        readBack.invitees?.every((i) => i.user && 'photoPath' in i.user) === true,
      google.slice(0, 120),
    );
    const doneAct = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} already done`,
      startsAt: startsAt.toISOString(),
      inviteeIds: [colleague.id],
      status: 'DONE',
    });
    const lateAnswer = await apiSend(colleagueToken, 'POST', `/activities/${doneAct.body.id}/respond`, { response: 'ACCEPTED' });
    check('an activity that is done or cancelled takes no more answers (409)', lateAnswer.status === 409, String(lateAnswer.status));
    const mail = activityEmailText({ title: 'Invited: x', body: 'when' }, 'https://app/g-ops/calendar/activities/1', true);
    const oldMail = activityEmailText({ title: 'Invited: x', body: 'when' }, 'https://app/g-ops/calendar?activity=1&date=2031-03-03', true);
    check(
      'the invitation email carries Going / Not going / Maybe links that answer on opening',
      mail.includes('Going: https://app/g-ops/calendar/activities/1?respond=ACCEPTED') &&
        mail.includes('Not going: https://app/g-ops/calendar/activities/1?respond=DECLINED') &&
        mail.includes('Maybe: https://app/g-ops/calendar/activities/1?respond=TENTATIVE') &&
        oldMail.includes('Going: https://app/g-ops/calendar?activity=1&date=2031-03-03&respond=ACCEPTED') &&
        !activityEmailText({ title: 'Moved: x', body: 'when' }, 'https://app/x').includes('respond='),
    );

    // ══ SCORO's New event dialog (2026-10-08) ═══════════════════════════════
    console.log('\nNew event dialog: all day, private, call link, links, repeats');
    const badCall = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} bad call`,
      startsAt: startsAt.toISOString(),
      callLink: 'javascript:alert(1)',
    });
    const contactAlone = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} contact alone`,
      startsAt: startsAt.toISOString(),
      contactId: 'no-such-contact',
    });
    const badJob = await apiSend(salesToken, 'POST', '/activities', { subject: `${TAG} bad job`, startsAt: startsAt.toISOString(), jobId: 'no-such-job' });
    check(
      'a call link that is not http(s), a contact person without their customer, and a project that does not exist are each refused (400)',
      badCall.status === 400 && contactAlone.status === 400 && badJob.status === 400,
      `${badCall.status} ${contactAlone.status} ${badJob.status}`,
    );
    // 11:30 Manila on 10 March; an all-day booking snaps to that day's Manila midnight.
    const wholeDay = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} all day`,
      allDay: true,
      startsAt: '2031-03-10T03:30:00Z',
      durationMinutes: 1440,
      isPrivate: true,
      callLink: 'https://meet.google.com/abc-defg-hij',
      notes: 'the quiet part',
      inviteeIds: [colleague.id],
    });
    check(
      'an all-day activity snaps to the Manila midnight of its day, runs the day, and keeps its call link',
      wholeDay.status === 201 &&
        wholeDay.body.allDay === true &&
        wholeDay.body.startsAt === '2031-03-09T16:00:00.000Z' &&
        wholeDay.body.durationMinutes === 1440 &&
        wholeDay.body.callLink === 'https://meet.google.com/abc-defg-hij' &&
        (wholeDay.body.createdBy as { id: string } | null)?.id === sales.id,
      `${wholeDay.status} ${JSON.stringify(wholeDay.body).slice(0, 220)}`,
    );
    const halfDay = await apiSend(salesToken, 'POST', '/activities', { subject: `${TAG} half day`, allDay: true, startsAt: '2031-03-10T03:30:00Z', durationMinutes: 600 });
    check('an all-day activity runs whole days or is refused (400)', halfDay.status === 400, String(halfDay.status));
    const privId = String(wholeDay.body.id);
    const stranger = await makeUser(`${TAG} Stranger`, 'stranger@verifycal.local', [role.id]);
    const strangerToken = signToken(stranger.id, stranger.email);
    const seenByStranger = (await apiGet(strangerToken, `/activities/${privId}`)).body as {
      subject?: string;
      notes?: string | null;
      callLink?: string | null;
      masked?: boolean;
      invitees?: unknown[];
      googleCalendarUrl?: string | null;
    };
    const listedToStranger = (
      (await apiGet(strangerToken, '/activities?from=2031-03-09T00:00:00Z&to=2031-03-11T00:00:00Z')).body as { id: string; subject: string; masked?: boolean }[]
    ).find((a) => a.id === privId);
    check(
      'a private activity reads as "Busy" to someone not on it — no notes, call link, invitees or Google hand-off — on the page and on the calendar',
      seenByStranger.masked === true &&
        seenByStranger.subject === 'Busy' &&
        seenByStranger.notes === null &&
        seenByStranger.callLink === null &&
        seenByStranger.invitees?.length === 0 &&
        seenByStranger.googleCalendarUrl === null &&
        listedToStranger?.subject === 'Busy' &&
        listedToStranger.masked === true,
      JSON.stringify(seenByStranger).slice(0, 220),
    );
    const seenByInvitee = (await apiGet(colleagueToken, `/activities/${privId}`)).body as { subject?: string; notes?: string | null; masked?: boolean };
    check(
      'while an invitee sees it whole',
      seenByInvitee.subject === `${TAG} all day` && seenByInvitee.notes === 'the quiet part' && !seenByInvitee.masked,
      JSON.stringify(seenByInvitee).slice(0, 120),
    );
    const strangerEdit = await apiSend(strangerToken, 'PATCH', `/activities/${privId}`, { subject: `${TAG} hijacked` });
    const strangerDel = await apiSend(strangerToken, 'DELETE', `/activities/${privId}`, undefined);
    check('and only the people on it may change or remove it (403)', strangerEdit.status === 403 && strangerDel.status === 403, `${strangerEdit.status} ${strangerDel.status}`);

    const weekly = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} weekly call`,
      startsAt: '2031-03-03T01:00:00Z',
      durationMinutes: 30,
      inviteeIds: [colleague.id],
      repeat: { every: 'WEEK', until: '2031-03-24' },
    });
    const seriesId = String(weekly.body.id);
    const series = await prisma.salesActivity.findMany({
      where: { seriesId },
      orderBy: { startsAt: 'asc' },
      select: { id: true, startsAt: true, invitees: { select: { userId: true } } },
    });
    check(
      'a weekly booking until the 24th makes four occurrences a week apart, each an activity of its own carrying the series and the invitees',
      weekly.status === 201 &&
        weekly.body.occurrences === 4 &&
        series.length === 4 &&
        series.every((r, i) => r.startsAt.getTime() === new Date('2031-03-03T01:00:00Z').getTime() + i * 7 * 86_400_000 && r.invitees.length === 1),
      `${weekly.status} ${String(weekly.body.occurrences)} ${series.length}`,
    );
    const invitedToSeries = await prisma.notification.findMany({ where: { userId: colleague.id, title: `Invited: ${TAG} weekly call` } });
    check(
      'the invitee is told once for the whole series, and told how it repeats',
      invitedToSeries.length === 1 && invitedToSeries[0].body.includes('repeats weekly until') && invitedToSeries[0].body.includes('(4 times)'),
      JSON.stringify(invitedToSeries.map((n) => n.body)),
    );
    const tooMany = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} daily forever`,
      startsAt: '2031-03-03T01:00:00Z',
      repeat: { every: 'DAY', until: '2031-06-30' },
    });
    check(
      'more than 60 occurrences is refused before anything is written (400)',
      tooMany.status === 400 && (await prisma.salesActivity.count({ where: { subject: `${TAG} daily forever` } })) === 0,
      String(tooMany.status),
    );
    const monthly = repeatOccurrences(new Date('2031-01-31T01:00:00Z'), 'MONTH', '2031-04-30').map((d) => d.toISOString().slice(0, 10));
    check(
      'a monthly booking on the 31st falls on 28 February and is back on 31 March (pure, Manila wall clock)',
      monthly.join(' ') === '2031-01-31 2031-02-28 2031-03-31 2031-04-30',
      monthly.join(' '),
    );
    const removedUpcoming = await apiSend(salesToken, 'DELETE', `/activities/${series[1].id}?series=upcoming`, undefined);
    check(
      'removing "this and later ones" takes the occurrence and every later planned one, and leaves the earlier',
      removedUpcoming.status === 200 && removedUpcoming.body.removed === 3 && (await prisma.salesActivity.count({ where: { seriesId } })) === 1,
      `${removedUpcoming.status} ${String(removedUpcoming.body.removed)}`,
    );

    // ══ Activity types as data (2026-10-08) ═══════════════════════════════
    console.log('\nActivity types');
    const typesPublic = await apiGet(salesToken, '/reference/activity-types?active=true');
    const typeRows = Array.isArray(typesPublic.body) ? (typesPublic.body as { id: string; key: string; name: string; isSystem: boolean }[]) : [];
    check(
      'anyone signed in reads the types, and the six built-ins are there under the enum’s own keys',
      typesPublic.status === 200 && ['CALL', 'SITE_VISIT', 'MEETING', 'FOLLOW_UP', 'SUBMISSION', 'OTHER'].every((k) => typeRows.some((t) => t.key === k && t.isSystem)),
      `${typesPublic.status} ${typeRows.map((t) => t.key).join()}`,
    );
    const typeDenied = await apiSend(salesToken, 'POST', '/reference/activity-types', { name: `${TAG} demo walk` });
    check('adding one needs admin.categories.create (403)', typeDenied.status === 403, String(typeDenied.status));
    const adminRole = await makeRole('zzcal_admin', `${TAG} admin`, [
      'admin.categories.create',
      'admin.categories.edit_all',
      'admin.categories.delete',
      'ghr.settings.view_all',
      'ghr.settings.edit_all',
    ]);
    const admin = await makeUser(`${TAG} Admin`, 'admin@verifycal.local', [adminRole.id]);
    const adminToken = signToken(admin.id, admin.email);
    const madeType = await apiSend(adminToken, 'POST', '/reference/activity-types', { name: `${TAG} Demo walk`, color: '#2E9A4B' });
    check('an administrator adds a type; its key is derived from the name and fixed', madeType.status === 201 && madeType.body.key === `${TAG}_DEMO_WALK`, `${madeType.status} ${String(madeType.body.key)}`);
    const typed = await apiSend(salesToken, 'POST', '/activities', { type: `${TAG}_DEMO_WALK`, subject: `${TAG} walk the plant`, startsAt: startsAt.toISOString() });
    check(
      'an activity takes the new type and reads back with its name',
      typed.status === 201 && typed.body.type === `${TAG}_DEMO_WALK` && typed.body.typeName === `${TAG} Demo walk`,
      `${typed.status} ${String(typed.body.type)} ${String(typed.body.typeName)}`,
    );
    const stored = await prisma.salesActivity.findUnique({ where: { id: String(typed.body.id) } });
    check('the enum column reads OTHER for a custom type, with the key kept beside it', stored?.type === 'OTHER' && stored.typeKey === `${TAG}_DEMO_WALK`, `${stored?.type} ${stored?.typeKey}`);
    const unknownType = await apiSend(salesToken, 'POST', '/activities', { type: 'NOT_A_TYPE', subject: `${TAG} x`, startsAt: startsAt.toISOString() });
    check('an unknown type is a 400', unknownType.status === 400, String(unknownType.status));
    const inUseDelete = await apiSend(adminToken, 'DELETE', `/reference/activity-types/${madeType.body.id}`, {});
    check('a type in use cannot be deleted', inUseDelete.status === 400, String(inUseDelete.status));
    const renamed = await apiSend(adminToken, 'PATCH', `/reference/activity-types/${madeType.body.id}`, { name: `${TAG} Plant walk`, isActive: false });
    const afterRename = (await apiGet(salesToken, `/activities/${typed.body.id}`)).body as { type: string; typeName: string };
    check(
      'renaming and deactivating a type keeps the activity on it, under the new name',
      renamed.status === 200 && afterRename.type === `${TAG}_DEMO_WALK` && afterRename.typeName === `${TAG} Plant walk`,
      JSON.stringify(afterRename),
    );
    const stale = await apiSend(salesToken, 'POST', '/activities', { type: `${TAG}_DEMO_WALK`, subject: `${TAG} stale`, startsAt: startsAt.toISOString() });
    check('but a deactivated type is not offered to a new activity (400)', stale.status === 400, String(stale.status));
    const keepType = await apiSend(salesToken, 'PATCH', `/activities/${typed.body.id}`, { subject: `${TAG} walk the plant again`, type: `${TAG}_DEMO_WALK` });
    check('while the activity that has it may keep it on edit', keepType.status === 200, String(keepType.status));
    const other = typeRows.find((t) => t.key === 'OTHER');
    const sysDelete = await apiSend(adminToken, 'DELETE', `/reference/activity-types/${other?.id ?? ''}`, {});
    const otherOff = await apiSend(adminToken, 'PATCH', `/reference/activity-types/${other?.id ?? ''}`, { isActive: false });
    check('a built-in type is never deleted, and Other never deactivated', sysDelete.status === 400 && otherOff.status === 400, `${sysDelete.status} ${otherOff.status}`);
    // The seed's backfill: an activity written with the enum alone gets its key, once.
    await prisma.salesActivity.update({ where: { id: first.id }, data: { typeKey: null, type: 'CALL' } });
    const seeded = await seedActivityTypes();
    const backfilled = await prisma.salesActivity.findUnique({ where: { id: first.id } });
    check(
      'the seed gives an activity written before the list its key, and adds no second set of built-ins',
      seeded.created === 0 && seeded.backfilled >= 1 && backfilled?.typeKey === 'CALL',
      JSON.stringify(seeded),
    );

    // ══ Birthdays, anniversaries and the greetings, over HTTP ═══════════════
    console.log('\nCelebrations and greetings');
    const todayKey = manilaDayKey(new Date());
    const mmdd = todayKey.slice(5);
    const birthYear = mmdd === '02-29' ? 1992 : 1990;
    const hireYear = mmdd === '02-29' ? 2020 : 2021;
    const thisYear = Number(todayKey.slice(0, 4));
    const celebrant = await prisma.employee.create({
      data: {
        employeeNo: `${TAG}-E1`,
        firstName: TAG,
        lastName: 'Celebrant',
        userId: colleague.id,
        birthDate: new Date(`${birthYear}-${mmdd}T00:00:00Z`),
        dateHired: new Date(`${hireYear}-${mmdd}T00:00:00Z`),
      },
    });
    const feed = await apiGet(salesToken, `/employees/celebrations?from=${todayKey}&to=${todayKey}`);
    const feedRows = ((feed.body as { celebrations?: { kind: string; employeeId: string; years: number; name: string }[] }).celebrations ?? []).filter(
      (c) => c.employeeId === celebrant.id,
    );
    check(
      'GET /employees/celebrations lists today’s birthday and anniversary with the age and the years, for anyone signed in',
      feed.status === 200 &&
        feedRows.some((c) => c.kind === 'BIRTHDAY' && c.years === thisYear - birthYear) &&
        feedRows.some((c) => c.kind === 'ANNIVERSARY' && c.years === thisYear - hireYear) &&
        feedRows[0]?.name === `${TAG} Celebrant`,
      `${feed.status} ${JSON.stringify(feedRows)}`,
    );
    check(
      'the window is checked',
      (await apiGet(salesToken, '/employees/celebrations?from=2026-13-01')).status === 400 &&
        (await apiGet(salesToken, '/employees/celebrations?from=2026-01-01&to=2027-06-01')).status === 400,
    );
    const myDay = await scheduleFor((await resolveUser(sales.id))!, {
      from: new Date(`${todayKey}T00:00:00+08:00`),
      to: new Date(`${todayKey}T23:59:59.999+08:00`),
    });
    const myCelebrations = myDay.filter((r) => r.kind === 'celebration' && r.id.endsWith(`:${celebrant.id}:${todayKey}`));
    check('and My Work’s Today lists them as all-day rows', myCelebrations.length === 2 && myCelebrations.every((r) => r.startsAt.getTime() === r.endsAt.getTime()), JSON.stringify(myCelebrations));

    // The greetings: from the configured hour, once per person per year, never twice.
    const beforeRules = (await apiGet(adminToken, '/hr-settings')).body as { greetings: Record<string, unknown> };
    const put = await apiSend(adminToken, 'PUT', '/hr-settings', { greetings: { birthdayTitle: `${TAG} Maligayang kaarawan, {first}!` } });
    const afterRules = (await apiGet(adminToken, '/hr-settings')).body as { greetings: { birthdayTitle: string; hour: number; everyoneAnniversary: string } };
    check(
      'HR Settings takes one greeting template at a time and keeps the rest',
      put.status === 200 &&
        afterRules.greetings.birthdayTitle === `${TAG} Maligayang kaarawan, {first}!` &&
        afterRules.greetings.hour === beforeRules.greetings.hour &&
        afterRules.greetings.everyoneAnniversary === beforeRules.greetings.everyoneAnniversary,
      JSON.stringify(afterRules.greetings),
    );
    // The run below reads the defaults, whatever an administrator has set here.
    await apiSend(adminToken, 'PUT', '/hr-settings', { greetings: { ...GREETING_DEFAULTS } });
    await prisma.greeting.deleteMany({ where: { employeeId: celebrant.id } });
    const tooEarly = await sendDueGreetings(new Date(`${todayKey}T05:30:00+08:00`));
    const went = await sendDueGreetings(new Date(`${todayKey}T09:00:00+08:00`));
    const again = await sendDueGreetings(new Date(`${todayKey}T09:01:00+08:00`));
    const mine = await prisma.notification.findMany({ where: { userId: colleague.id, type: 'greeting' }, select: { title: true, body: true } });
    // The default line: "It's ZZCAL Celebrant's birthday today — ZZCAL turns 36".
    const office = await prisma.notification.findFirst({ where: { userId: sales.id, type: 'greeting', title: { contains: `${TAG} turns` } } });
    check('greetings wait for the hour, go once, and never twice', tooEarly === 0 && went >= 2 && again === 0, `${tooEarly} ${went} ${again}`);
    check(
      'the celebrant gets a happy birthday and a work anniversary by name',
      mine.some((n) => n.title === `Happy birthday, ${TAG}!`) && mine.some((n) => n.title.startsWith('Happy work anniversary') && n.title.includes(`${thisYear - hireYear} years`)),
      JSON.stringify(mine),
    );
    check('and everyone else is told who to greet, with the age', !!office && office.title.includes(`turns ${thisYear - birthYear}`), office?.title);
    await apiSend(adminToken, 'PUT', '/hr-settings', { greetings: beforeRules.greetings });

    const early = await sendDueReminders(new Date('2031-03-02T23:00:00Z'));
    const due = await sendDueReminders(new Date('2031-03-03T00:30:00Z'));
    const twice = await sendDueReminders(new Date('2031-03-03T00:31:00Z'));
    const reminded = await prisma.notification.findMany({ where: { title: `Reminder: ${TAG} plant walk-through` }, select: { userId: true } });
    check(
      'the reminder goes once, when it is due, to the assignee and every invitee',
      early === 0 && due >= 1 && twice === 0 && reminded.length === 2 &&
        reminded.some((n) => n.userId === sales.id) && reminded.some((n) => n.userId === colleague.id),
      `${early} ${due} ${twice} ${JSON.stringify(reminded)}`,
    );
    const moved = await apiSend(salesToken, 'PATCH', `/activities/${actId}`, {
      startsAt: new Date('2031-03-04T01:00:00Z').toISOString(),
      endsAt: new Date('2031-03-04T03:00:00Z').toISOString(),
    });
    const afterMove = await prisma.salesActivity.findUnique({ where: { id: actId } });
    const toldMoved = await prisma.notification.findFirst({ where: { userId: colleague.id, title: `Moved: ${TAG} plant walk-through` } });
    check(
      'moving it re-arms the reminder and tells the invitee where it went',
      moved.status === 200 && afterMove?.reminderSentAt === null && afterMove?.durationMinutes === 120 && !!toldMoved,
      `${moved.status} ${afterMove?.reminderSentAt} ${afterMove?.durationMinutes}`,
    );
    const uninvite = await apiSend(salesToken, 'PATCH', `/activities/${actId}`, { inviteeIds: [] });
    const left = await prisma.salesActivityInvitee.count({ where: { activityId: actId } });
    check('an invitee can be taken off again', uninvite.status === 200 && left === 0, `${uninvite.status} ${left}`);
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
