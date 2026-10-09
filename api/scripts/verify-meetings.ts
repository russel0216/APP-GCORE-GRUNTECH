/**
 * Meetings verification — G-HR › My day (item 11).
 *
 *   npx tsx scripts/verify-meetings.ts      (the API must be running)
 *
 * Two kinds of thing are checked. The calendar hand-offs in
 * `shared/calendar-links.ts` are pure and asserted directly: an `.ics` that
 * folds a line one byte too late, or a Google link that turns a Meet room
 * into a typo, fails silently in every calendar it reaches. The rest is the
 * lifecycle over HTTP, because that is where the rules live — who sees a
 * meeting, who can move it, what a time change tells the invitees, and why
 * a sent invitation cannot be deleted.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { globalSearch } from '../src/shared/search';
import { scheduleFor } from '../src/routes/workspace';
import {
  icsStamp,
  icsText,
  icsFold,
  buildIcs,
  googleCalendarUrl,
  parseGoogleLink,
  timeWindow,
} from '../src/shared/calendar-links';
import { visibleWhere, meetingToCalendarEvent, isLive } from '../src/shared/meetings';
// Side-effect import: registers the meeting search and schedule providers.
import '../src/routes/meetings';

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

async function expectRejection(label: string, fn: () => Promise<unknown>, expect: string) {
  try {
    await fn();
    check(label, false, 'it was allowed when it should have been refused');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, message.toLowerCase().includes(expect.toLowerCase()), `got: ${message}`);
  }
}

const TAG = 'ZZMT';
const DOMAIN = '@verifymeetings.local';
const BASE = `http://localhost:${env.port}/api`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.meeting.deleteMany({ where: { title: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.meeting.deleteMany({ where: { organizerId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.userPermissionOverride.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzmt_' } } });
}

/**
 * A role holding exactly the permissions named — the script makes its own
 * rather than borrowing a seeded one, whose membership is the operator's.
 */
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
      position: `${TAG} tester`,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const at = (iso: string) => new Date(iso);

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE Meetings verification\n');
  await cleanup();

  // ══ 1. Timestamps and text escaping ══════════════════════════════════════
  console.log('The .ics primitives');

  check('a stamp is UTC in basic form', icsStamp(at('2026-09-28T01:30:00.000Z')) === '20260928T013000Z');
  check(
    'text escapes backslash, semicolon, comma and newline',
    icsText('a\\b;c,d\ne') === 'a\\\\b\\;c\\,d\\ne',
    icsText('a\\b;c,d\ne'),
  );

  // ══ 2. Line folding ══════════════════════════════════════════════════════
  const long = 'DESCRIPTION:' + 'x'.repeat(100);
  const folded = icsFold(long);
  const foldedLines = folded.split('\r\n');
  check(
    'a 112-character line folds at 75 octets with a leading space',
    foldedLines.length === 2 && foldedLines[0].length === 75 && foldedLines[1].startsWith(' '),
    JSON.stringify(foldedLines.map((l) => l.length)),
  );
  const accented = 'SUMMARY:' + 'é'.repeat(50); // 58 chars, 108 bytes
  const accentedLines = icsFold(accented).split('\r\n');
  check(
    'folding counts bytes, not characters — accents fold sooner',
    accentedLines.length === 2 && Buffer.byteLength(accentedLines[0], 'utf8') <= 75,
    JSON.stringify(accentedLines.map((l) => Buffer.byteLength(l, 'utf8'))),
  );
  check('a short line is not folded', icsFold('BEGIN:VEVENT') === 'BEGIN:VEVENT');

  // ══ 3. The .ics file ═════════════════════════════════════════════════════
  console.log('\nThe .ics file');

  const ev = {
    uid: 'abc123',
    number: 'GT-MTG-2026-0001',
    title: `${TAG} Weekly ops; planning`,
    description: 'Line one\nLine two',
    location: 'Board room',
    startsAt: at('2026-09-28T01:00:00.000Z'),
    endsAt: at('2026-09-28T02:00:00.000Z'),
    sequence: 0,
    cancelled: false,
    url: '/g-hr/meetings/abc123',
  };
  const ana = { name: 'Ana Cruz', email: 'ana@example.com' };
  const attendees = [
    { name: 'Ben Reyes', email: 'ben@example.com' },
    { name: 'Cat Santos', email: 'cat@example.com', required: false },
  ];
  const ics = buildIcs(ev, ana, attendees, 'https://gruntech.gcore.tech');
  const unfold = (s: string) => s.replace(/\r\n /g, '');
  const flat = unfold(ics);
  check('the file is a VCALENDAR with one VEVENT and METHOD:REQUEST',
    flat.startsWith('BEGIN:VCALENDAR') && flat.includes('METHOD:REQUEST') && flat.includes('BEGIN:VEVENT') && flat.endsWith('END:VCALENDAR\r\n'));
  check('the UID is the record id at the app host', flat.includes('UID:abc123@gruntech.gcore.tech'));
  check('SEQUENCE, DTSTART and DTEND are printed', flat.includes('SEQUENCE:0') && flat.includes('DTSTART:20260928T010000Z') && flat.includes('DTEND:20260928T020000Z'));
  check('the summary escapes its semicolon', flat.includes(`SUMMARY:${TAG} Weekly ops\\; planning`));
  check(
    'the description carries the number, the agenda and the deep link',
    flat.includes('DESCRIPTION:GT-MTG-2026-0001\\nLine one\\nLine two\\nhttps://gruntech.gcore.tech/g-hr/meetings/abc123'),
  );
  check('the organiser is named', flat.includes('ORGANIZER;CN=Ana Cruz:mailto:ana@example.com'));
  check(
    'a required attendee is REQ-PARTICIPANT and an optional one OPT-PARTICIPANT',
    flat.includes('ATTENDEE;CN=Ben Reyes;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ben@example.com') &&
      flat.includes('ATTENDEE;CN=Cat Santos;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:cat@example.com'),
  );
  check('every raw line is at most 75 octets', ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75));

  // ══ 4. Cancellation ══════════════════════════════════════════════════════
  const cancelled = unfold(buildIcs({ ...ev, sequence: 2, cancelled: true }, ana, attendees, 'https://gruntech.gcore.tech'));
  check(
    'a cancelled event is METHOD:CANCEL, STATUS:CANCELLED, under the SAME UID with a higher SEQUENCE',
    cancelled.includes('METHOD:CANCEL') && cancelled.includes('STATUS:CANCELLED') && cancelled.includes('UID:abc123@gruntech.gcore.tech') && cancelled.includes('SEQUENCE:2'),
  );

  // ══ 5. The Google Calendar hand-off ══════════════════════════════════════
  console.log('\nThe Google Calendar hand-off');

  const gurl = new URL(googleCalendarUrl(ev, [{ email: 'ben@example.com' }, { email: 'cat@example.com' }], 'https://gruntech.gcore.tech'));
  check('the link opens the create-event template', gurl.host === 'calendar.google.com' && gurl.searchParams.get('action') === 'TEMPLATE');
  check('dates are the UTC pair', gurl.searchParams.get('dates') === '20260928T010000Z/20260928T020000Z');
  check('the time zone is Manila', gurl.searchParams.get('ctz') === 'Asia/Manila');
  check('the invitees become guests', gurl.searchParams.get('add') === 'ben@example.com,cat@example.com');
  check('the location and the deep link travel too',
    gurl.searchParams.get('location') === 'Board room' && (gurl.searchParams.get('details') ?? '').includes('/g-hr/meetings/abc123'));

  // ══ 6. What comes back ═══════════════════════════════════════════════════
  console.log('\nThe pasted link');

  check('a Meet link is kept and normalised', parseGoogleLink('https://meet.google.com/ABC-defg-hij/').meetLink === 'https://meet.google.com/abc-defg-hij');
  check('a bare room code becomes the link', parseGoogleLink('abc-defg-hij').meetLink === 'https://meet.google.com/abc-defg-hij');
  const cal = parseGoogleLink('https://calendar.google.com/calendar/event?eid=XYZ');
  check('a Calendar event link is kept as the event, not as a Meet room', cal.meetLink === null && cal.calendarEventUrl === 'https://calendar.google.com/calendar/event?eid=XYZ');
  check('an empty paste clears both', parseGoogleLink('  ').meetLink === null && parseGoogleLink('').calendarEventUrl === null);
  await expectRejection('a Meet host without a room is refused', async () => parseGoogleLink('https://meet.google.com/landing'), 'not a room');
  await expectRejection('a random website is refused with what to paste', async () => parseGoogleLink('https://example.com/zoom'), 'Paste a Google Meet link');

  // ══ 7. The time slot ═════════════════════════════════════════════════════
  console.log('\nThe time slot');

  check('an hour is 60 minutes', timeWindow('2026-09-28T09:00:00+08:00', '2026-09-28T10:00:00+08:00').minutes === 60);
  await expectRejection('ending before starting is refused', async () => timeWindow('2026-09-28T10:00:00+08:00', '2026-09-28T09:00:00+08:00'), 'ends before it starts');
  await expectRejection('a slot longer than a day is a typo, not a meeting', async () => timeWindow('2026-09-28T09:00:00+08:00', '2026-09-30T09:00:00+08:00'), 'longer than 24 hours');
  await expectRejection('a garbled start is refused', async () => timeWindow('next tuesday', '2026-09-28T09:00:00+08:00'), 'When does it start');

  // ══ The calendar row ═════════════════════════════════════════════════════
  const row = meetingToCalendarEvent(
    {
      id: 'm1', number: 'GT-MTG-2026-0002', title: 'Kick-off', agenda: null, location: null,
      startsAt: at('2026-09-27T23:30:00.000Z'), endsAt: at('2026-09-28T00:30:00.000Z'),
      status: 'PLANNED', icsSequence: 0, meetLink: 'https://meet.google.com/abc-defg-hij',
      organizer: { id: 'u1', name: 'Ana Cruz' },
    },
    'u1',
  );
  check('a chip buckets on the MANILA day — 23:30Z on the 27th is the 28th', row.date === '2026-09-28', row.date);
  check('the chip carries its link, its Meet link and whose it is', row.link === '/g-hr/meetings/m1' && row.meetLink !== null && row.mine && row.detail.includes('Google Meet'));
  check('Join is live from 15 minutes before the start', isLive({ startsAt: at('2026-09-28T01:00:00Z'), endsAt: at('2026-09-28T02:00:00Z'), status: 'PLANNED' }, at('2026-09-28T00:50:00Z')));
  check('and not an hour early', !isLive({ startsAt: at('2026-09-28T01:00:00Z'), endsAt: at('2026-09-28T02:00:00Z'), status: 'PLANNED' }, at('2026-09-28T00:00:00Z')));

  // ══ HTTP ═════════════════════════════════════════════════════════════════
  if (!(await apiReachable())) {
    console.log('\n  ✗ The API is not running — the HTTP cases were NOT checked.');
    console.log(`    Start it (cd api && npm run dev) and run this script again.\n`);
    failed++;
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = 1;
    return;
  }

  console.log('\nThe lifecycle over HTTP');

  const staffRole = await makeRole('zzmt_staff', `${TAG} staff`, [
    'ghr.meetings.view_own', 'ghr.meetings.create', 'ghr.meetings.edit_own',
  ]);
  const viewerRole = await makeRole('zzmt_viewer', `${TAG} viewer`, ['ghr.meetings.view_own']);
  const hrRole = await makeRole('zzmt_hr', `${TAG} hr`, [
    'ghr.meetings.view_own', 'ghr.meetings.view_all', 'ghr.meetings.create', 'ghr.meetings.edit_own',
    'ghr.meetings.edit_all', 'ghr.meetings.delete', 'ghr.meetings.export',
  ]);

  const organizer = await makeUser(`${TAG} Organiser`, `organiser${DOMAIN}`, [staffRole.id]);
  const invitee = await makeUser(`${TAG} Invitee`, `invitee${DOMAIN}`, [staffRole.id]);
  const optional = await makeUser(`${TAG} Optional`, `optional${DOMAIN}`, [viewerRole.id]);
  const bystander = await makeUser(`${TAG} Bystander`, `bystander${DOMAIN}`, [viewerRole.id]);
  const hr = await makeUser(`${TAG} HR`, `hr${DOMAIN}`, [hrRole.id]);
  // A staff member whose create right was taken away by a DENY override.
  const denied = await makeUser(`${TAG} Denied`, `denied${DOMAIN}`, [staffRole.id]);
  const createPerm = await prisma.permission.findUniqueOrThrow({ where: { key: 'ghr.meetings.create' } });
  await prisma.userPermissionOverride.create({ data: { userId: denied.id, permissionId: createPerm.id, effect: 'DENY' } });

  const tok = {
    organizer: signToken(organizer.id, organizer.email),
    invitee: signToken(invitee.id, invitee.email),
    optional: signToken(optional.id, optional.email),
    bystander: signToken(bystander.id, bystander.email),
    hr: signToken(hr.id, hr.email),
  };

  // Tomorrow at 09:00 local, for an hour.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow.getTime() + 3_600_000);

  // ══ 8. Create ════════════════════════════════════════════════════════════
  const created = await api(tok.organizer, 'POST', '/meetings', {
    title: `${TAG} Weekly operations`,
    agenda: 'Open items',
    location: 'Board room',
    startsAt: tomorrow.toISOString(),
    endsAt: tomorrowEnd.toISOString(),
    inviteeIds: [invitee.id, organizer.id],
    optionalIds: [optional.id],
  });
  const meetingId = String(created.body.id ?? '');
  check('a meeting is created and numbered GT-MTG-YYYY-NNNN', created.status === 201 && /^GT-MTG-\d{4}-\d{4}$/.test(String(created.body.number)), `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  const invitees = (created.body.invitees ?? []) as { userId: string; required: boolean; notifiedAt: string | null }[];
  check('the organiser is never their own invitee', invitees.length === 2 && !invitees.some((i) => i.userId === organizer.id));
  check('an optional invitee is marked so, and nobody has been told yet',
    invitees.find((i) => i.userId === optional.id)?.required === false && invitees.every((i) => i.notifiedAt === null));
  check('the organiser gets the Google Calendar hand-off while there is no link', typeof created.body.googleCalendarUrl === 'string' && String(created.body.googleCalendarUrl).includes('calendar.google.com'));

  const noCreate = await api(tok.bystander, 'POST', '/meetings', {
    title: `${TAG} not allowed`, startsAt: tomorrow.toISOString(), endsAt: tomorrowEnd.toISOString(),
  });
  check('a person without create cannot raise one', noCreate.status === 403, String(noCreate.status));

  const backwards = await api(tok.organizer, 'POST', '/meetings', {
    title: `${TAG} backwards`, startsAt: tomorrowEnd.toISOString(), endsAt: tomorrow.toISOString(),
  });
  check('a meeting that ends before it starts is refused at the route', backwards.status === 400, String(backwards.status));

  // ══ 9. Visibility ════════════════════════════════════════════════════════
  const asInvitee = await api(tok.invitee, 'GET', `/meetings/${meetingId}`);
  const asBystander = await api(tok.bystander, 'GET', `/meetings/${meetingId}`);
  const asHr = await api(tok.hr, 'GET', `/meetings/${meetingId}`);
  check('an invitee opens the meeting', asInvitee.status === 200 && asInvitee.body.myResponse === 'PENDING', String(asInvitee.status));
  check('a bystander with view_own does not learn it exists (404, not 403)', asBystander.status === 404, String(asBystander.status));
  check('view_all opens every meeting', asHr.status === 200 && asHr.body.canEdit === true, String(asHr.status));
  check('the invitee cannot edit it', asInvitee.body.canEdit === false);

  const visInv = visibleWhere((await resolveUser(invitee.id))!);
  const visHr = visibleWhere((await resolveUser(hr.id))!);
  check('visibleWhere narrows a view_own holder and not a view_all one', 'OR' in visInv && Object.keys(visHr).length === 0);

  // ══ 10. The list ═════════════════════════════════════════════════════════
  const upcoming = await api(tok.invitee, 'GET', '/meetings?when=upcoming&pageSize=200');
  const rows = (upcoming.body.rows ?? []) as { id: string; isOrganizer: boolean; myResponse: string | null }[];
  check('the invitee sees it under upcoming, marked as not theirs', rows.some((r) => r.id === meetingId && !r.isOrganizer && r.myResponse === 'PENDING'), `${upcoming.status} ${rows.length}`);
  const organised = await api(tok.invitee, 'GET', '/meetings?role=organizer&pageSize=200');
  check('role=organizer hides what they were merely invited to', !((organised.body.rows ?? []) as { id: string }[]).some((r) => r.id === meetingId));
  const past = await api(tok.invitee, 'GET', '/meetings?when=past&pageSize=200');
  check('a meeting tomorrow is not in the past', !((past.body.rows ?? []) as { id: string }[]).some((r) => r.id === meetingId));
  const none = await api(tok.bystander, 'GET', '/meetings?pageSize=200');
  check('the bystander\'s list does not carry it', none.status === 200 && !((none.body.rows ?? []) as { id: string }[]).some((r) => r.id === meetingId));

  // ══ 11. Send, then move ══════════════════════════════════════════════════
  const byInvitee = await api(tok.invitee, 'POST', `/meetings/${meetingId}/send`);
  check('only the organiser sends invitations', byInvitee.status === 403, String(byInvitee.status));

  const moveBefore = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, {
    startsAt: new Date(tomorrow.getTime() + 1_800_000).toISOString(),
    endsAt: new Date(tomorrowEnd.getTime() + 1_800_000).toISOString(),
  });
  const updatedBeforeSend = await prisma.notification.count({ where: { userId: invitee.id, type: 'meeting.updated' } });
  check('moving an UNSENT meeting bumps the sequence but tells nobody', moveBefore.status === 200 && moveBefore.body.icsSequence === 1 && updatedBeforeSend === 0, `${moveBefore.status} seq=${moveBefore.body.icsSequence} told=${updatedBeforeSend}`);

  const sent = await api(tok.organizer, 'POST', `/meetings/${meetingId}/send`);
  const invitedNotes = await prisma.notification.findMany({ where: { type: 'meeting.invited', userId: { in: [invitee.id, optional.id] } } });
  check('Send invitations reaches both invitees with a link to the record', sent.status === 200 && sent.body.sent === 2 && invitedNotes.length === 2 && invitedNotes.every((n) => n.link === `/g-hr/meetings/${meetingId}`), `${sent.status} sent=${sent.body.sent} notes=${invitedNotes.length}`);
  const again = await api(tok.organizer, 'POST', `/meetings/${meetingId}/send`);
  check('sending again nags nobody', again.body.sent === 0);

  const moved = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, {
    startsAt: new Date(tomorrow.getTime() + 3_600_000).toISOString(),
    endsAt: new Date(tomorrowEnd.getTime() + 3_600_000).toISOString(),
  });
  const updatedNotes = await prisma.notification.count({ where: { type: 'meeting.updated', userId: { in: [invitee.id, optional.id] } } });
  check('moving a SENT meeting bumps the sequence again and tells everyone invited', moved.status === 200 && moved.body.icsSequence === 2 && updatedNotes === 2, `seq=${moved.body.icsSequence} told=${updatedNotes}`);

  const retitled = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { title: `${TAG} Weekly operations (rev)` });
  const updatedAfterTitle = await prisma.notification.count({ where: { type: 'meeting.updated', userId: { in: [invitee.id, optional.id] } } });
  check('retitling is not a move — no sequence bump, no notification', retitled.body.icsSequence === 2 && updatedAfterTitle === 2);

  // ══ 12. The pasted link ══════════════════════════════════════════════════
  const badLink = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { googleUrl: 'https://zoom.us/j/123' });
  check('a non-Google link is refused with what to paste', badLink.status === 400 && String(badLink.body.error).includes('Paste a Google Meet link'), `${badLink.status} ${badLink.body.error}`);
  const code = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { googleUrl: 'ABC-defg-hij' });
  check('a bare room code becomes the Meet link, and the hand-off goes away', code.body.meetLink === 'https://meet.google.com/abc-defg-hij' && code.body.googleCalendarUrl === null, JSON.stringify(code.body.meetLink));
  const inviteeLink = await api(tok.invitee, 'PATCH', `/meetings/${meetingId}`, { googleUrl: 'abc-defg-hij' });
  check('an invitee cannot change the link', inviteeLink.status === 403, String(inviteeLink.status));
  const cleared = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { googleUrl: '' });
  check('an empty paste clears the link', cleared.body.meetLink === null);
  await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { googleUrl: 'https://meet.google.com/abc-defg-hij' });

  // ══ 13. Responding ═══════════════════════════════════════════════════════
  const accepted = await api(tok.invitee, 'POST', `/meetings/${meetingId}/respond`, { response: 'ACCEPTED' });
  check('an invitee accepts', accepted.status === 200 && accepted.body.myResponse === 'ACCEPTED', `${accepted.status}`);
  const notInvited = await api(tok.hr, 'POST', `/meetings/${meetingId}/respond`, { response: 'ACCEPTED' });
  check('somebody who can see it but is not invited has nothing to answer', notInvited.status === 403, String(notInvited.status));
  const declined = await api(tok.optional, 'POST', `/meetings/${meetingId}/respond`, { response: 'DECLINED' });
  const declineNote = await prisma.notification.count({ where: { userId: organizer.id, type: 'meeting.updated' } });
  check('a decline reaches the organiser; an accept did not', declined.status === 200 && declineNote === 1, `${declined.status} notes=${declineNote}`);
  const listed = await api(tok.organizer, 'GET', `/meetings?when=upcoming&pageSize=200`);
  const mine = ((listed.body.rows ?? []) as { id: string; acceptedCount: number; inviteeCount: number }[]).find((r) => r.id === meetingId);
  check('the list counts the acceptances', mine?.acceptedCount === 1 && mine.inviteeCount === 2, JSON.stringify(mine));

  // ══ 14. The .ics over HTTP ═══════════════════════════════════════════════
  const icsRes = await api(tok.invitee, 'GET', `/meetings/${meetingId}/ics`);
  check('an invitee downloads the .ics as text/calendar', icsRes.status === 200 && (icsRes.headers.get('content-type') ?? '').startsWith('text/calendar') && (icsRes.headers.get('content-disposition') ?? '').includes('.ics'), `${icsRes.status} ${icsRes.headers.get('content-type')}`);
  const icsFlat = unfold(icsRes.text);
  check('the file carries the current SEQUENCE and the Meet link in its description',
    icsFlat.includes('SEQUENCE:2') && icsFlat.includes(`UID:${meetingId}@`) && icsFlat.includes('meet.google.com/abc-defg-hij') && icsFlat.includes('ATTENDEE;CN=ZZMT Invitee'), icsFlat.slice(0, 200));
  const exported = await prisma.auditLog.count({ where: { entityType: 'meeting', entityId: meetingId, action: 'EXPORTED', actorId: invitee.id } });
  check('the download is audited as EXPORTED by the person who took it', exported === 1, String(exported));
  const icsDenied = await api(tok.bystander, 'GET', `/meetings/${meetingId}/ics`);
  check('a bystander gets no file', icsDenied.status === 404, String(icsDenied.status));

  // ══ 15. The people picker's lookup ═══════════════════════════════════════
  console.log('\nThe people lookup');

  const lookup = await fetch(`${BASE}/users/lookup?q=${TAG}`, { headers: { Authorization: `Bearer ${tok.bystander}` } });
  const lookupRows = (await lookup.json()) as Record<string, unknown>[];
  check('a bystander without create can still look people up — it is a lookup, not admin', lookup.status === 200 && lookupRows.length >= 5, `${lookup.status} ${lookupRows.length}`);
  // Six since 2026-10-08: the photo (an attachment id) for pickers that show faces.
  check('no row carries a password hash or anything but the six fields',
    lookupRows.every((r) => !('passwordHash' in r) && Object.keys(r).every((k) => ['id', 'name', 'email', 'position', 'department', 'photoPath'].includes(k))));
  const holding = await fetch(`${BASE}/users/lookup?q=${TAG}&holding=ghr.meetings.create`, { headers: { Authorization: `Bearer ${tok.bystander}` } });
  const holders = ((await holding.json()) as { id: string }[]).map((r) => r.id);
  check('holding= keeps the organiser and drops the DENY-overridden colleague and the viewer',
    holders.includes(organizer.id) && !holders.includes(denied.id) && !holders.includes(bystander.id), JSON.stringify(holders.length));

  // ══ 16. Cancel and delete ════════════════════════════════════════════════
  console.log('\nCancel and delete');

  const delSent = await api(tok.organizer, 'DELETE', `/meetings/${meetingId}`);
  check('a meeting whose invitations went out cannot be deleted (409)', delSent.status === 409, String(delSent.status));
  const delHr = await api(tok.hr, 'DELETE', `/meetings/${meetingId}`);
  check('not even by somebody holding delete', delHr.status === 409, String(delHr.status));

  const noReason = await api(tok.organizer, 'POST', `/meetings/${meetingId}/cancel`, { reason: '' });
  check('cancelling needs a reason', noReason.status === 400, String(noReason.status));
  const cancelledRes = await api(tok.organizer, 'POST', `/meetings/${meetingId}/cancel`, { reason: `${TAG} client moved the date` });
  const cancelNotes = await prisma.notification.count({ where: { type: 'meeting.cancelled', userId: { in: [invitee.id, optional.id] } } });
  check('cancelling marks it CANCELLED, bumps the sequence and tells everyone who was invited',
    cancelledRes.status === 200 && cancelledRes.body.status === 'CANCELLED' && cancelledRes.body.icsSequence === 3 && cancelNotes === 2, `${cancelledRes.status} ${cancelledRes.body.status} seq=${cancelledRes.body.icsSequence} told=${cancelNotes}`);
  const cancelIcs = await api(tok.invitee, 'GET', `/meetings/${meetingId}/ics`);
  check('the .ics of a cancelled meeting is METHOD:CANCEL under the same UID', unfold(cancelIcs.text).includes('METHOD:CANCEL') && unfold(cancelIcs.text).includes(`UID:${meetingId}@`));
  const afterCancel = await api(tok.organizer, 'PATCH', `/meetings/${meetingId}`, { title: `${TAG} back on` });
  check('a cancelled meeting refuses every change', afterCancel.status === 409, String(afterCancel.status));
  const lateRespond = await api(tok.invitee, 'POST', `/meetings/${meetingId}/respond`, { response: 'ACCEPTED' });
  check('and every response', lateRespond.status === 409, String(lateRespond.status));

  const draft = await api(tok.organizer, 'POST', '/meetings', {
    title: `${TAG} draft nobody heard of`, startsAt: tomorrow.toISOString(), endsAt: tomorrowEnd.toISOString(), inviteeIds: [invitee.id],
  });
  const draftId = String(draft.body.id);
  const delByInvitee = await api(tok.invitee, 'DELETE', `/meetings/${draftId}`);
  check('an invitee cannot delete a draft', delByInvitee.status === 403, String(delByInvitee.status));
  const delDraft = await api(tok.organizer, 'DELETE', `/meetings/${draftId}`);
  const draftGone = await prisma.meeting.findUnique({ where: { id: draftId } });
  check('the organiser deletes an unsent draft', delDraft.status === 204 && draftGone === null, String(delDraft.status));

  // ══ Search, the calendar and today's schedule ════════════════════════════
  console.log('\nSearch, calendar and My Work');

  // A meeting later today — on the schedule, and findable.
  const soon = new Date(Date.now() + 2 * 3_600_000);
  const soonEnd = new Date(soon.getTime() + 1_800_000);
  const todays = await api(tok.organizer, 'POST', '/meetings', {
    title: `${TAG} Toolbox talk`, startsAt: soon.toISOString(), endsAt: soonEnd.toISOString(), inviteeIds: [invitee.id, optional.id],
  });
  const todaysId = String(todays.body.id);
  await api(tok.organizer, 'POST', `/meetings/${todaysId}/send`);
  await api(tok.optional, 'POST', `/meetings/${todaysId}/respond`, { response: 'DECLINED' });

  const inviteeUser = (await resolveUser(invitee.id))!;
  const hitsInvitee = await globalSearch('Toolbox', inviteeUser);
  const hitsBystander = await globalSearch('Toolbox', (await resolveUser(bystander.id))!);
  check('Ctrl+K finds the meeting for an invitee', hitsInvitee.some((h) => h.kind === 'meeting' && h.id === todaysId && h.link === `/g-hr/meetings/${todaysId}`), JSON.stringify(hitsInvitee.map((h) => h.kind)));
  check('and not for a bystander holding only view_own', !hitsBystander.some((h) => h.id === todaysId));

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const spansMidnight = soon.getDate() !== dayStart.getDate();
  const sched = await scheduleFor(inviteeUser, { from: dayStart, to: dayEnd });
  const schedOpt = await scheduleFor((await resolveUser(optional.id))!, { from: dayStart, to: dayEnd });
  if (spansMidnight) {
    console.log('  · it is after 22:00 — the "today" meeting falls tomorrow, so the schedule cases use a wider window');
  }
  const windowEnd = spansMidnight ? new Date(dayEnd.getTime() + 86_400_000) : dayEnd;
  const schedWide = spansMidnight ? await scheduleFor(inviteeUser, { from: dayStart, to: windowEnd }) : sched;
  check('the schedule provider lists it for the invitee with kind meeting and its link', schedWide.some((s) => s.kind === 'meeting' && s.id === todaysId && s.link === `/g-hr/meetings/${todaysId}`), JSON.stringify(schedWide.map((s) => s.title)));
  const schedOptWide = spansMidnight ? await scheduleFor((await resolveUser(optional.id))!, { from: dayStart, to: windowEnd }) : schedOpt;
  check('a declined invitation stays off the day', !schedOptWide.some((s) => s.id === todaysId));
  if (!spansMidnight) {
    const myWork = await api(tok.invitee, 'GET', '/my-work');
    const today = (myWork.body.todaysSchedule ?? []) as { kind: string; id: string; meetLink: string | null }[];
    check('GET /my-work.todaysSchedule carries it', myWork.status === 200 && today.some((s) => s.kind === 'meeting' && s.id === todaysId), JSON.stringify(today.length));
  }

  const calFrom = dayStart.toISOString();
  const calTo = new Date(dayStart.getTime() + 40 * 86_400_000).toISOString();
  const calendar = await api(tok.invitee, 'GET', `/meetings/calendar?from=${calFrom}&to=${calTo}`);
  const calRows = (Array.isArray(calendar.body) ? calendar.body : []) as { id: string; date: string; label: string; link: string }[];
  check('the calendar window returns chips keyed by Manila day', calendar.status === 200 && calRows.some((r) => r.id === todaysId && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.link === `/g-hr/meetings/${todaysId}`), `${calendar.status} ${calRows.length}`);
  const tooWide = await api(tok.invitee, 'GET', `/meetings/calendar?from=${calFrom}&to=${new Date(dayStart.getTime() + 70 * 86_400_000).toISOString()}`);
  check('a window over 62 days is refused', tooWide.status === 400, String(tooWide.status));

  const audits = await prisma.auditLog.findMany({ where: { entityType: 'meeting', entityId: meetingId }, select: { action: true } });
  const actions = new Set(audits.map((a) => a.action));
  check('the meeting\'s audit trail runs CREATED → UPDATED → SUBMITTED → EXPORTED → CANCELLED',
    ['CREATED', 'UPDATED', 'SUBMITTED', 'EXPORTED', 'CANCELLED'].every((a) => actions.has(a)), [...actions].join(','));

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
