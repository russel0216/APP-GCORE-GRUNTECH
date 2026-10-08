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
import { activityEmailText, activityWhere, sendDueReminders } from '../src/shared/activities';
import { resolveUser } from '../src/permissions/resolve';
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
      'the invitee is told on save, with a link to the activity on its day',
      !!invited && invited.link === `/g-ops/calendar?activity=${actId}&date=2031-03-03`,
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
    check('and whoever booked it is told, with a link to the activity', !!toldGoing && toldGoing.link === `/g-ops/calendar?activity=${actId}&date=2031-03-03`, JSON.stringify(toldGoing));
    check('their My Work row says what they answered', ((await scheduleFor((await resolveUser(colleague.id))!, { from: new Date('2031-03-02T16:00:00Z'), to: new Date('2031-03-03T16:00:00Z') })).find((r) => r.id === actId)?.sub ?? '').includes('(invited, going)'));
    const declined = await apiSend(colleagueToken, 'POST', `/activities/${actId}/respond`, { response: 'DECLINED' });
    const afterDecline = (declined.body.responses as { going: number; notGoing: number } | undefined) ?? { going: -1, notGoing: -1 };
    check('changing the answer moves the tally', declined.status === 200 && afterDecline.going === 0 && afterDecline.notGoing === 1, JSON.stringify(afterDecline));
    const badAnswer = await apiSend(colleagueToken, 'POST', `/activities/${actId}/respond`, { response: 'PENDING' });
    check('"No reply" is not an answer anyone gives (400)', badAnswer.status === 400, String(badAnswer.status));
    const readBack = (await apiGet(salesToken, `/activities/${actId}`)).body as { invitees?: { userId: string; response: string }[]; responses?: { notGoing: number } };
    check(
      'the activity reads back with every answer and the tally',
      readBack.invitees?.find((i) => i.userId === colleague.id)?.response === 'DECLINED' && readBack.responses?.notGoing === 1,
      JSON.stringify(readBack.responses),
    );
    const doneAct = await apiSend(salesToken, 'POST', '/activities', {
      subject: `${TAG} already done`,
      startsAt: startsAt.toISOString(),
      inviteeIds: [colleague.id],
      status: 'DONE',
    });
    const lateAnswer = await apiSend(colleagueToken, 'POST', `/activities/${doneAct.body.id}/respond`, { response: 'ACCEPTED' });
    check('an activity that is done or cancelled takes no more answers (409)', lateAnswer.status === 409, String(lateAnswer.status));
    const mail = activityEmailText({ title: 'Invited: x', body: 'when' }, 'https://app/g-ops/calendar?activity=1&date=2031-03-03', true);
    check(
      'the invitation email carries Going / Not going / Maybe links that answer on opening',
      mail.includes('Going: https://app/g-ops/calendar?activity=1&date=2031-03-03&respond=ACCEPTED') &&
        mail.includes('Not going: https://app/g-ops/calendar?activity=1&date=2031-03-03&respond=DECLINED') &&
        !activityEmailText({ title: 'Moved: x', body: 'when' }, 'https://app/x').includes('respond='),
    );

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
