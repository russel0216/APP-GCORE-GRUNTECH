import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  badRequest,
  forbidden,
  conflict,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can } from '../permissions/resolve';
import { env } from '../env';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { registerAttachmentGuard } from '../shared/attachments';
import { notify, type NotifyInput } from '../shared/notifications';
import { registerSearch } from '../shared/search';
import { registerSchedule } from './workspace';
import {
  buildIcs,
  googleCalendarUrl,
  parseGoogleLink,
  timeWindow,
} from '../shared/calendar-links';
import {
  MEETING_LINK,
  visibleWhere,
  participantWhere,
  assertCanEdit,
  meetingToCalendarEvent,
  meetingCalendarInput,
  isLive,
  whenWhere,
} from '../shared/meetings';

/**
 * Meetings — G-HR › My day (item 11).
 *
 * No workflow, no PDF, no money. G-Core holds no Google credentials: the
 * organiser creates the event in their own calendar from the hand-off link
 * this API builds, and pastes the Meet link back. In-app invitations go out
 * on "Send invitations", not on every save, so a meeting can be drafted and
 * corrected before anybody hears about it.
 */

export const meetingRoutes = Router();

// Minutes and decks are seen by whoever can see the meeting.
registerAttachmentGuard('meeting', async (user, id) =>
  (await prisma.meeting.count({ where: { id, ...visibleWhere(user) } })) > 0,
);
meetingRoutes.use(authenticate);

const VIEW = ['ghr.meetings.view_own', 'ghr.meetings.view_all'];
const MAX_CALENDAR_DAYS = 62;

const person = { select: { id: true, name: true, email: true, position: true } };

const detailSelect = {
  id: true,
  number: true,
  title: true,
  agenda: true,
  location: true,
  startsAt: true,
  endsAt: true,
  status: true,
  organizerId: true,
  organizer: person,
  meetLink: true,
  calendarEventUrl: true,
  icsSequence: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
  invitees: {
    select: {
      id: true,
      userId: true,
      required: true,
      response: true,
      respondedAt: true,
      notifiedAt: true,
      user: person,
    },
    orderBy: [{ required: 'desc' }, { user: { name: 'asc' } }],
  },
} satisfies Prisma.MeetingSelect;

type MeetingDetail = Prisma.MeetingGetPayload<{ select: typeof detailSelect }>;

async function loadVisible(id: string, user: Parameters<typeof visibleWhere>[0]): Promise<MeetingDetail> {
  const meeting = await prisma.meeting.findFirst({
    where: { id, ...visibleWhere(user) },
    select: detailSelect,
  });
  if (!meeting) throw notFound('Meeting not found');
  return meeting;
}

/** The record as the page reads it: the row plus what the viewer may do. */
function present(m: MeetingDetail, viewerId: string, canEdit: boolean) {
  const mine = m.invitees.find((i) => i.userId === viewerId) ?? null;
  const unsent = m.invitees.filter((i) => !i.notifiedAt).length;
  const guests = m.invitees.map((i) => ({ email: i.user.email }));
  return {
    ...m,
    canEdit,
    live: isLive(m),
    myResponse: mine?.response ?? null,
    isOrganizer: m.organizerId === viewerId,
    unsentInvitations: unsent,
    // The hand-off exists for the organiser while there is no link yet —
    // once one is pasted the event already exists in their calendar.
    googleCalendarUrl:
      canEdit && !m.meetLink && m.status === 'PLANNED'
        ? googleCalendarUrl(meetingCalendarInput(m), guests, env.appUrl)
        : null,
  };
}

const inviteeIds = z.array(z.string().min(1)).max(200).default([]);

const meetingSchema = z.object({
  title: z.string().trim().min(3, 'Give the meeting a title').max(200),
  agenda: z.string().trim().max(5000).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  startsAt: z.string().min(1, 'When does it start?'),
  endsAt: z.string().min(1, 'When does it end?'),
  inviteeIds: inviteeIds.optional(),
  optionalIds: inviteeIds.optional(),
  /** A Meet link, a bare room code or a Calendar event link. */
  googleUrl: z.string().trim().max(2000).nullable().optional(),
});

/** Active users among the ids named, minus the organiser — silently. */
async function invitableUsers(ids: string[], organizerId: string): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => id !== organizerId);
  if (!unique.length) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: unique }, isActive: true },
    select: { id: true },
  });
  if (rows.length !== unique.length) {
    throw badRequest('One of the people named is not an active user');
  }
  return unique;
}

// ── Calendar ────────────────────────────────────────────────────────────────

/**
 * Rows for a date window, in the month-grid shape. Capped at 62 days: a
 * calendar asks for a month with its padding, and a window wider than that
 * is a report, which has its own screen.
 */
meetingRoutes.get(
  '/calendar',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const from = new Date(String(req.query.from ?? ''));
    const to = new Date(String(req.query.to ?? ''));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw badRequest('from and to must be timestamps');
    }
    if (to <= from) throw badRequest('to must be after from');
    if (to.getTime() - from.getTime() > MAX_CALENDAR_DAYS * 86_400_000) {
      throw badRequest(`A calendar window is at most ${MAX_CALENDAR_DAYS} days`);
    }
    const rows = await prisma.meeting.findMany({
      where: { ...visibleWhere(me), startsAt: { gte: from, lt: to } },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        number: true,
        title: true,
        agenda: true,
        location: true,
        startsAt: true,
        endsAt: true,
        status: true,
        icsSequence: true,
        meetLink: true,
        organizer: { select: { id: true, name: true } },
      },
    });
    res.json(rows.map((m) => meetingToCalendarEvent(m, me.id)));
  }),
);

// ── List ────────────────────────────────────────────────────────────────────

meetingRoutes.get(
  '/',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const f = q.filters;

    const and: Prisma.MeetingWhereInput[] = [visibleWhere(me), whenWhere(f.when)];
    if (q.scope === 'mine') and.push({ organizerId: me.id });
    if (f.status && ['PLANNED', 'DONE', 'CANCELLED'].includes(f.status)) {
      and.push({ status: f.status as 'PLANNED' | 'DONE' | 'CANCELLED' });
    }
    if (f.role === 'organizer') and.push({ organizerId: me.id });
    if (f.role === 'invited') and.push({ invitees: { some: { userId: me.id } } });
    if (f.organizerId) and.push({ organizerId: f.organizerId });
    if (q.search) {
      and.push({
        OR: [
          { title: { contains: q.search, mode: 'insensitive' } },
          { number: { contains: q.search, mode: 'insensitive' } },
          { agenda: { contains: q.search, mode: 'insensitive' } },
          { location: { contains: q.search, mode: 'insensitive' } },
          { organizer: { name: { contains: q.search, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.MeetingWhereInput = { AND: and };

    // Upcoming reads soonest-first; everything else newest-first, like every
    // other list. The default sort therefore depends on the preset.
    const fallback: Record<string, 'asc' | 'desc'> =
      f.when === 'upcoming' || f.when === 'today' ? { startsAt: 'asc' } : { startsAt: 'desc' };

    const [rows, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        orderBy: orderBy(q, ['startsAt', 'number', 'title', 'status'], fallback),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          number: true,
          title: true,
          location: true,
          startsAt: true,
          endsAt: true,
          status: true,
          meetLink: true,
          organizer: { select: { id: true, name: true } },
          invitees: { select: { userId: true, response: true, notifiedAt: true } },
        },
      }),
      prisma.meeting.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map(({ invitees, ...m }) => ({
          ...m,
          inviteeCount: invitees.length,
          acceptedCount: invitees.filter((i) => i.response === 'ACCEPTED').length,
          sent: invitees.some((i) => i.notifiedAt !== null),
          myResponse: invitees.find((i) => i.userId === me.id)?.response ?? null,
          isOrganizer: m.organizer.id === me.id,
        })),
        total,
        q,
      ),
    );
  }),
);

// ── One ─────────────────────────────────────────────────────────────────────

meetingRoutes.get(
  '/:id',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const m = await loadVisible(req.params.id, me);
    const canEdit =
      m.status !== 'CANCELLED' &&
      (can(me, 'ghr.meetings.edit_all') || (m.organizerId === me.id && can(me, 'ghr.meetings.edit_own')));
    res.json(present(m, me.id, canEdit));
  }),
);

/**
 * The `.ics` — one VEVENT any calendar imports. An invitee downloads their
 * own invitation, so visibility is the only gate; the export is audited
 * because it is one, and a file that left the system unlogged is a file
 * nobody can account for.
 */
meetingRoutes.get(
  '/:id/ics',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const m = await loadVisible(req.params.id, me);
    const ics = buildIcs(
      meetingCalendarInput(m),
      { name: m.organizer.name, email: m.organizer.email },
      m.invitees.map((i) => ({ name: i.user.name, email: i.user.email, required: i.required })),
      env.appUrl,
    );
    await audit(
      { entityType: 'meeting', entityId: m.id, action: 'EXPORTED', summary: `${m.number} downloaded as .ics` },
      req,
    );
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${m.number}.ics"`);
    res.send(ics);
  }),
);

// ── Create ──────────────────────────────────────────────────────────────────

meetingRoutes.post(
  '/',
  require_('ghr.meetings.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(meetingSchema, req.body);
    const slot = timeWindow(body.startsAt, body.endsAt);
    const link = parseGoogleLink(body.googleUrl);

    const required = await invitableUsers(body.inviteeIds ?? [], me.id);
    const optional = (await invitableUsers(body.optionalIds ?? [], me.id)).filter(
      (id) => !required.includes(id),
    );

    const meeting = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('meeting', tx);
      return tx.meeting.create({
        data: {
          number,
          title: body.title,
          agenda: body.agenda || null,
          location: body.location || null,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          organizerId: me.id,
          meetLink: link.meetLink,
          calendarEventUrl: link.calendarEventUrl,
          invitees: {
            create: [
              ...required.map((userId) => ({ userId, required: true })),
              ...optional.map((userId) => ({ userId, required: false })),
            ],
          },
        },
        select: detailSelect,
      });
    });

    await audit(
      {
        entityType: 'meeting',
        entityId: meeting.id,
        action: 'CREATED',
        summary: `${meeting.number} ${meeting.title} — ${meeting.invitees.length} invited`,
        after: { title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt },
      },
      req,
    );
    res.status(201).json(present(meeting, me.id, true));
  }),
);

// ── Edit ────────────────────────────────────────────────────────────────────

const patchSchema = meetingSchema
  .omit({ inviteeIds: true, optionalIds: true })
  .partial()
  .extend({
    /** Sending an empty string clears both links. */
    googleUrl: z.string().trim().max(2000).nullable().optional(),
  });

/**
 * A time change bumps the RFC 5545 SEQUENCE and tells everyone who has
 * already been invited; nobody who has not yet heard of the meeting is told
 * it moved. Pasting a link only sets the link — it is not a change to the
 * meeting, so it neither bumps the sequence nor notifies.
 */
meetingRoutes.patch(
  '/:id',
  requireAny('ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(patchSchema, req.body);

    const data: Prisma.MeetingUpdateInput = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.agenda !== undefined) data.agenda = body.agenda || null;
    if (body.location !== undefined) data.location = body.location || null;

    let timeChanged = false;
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      const slot = timeWindow(body.startsAt ?? before.startsAt, body.endsAt ?? before.endsAt);
      timeChanged =
        slot.startsAt.getTime() !== before.startsAt.getTime() ||
        slot.endsAt.getTime() !== before.endsAt.getTime();
      if (timeChanged) {
        if (before.status === 'DONE') throw conflict('A meeting that has taken place cannot be moved');
        data.startsAt = slot.startsAt;
        data.endsAt = slot.endsAt;
        data.icsSequence = { increment: 1 };
      }
    }

    if (body.googleUrl !== undefined) {
      const link = parseGoogleLink(body.googleUrl);
      data.meetLink = link.meetLink;
      // A Meet link replaces a Calendar link and vice versa — but a Meet
      // link pasted after a Calendar link keeps the event link, since both
      // describe the same event.
      data.calendarEventUrl = link.calendarEventUrl ?? (link.meetLink ? before.calendarEventUrl : null);
    }

    if (!Object.keys(data).length) {
      res.json(present(before, me.id, true));
      return;
    }

    const meeting = await prisma.meeting.update({
      where: { id: before.id },
      data,
      select: detailSelect,
    });

    const changed = Object.keys(data).filter((k) => k !== 'icsSequence');
    await audit(
      {
        entityType: 'meeting',
        entityId: meeting.id,
        action: 'UPDATED',
        summary: `${meeting.number}: ${changed.join(', ')} changed`,
        before: { title: before.title, startsAt: before.startsAt, endsAt: before.endsAt, location: before.location },
        after: { title: meeting.title, startsAt: meeting.startsAt, endsAt: meeting.endsAt, location: meeting.location },
      },
      req,
    );

    if (timeChanged) {
      const told = meeting.invitees.filter((i) => i.notifiedAt !== null);
      await notify(
        told.map((i) => ({
          userId: i.userId,
          type: 'meeting.updated' as const,
          title: `Moved: ${meeting.title}`,
          body: `${meeting.number} now ${whenText(meeting.startsAt, meeting.endsAt)}`,
          link: MEETING_LINK(meeting.id),
        })),
      );
    }

    res.json(present(meeting, me.id, true));
  }),
);

// ── Invitees ────────────────────────────────────────────────────────────────

const addInviteesSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(200),
  required: z.boolean().default(true),
});

/** Adds people as UNSENT — the organiser presses Send when the list is right. */
meetingRoutes.post(
  '/:id/invitees',
  requireAny('ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(addInviteesSchema, req.body);
    const ids = await invitableUsers(body.userIds, before.organizerId);
    const already = new Set(before.invitees.map((i) => i.userId));
    const fresh = ids.filter((id) => !already.has(id));
    if (fresh.length) {
      await prisma.meetingInvitee.createMany({
        data: fresh.map((userId) => ({ meetingId: before.id, userId, required: body.required })),
        skipDuplicates: true,
      });
      await audit(
        {
          entityType: 'meeting',
          entityId: before.id,
          action: 'UPDATED',
          summary: `${before.number}: ${fresh.length} invitee(s) added`,
        },
        req,
      );
    }
    const meeting = await loadVisible(before.id, me);
    res.json(present(meeting, me.id, true));
  }),
);

/** Removing somebody who was already told is a change they need to hear. */
meetingRoutes.delete(
  '/:id/invitees/:userId',
  requireAny('ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const gone = before.invitees.find((i) => i.userId === req.params.userId);
    if (!gone) throw notFound('That person is not invited');
    await prisma.meetingInvitee.delete({ where: { id: gone.id } });
    await audit(
      {
        entityType: 'meeting',
        entityId: before.id,
        action: 'UPDATED',
        summary: `${before.number}: ${gone.user.name} removed`,
      },
      req,
    );
    if (gone.notifiedAt) {
      await notify({
        userId: gone.userId,
        type: 'meeting.updated',
        title: `No longer needed: ${before.title}`,
        body: `${before.number} — you were taken off the invitation`,
        link: MEETING_LINK(before.id),
      });
    }
    const meeting = await loadVisible(before.id, me);
    res.json(present(meeting, me.id, true));
  }),
);

// ── Send ────────────────────────────────────────────────────────────────────

/**
 * The in-app invitation, to everyone who has not had one. Sending twice
 * reaches only the people added since — the first batch is not nagged.
 */
meetingRoutes.post(
  '/:id/send',
  requireAny('ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    if (before.status !== 'PLANNED') throw conflict('Only a planned meeting can send invitations');
    const pending = before.invitees.filter((i) => !i.notifiedAt);
    if (!pending.length) {
      res.json({ ...present(before, me.id, true), sent: 0 });
      return;
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.meetingInvitee.updateMany({
        where: { id: { in: pending.map((i) => i.id) } },
        data: { notifiedAt: now },
      });
      await notify(
        pending.map(
          (i): NotifyInput => ({
            userId: i.userId,
            type: 'meeting.invited',
            title: `Invitation: ${before.title}`,
            body: `${before.number} · ${whenText(before.startsAt, before.endsAt)} · from ${before.organizer.name}`,
            link: MEETING_LINK(before.id),
          }),
        ),
        tx,
      );
      await audit(
        {
          entityType: 'meeting',
          entityId: before.id,
          action: 'SUBMITTED',
          summary: `${before.number}: invitations sent to ${pending.length}`,
        },
        req,
        tx,
      );
    });
    const meeting = await loadVisible(before.id, me);
    res.json({ ...present(meeting, me.id, true), sent: pending.length });
  }),
);

// ── Respond ─────────────────────────────────────────────────────────────────

const respondSchema = z.object({
  response: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED']),
});

/** Only the invitee answers for themselves; the organiser is not on the list. */
meetingRoutes.post(
  '/:id/respond',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const meeting = await loadVisible(req.params.id, me);
    const body = parseBody(respondSchema, req.body);
    const mine = meeting.invitees.find((i) => i.userId === me.id);
    if (!mine) throw forbidden('You are not on the invitation, so there is nothing to answer');
    if (meeting.status !== 'PLANNED') throw conflict('This meeting is no longer open for responses');

    await prisma.meetingInvitee.update({
      where: { id: mine.id },
      data: { response: body.response, respondedAt: new Date() },
    });
    await audit(
      {
        entityType: 'meeting',
        entityId: meeting.id,
        action: 'UPDATED',
        summary: `${meeting.number}: ${me.name} ${body.response.toLowerCase()}`,
      },
      req,
    );
    // The organiser hears about a no; a yes is what they assumed.
    if (body.response === 'DECLINED' && mine.response !== 'DECLINED') {
      await notify({
        userId: meeting.organizerId,
        type: 'meeting.updated',
        title: `${me.name} declined: ${meeting.title}`,
        body: meeting.number,
        link: MEETING_LINK(meeting.id),
      });
    }
    const after = await loadVisible(meeting.id, me);
    res.json(present(after, me.id, false));
  }),
);

// ── Cancel ──────────────────────────────────────────────────────────────────

const cancelSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it is off').max(500),
});

/**
 * Cancelling keeps the record and tells everyone who was invited. The
 * sequence is bumped so a re-downloaded .ics carries METHOD:CANCEL against
 * the same UID and withdraws the event from their calendars.
 */
meetingRoutes.post(
  '/:id/cancel',
  requireAny('ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const before = await loadVisible(req.params.id, me);
    assertCanEdit(me, before);
    const body = parseBody(cancelSchema, req.body);

    const meeting = await prisma.meeting.update({
      where: { id: before.id },
      data: { status: 'CANCELLED', cancelReason: body.reason, icsSequence: { increment: 1 } },
      select: detailSelect,
    });
    await audit(
      {
        entityType: 'meeting',
        entityId: meeting.id,
        action: 'CANCELLED',
        summary: `${meeting.number}: ${body.reason}`,
      },
      req,
    );
    const told = meeting.invitees.filter((i) => i.notifiedAt !== null);
    await notify(
      told.map((i) => ({
        userId: i.userId,
        type: 'meeting.cancelled' as const,
        title: `Cancelled: ${meeting.title}`,
        body: `${meeting.number} — ${body.reason}`,
        link: MEETING_LINK(meeting.id),
      })),
    );
    res.json(present(meeting, me.id, false));
  }),
);

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Only a draft nobody has heard of can vanish. Once invitations went out the
 * record is what those people were told, and cancelling is the honest way
 * to take it back.
 */
meetingRoutes.delete(
  '/:id',
  requireAny('ghr.meetings.delete', 'ghr.meetings.edit_own', 'ghr.meetings.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const meeting = await loadVisible(req.params.id, me);
    if (!can(me, 'ghr.meetings.delete') && !can(me, 'ghr.meetings.edit_all') && meeting.organizerId !== me.id) {
      throw forbidden('Only the organiser can delete this meeting');
    }
    if (meeting.invitees.some((i) => i.notifiedAt !== null)) {
      throw conflict('Invitations have gone out — cancel the meeting instead, so everyone is told');
    }
    await prisma.meeting.delete({ where: { id: meeting.id } });
    await audit(
      { entityType: 'meeting', entityId: meeting.id, action: 'DELETED', summary: `${meeting.number} ${meeting.title}` },
      req,
    );
    res.status(204).end();
  }),
);

// ── Helpers ─────────────────────────────────────────────────────────────────

const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });

/** "Sep 28, 09:00 AM – 10:00 AM" — the notification's one line about when. */
function whenText(startsAt: Date, endsAt: Date): string {
  return `${dateTimeFmt.format(startsAt)} – ${timeOnly.format(endsAt)}`;
}

// ── Global search (Ctrl+K) ──────────────────────────────────────────────────

registerSearch({
  kind: 'meeting',
  label: 'Meetings',
  permission: ['ghr.meetings.view_all', 'ghr.meetings.view_own'],
  ownWhere: (user) => participantWhere(user.id) as Record<string, unknown>,
  search: async (term, _user, limit, own) => {
    const rows = await prisma.meeting.findMany({
      where: {
        AND: [
          (own ?? {}) as Prisma.MeetingWhereInput,
          {
            OR: [
              { title: { contains: term, mode: 'insensitive' } },
              { number: { contains: term, mode: 'insensitive' } },
              { location: { contains: term, mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: { startsAt: 'desc' },
      take: limit,
      select: { id: true, number: true, title: true, startsAt: true, status: true },
    });
    return rows.map((r) => ({
      kind: 'meeting',
      id: r.id,
      title: r.title,
      subtitle: [r.number, dateTimeFmt.format(r.startsAt), r.status === 'CANCELLED' ? 'cancelled' : null]
        .filter(Boolean)
        .join(' · '),
      link: MEETING_LINK(r.id),
    }));
  },
});

// ── Today's schedule (My Work) ──────────────────────────────────────────────

/**
 * PLANNED meetings I organise or am invited to, inside the window My Work
 * asks for. A declined invitation stays off the day: the person said no.
 */
registerSchedule(async (user, window) => {
  const rows = await prisma.meeting.findMany({
    where: {
      status: 'PLANNED',
      startsAt: { gte: window.from, lt: window.to },
      OR: [
        { organizerId: user.id },
        { invitees: { some: { userId: user.id, response: { not: 'DECLINED' } } } },
      ],
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      meetLink: true,
      location: true,
      organizer: { select: { id: true, name: true } },
    },
  });
  return rows.map((m) => ({
    kind: 'meeting',
    id: m.id,
    title: m.title,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    link: MEETING_LINK(m.id),
    meetLink: m.meetLink,
    sub: m.organizer.id === user.id ? 'You organise' : `${m.organizer.name}${m.location ? ` · ${m.location}` : ''}`,
  }));
});
