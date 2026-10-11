import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { Prisma, HelpTicketKind, HelpTicketStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden, HttpError } from '../http/kit';
import { authenticate, requireAny, currentUser } from '../auth/middleware';
import { can, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify, type NotificationType } from '../shared/notifications';
import { mailConfig, sendMail } from '../shared/mail';
import { renderDocument, formatShortDate } from '../shared/pdf';
import { registerAttachmentGuard, upload, saveAttachment } from '../shared/attachments';
import { throttled } from '../shared/throttle';
import { LIST_CAP, listReference, rangeNamed, filterDay, choice, sendListPdf, recordNamed } from '../shared/listPaper';
import { manilaDayStart, manilaDayEnd } from '../shared/day';

/**
 * The Help box (2026-10-11, the owner's call: "a help chat box so every user
 * can raise a ticket for improvement, allow them to screenshot the problem";
 * "super admins receive the tickets").
 *
 * Anybody signed in raises a ticket — an improvement, something wrong, a
 * question — with the screenshot the box took of the page they were on (or
 * an image of their own), and the page's address, their browser and window
 * size. Every active SUPER ADMIN is told, by bell and by email where SMTP is
 * set. The ticket's thread is the raiser's and the administrators': a reply
 * tells the other side, a change of status tells the raiser, and a reply from
 * the raiser on a closed ticket opens it again — they are saying it is not
 * done. No approval, no money.
 *
 * Rights: raising, reading and answering one's OWN ticket needs nothing but a
 * login (the box is on every page, for everyone). `admin.help_tickets.view_all`
 * reads every ticket (the list, its paper, any ticket and its screenshots);
 * `admin.help_tickets.edit_all` answers them and moves their status. No seeded
 * role holds either: a super admin holds everything.
 */

export const helpTicketRoutes = Router();
helpTicketRoutes.use(authenticate);

const P = {
  viewAll: 'admin.help_tickets.view_all',
  editAll: 'admin.help_tickets.edit_all',
} as const;

const KIND_LABEL: Record<HelpTicketKind, string> = {
  IMPROVEMENT: 'Improvement',
  PROBLEM: 'Something is wrong',
  QUESTION: 'Question',
};
const STATUS_LABEL: Record<HelpTicketStatus, string> = {
  NEW: 'New',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  WONT_DO: 'Won’t do',
};
const CLOSED: HelpTicketStatus[] = ['DONE', 'WONT_DO'];

/** The most files one ticket carries: the screenshot and a few images of the raiser's own. */
export const MAX_TICKET_IMAGES = 5;
/** Tickets one person may raise in an hour — a stuck button pressed twenty times is not twenty tickets. */
export const TICKETS_PER_HOUR = 20;

const linkOf = (id: string) => `/admin/help-tickets/${id}`;

/** Multer wrote these before the route could refuse; a refused upload leaves no stray file. */
function discard(files: Express.Multer.File[]) {
  for (const f of files) {
    try {
      fs.unlinkSync(f.path);
    } catch {
      /* already gone */
    }
  }
}

const mayReadAll = (user: ResolvedUser) => can(user, P.viewAll);
const mayManage = (user: ResolvedUser) => can(user, P.editAll);
const mayOpen = (user: ResolvedUser, row: { createdById: string }) => row.createdById === user.id || mayReadAll(user);

// The screenshot is the raiser's and the administrators', never a colleague's
// — it shows whatever was on their screen. Files come and go with the ticket's
// own routes, never through the generic attachment door.
registerAttachmentGuard(
  'help_ticket',
  async (user, id) => {
    const row = await prisma.helpTicket.findUnique({ where: { id }, select: { createdById: true } });
    return !!row && mayOpen(user, row);
  },
  { write: async () => false },
);

/** Bell each, and an email each where SMTP is set — sent after the save, never allowed to fail it. */
async function tell(
  userIds: (string | null | undefined)[],
  message: { type: NotificationType; title: string; body: string; link: string },
  except: string | null,
) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== except))];
  if (!ids.length) return;
  await notify(ids.map((userId) => ({ userId, ...message })));
  const cfg = mailConfig();
  if (!cfg) return;
  const people = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { email: true, name: true } });
  const url = `${env.appUrl.replace(/\/+$/, '')}${message.link}`;
  for (const p of people) {
    try {
      await sendMail({ to: p.email, toName: p.name, subject: message.title, text: `${message.body}\n\n${url}` }, cfg);
    } catch (err) {
      console.error(`Help ticket email to ${p.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Who hears of a new ticket: every active super admin (the owner's call). */
async function receivers(): Promise<string[]> {
  const rows = await prisma.user.findMany({ where: { isSuperAdmin: true, isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}

const person = { select: { id: true, name: true, email: true, photoPath: true } } as const;
const listInclude = {
  createdBy: person,
  _count: { select: { replies: true } },
} satisfies Prisma.HelpTicketInclude;

type ListRow = Prisma.HelpTicketGetPayload<{ include: typeof listInclude }>;

function presentRow(r: ListRow) {
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    subject: r.subject,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    pagePath: r.pagePath,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    closedAt: r.closedAt,
    replies: r._count.replies,
  };
}

// ── Raising one ─────────────────────────────────────────────────────────────

const createSchema = z.object({
  kind: z.nativeEnum(HelpTicketKind).default('IMPROVEMENT'),
  subject: z.string().trim().min(1, 'Say what it is about').max(200),
  description: z.string().trim().min(1, 'Describe it').max(10000),
  pagePath: z.string().trim().max(500).optional().nullable(),
  viewport: z.string().trim().max(40).optional().nullable(),
});

helpTicketRoutes.post(
  '/',
  upload.array('files', MAX_TICKET_IMAGES),
  handler(async (req, res) => {
    const me = currentUser(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const body = parseBody(createSchema, req.body);
      // A screenshot is a picture: anything else is refused, and nothing is kept.
      const notImage = files.find((f) => !f.mimetype.startsWith('image/'));
      if (notImage) throw badRequest(`${notImage.originalname} is not an image — attach a screenshot or a picture`);
      if (throttled(`help:${me.id}`, TICKETS_PER_HOUR, 60 * 60_000)) {
        throw new HttpError(429, 'That is a lot of tickets in an hour — wait a little, or add to one you raised');
      }
      // Only a path inside the app, never a full address someone pasted.
      const pagePath = body.pagePath && body.pagePath.startsWith('/') ? body.pagePath : null;
      const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
      const ticket = await prisma.$transaction(async (tx) => {
        const number = await nextNumber('help_ticket', tx);
        return tx.helpTicket.create({
          data: {
            number,
            kind: body.kind,
            subject: body.subject,
            description: body.description,
            pagePath,
            userAgent,
            viewport: body.viewport || null,
            createdById: me.id,
          },
        });
      });
      for (const file of files) {
        await saveAttachment({ entityType: 'help_ticket', entityId: ticket.id, file, uploadedById: me.id, caption: 'Screenshot' });
      }
      await audit(
        {
          entityType: 'help_ticket',
          entityId: ticket.id,
          action: 'CREATED',
          summary: `Raised ${ticket.number} (${KIND_LABEL[ticket.kind]}): ${ticket.subject}`,
          after: { kind: ticket.kind, subject: ticket.subject, pagePath, images: files.length },
        },
        req,
      );
      await tell(
        await receivers(),
        {
          type: 'help.ticket',
          title: `${ticket.number}: ${me.name} — ${KIND_LABEL[ticket.kind].toLowerCase()}`,
          body: `${ticket.subject}${pagePath ? ` (on ${pagePath})` : ''}`,
          link: linkOf(ticket.id),
        },
        me.id,
      );
      res.status(201).json({ id: ticket.id, number: ticket.number });
    } catch (err) {
      discard(files);
      throw err;
    }
  }),
);

// ── My tickets (the box's second tab) ───────────────────────────────────────

helpTicketRoutes.get(
  '/mine',
  handler(async (req, res) => {
    const me = currentUser(req);
    const rows = await prisma.helpTicket.findMany({
      where: { createdById: me.id },
      include: listInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rows.map(presentRow));
  }),
);

// ── The register (Admin › Help Tickets) ─────────────────────────────────────

const SORTABLE = ['number', 'createdAt', 'updatedAt', 'status', 'kind'];

/** The one query for the rows, the cards and the paper. */
function ticketListWhere(q: ReturnType<typeof listQuery>) {
  const f = q.filters;
  const status = choice(f.status, HelpTicketStatus, 'Status', (v) => STATUS_LABEL[v]);
  const kind = choice(f.kind, HelpTicketKind, 'Kind', (v) => KIND_LABEL[v]);
  const from = filterDay(f.createdFrom, 'Raised from');
  const to = filterDay(f.createdTo, 'Raised to');
  const ids = idsFilter(f.ids);
  const and: Prisma.HelpTicketWhereInput[] = [];
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { subject: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
        { pagePath: { contains: q.search, mode: 'insensitive' } },
        { createdBy: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  if (ids) and.push({ id: { in: ids } });
  const base: Prisma.HelpTicketWhereInput = and.length ? { AND: and } : {};
  const narrow: Prisma.HelpTicketWhereInput[] = [];
  if (status) narrow.push({ status });
  if (f.open === 'true') narrow.push({ status: { notIn: CLOSED } });
  if (kind) narrow.push({ kind });
  if (f.createdById) narrow.push({ createdById: f.createdById });
  if (from || to) narrow.push({ createdAt: { ...(from ? { gte: manilaDayStart(from) } : {}), ...(to ? { lte: manilaDayEnd(to) } : {}) } });
  return { base, where: narrow.length ? { AND: [base, ...narrow] } : base, status, kind };
}

async function ticketSummary(base: Prisma.HelpTicketWhereInput) {
  const groups = await prisma.helpTicket.groupBy({ by: ['status'], where: base, _count: { _all: true } });
  const by = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<HelpTicketStatus, number>>;
  const n = (s: HelpTicketStatus) => by[s] ?? 0;
  return {
    count: n('NEW') + n('IN_PROGRESS') + n('DONE') + n('WONT_DO'),
    new: n('NEW'),
    inProgress: n('IN_PROGRESS'),
    done: n('DONE'),
    wontDo: n('WONT_DO'),
  };
}

helpTicketRoutes.get(
  '/',
  requireAny(P.viewAll),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { base, where } = ticketListWhere(q);
    const [rows, total, summary] = await Promise.all([
      prisma.helpTicket.findMany({
        where,
        include: listInclude,
        orderBy: orderBy(q, SORTABLE, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.helpTicket.count({ where }),
      ticketSummary(base),
    ]);
    res.json({ ...listResult(rows.map(presentRow), total, q), summary });
  }),
);

// The printed list — above /:id (route order).
helpTicketRoutes.get(
  '/pdf',
  requireAny(P.viewAll),
  handler(async (req, res) => {
    const q = listQuery(req);
    const { where, status, kind } = ticketListWhere(q);
    const [rows, count, open] = await Promise.all([
      prisma.helpTicket.findMany({ where, include: listInclude, orderBy: orderBy(q, SORTABLE, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.helpTicket.count({ where }),
      prisma.helpTicket.count({ where: { AND: [where, { status: { notIn: CLOSED } }] } }),
    ]);
    const f = q.filters;
    const filters = [
      q.search ? `search "${q.search}"` : null,
      status ? `status ${STATUS_LABEL[status]}` : null,
      f.open === 'true' ? 'open' : null,
      kind ? `kind ${KIND_LABEL[kind]}` : null,
      await recordNamed('person', f.createdById, 'raised by'),
      rangeNamed('raised', f.createdFrom, f.createdTo),
      f.ids ? 'the rows selected' : null,
    ];
    const noun = ['help ticket', 'help tickets'] as const;
    const reference = `${listReference(count, rows.length, noun, [])}, ${open.toLocaleString('en-PH')} open${
      filters.filter(Boolean).length ? ` — ${filters.filter(Boolean).join(' · ')}` : ''
    }`;
    const pdf = await renderDocument({
      title: 'Help Tickets',
      date: new Date(),
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Ticket', 'Kind', 'Raised by', 'Raised', 'Replies', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: r.subject, body: r.pagePath ?? undefined },
            KIND_LABEL[r.kind],
            r.createdBy.name,
            formatShortDate(r.createdAt),
            String(r._count.replies),
            STATUS_LABEL[r.status],
          ]),
        },
      ],
      signatories: [],
    });
    await audit(
      { entityType: 'help_ticket', entityId: 'list', action: 'EXPORTED', summary: `Exported the help tickets list as PDF (${listReference(count, rows.length, noun, [])})` },
      req,
    );
    sendListPdf(res, pdf, 'help-tickets.pdf');
  }),
);

// ── One ticket ──────────────────────────────────────────────────────────────

async function load(id: string) {
  const row = await prisma.helpTicket.findUnique({
    where: { id },
    include: {
      createdBy: person,
      replies: { include: { author: person }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!row) throw notFound('Ticket not found');
  return row;
}

helpTicketRoutes.get(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    // Somebody else's ticket is a 404, not a 403: that it exists says nothing to them.
    if (!mayOpen(me, row)) throw notFound('Ticket not found');
    const files = await prisma.attachment.findMany({
      where: { entityType: 'help_ticket', entityId: row.id },
      select: { id: true, fileName: true, mimeType: true, size: true, caption: true, uploadedAt: true },
      orderBy: { uploadedAt: 'asc' },
    });
    const manage = mayManage(me);
    res.json({
      ...row,
      kindLabel: KIND_LABEL[row.kind],
      statusLabel: STATUS_LABEL[row.status],
      replies: row.replies.map((r) => ({ ...r, statusLabel: r.status ? STATUS_LABEL[r.status] : null })),
      // The browser line is for whoever fixes it, not for the raiser's own view.
      userAgent: manage || mayReadAll(me) ? row.userAgent : null,
      files,
      canReply: row.createdById === me.id || manage,
      canManage: manage,
    });
  }),
);

const replySchema = z.object({ body: z.string().trim().min(1, 'Write something').max(10000) });

helpTicketRoutes.post(
  '/:id/replies',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(replySchema, req.body);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw notFound('Ticket not found');
    const own = row.createdById === me.id;
    if (!own && !mayManage(me)) throw forbidden('Only the person who raised it and the administrators answer a ticket');
    // The raiser answering a closed ticket is saying it is not done: it opens again.
    const reopen = own && CLOSED.includes(row.status);
    const reply = await prisma.$transaction(async (tx) => {
      const created = await tx.helpTicketReply.create({
        data: { ticketId: row.id, authorId: me.id, body: body.body, status: reopen ? 'NEW' : null },
        include: { author: person },
      });
      await tx.helpTicket.update({
        where: { id: row.id },
        data: reopen ? { status: 'NEW', closedAt: null } : { updatedAt: new Date() },
      });
      return created;
    });
    await audit(
      {
        entityType: 'help_ticket',
        entityId: row.id,
        action: 'UPDATED',
        summary: `${row.number}: ${me.name} replied${reopen ? ' and opened it again' : ''}`,
      },
      req,
    );
    // The raiser hears the administrators; the administrators hear the raiser
    // — every super admin, and whoever else has answered it.
    const others = own
      ? [...(await receivers()), ...row.replies.map((r) => r.authorId)]
      : [row.createdById];
    await tell(
      others,
      {
        type: 'help.reply',
        title: `${row.number}: ${me.name} replied${reopen ? ' — opened again' : ''}`,
        body: body.body.slice(0, 500),
        link: linkOf(row.id),
      },
      me.id,
    );
    res.status(201).json({ ...reply, statusLabel: reply.status ? STATUS_LABEL[reply.status] : null });
  }),
);

const statusSchema = z.object({
  status: z.nativeEnum(HelpTicketStatus),
  note: z.string().trim().max(10000).optional().nullable(),
});

helpTicketRoutes.post(
  '/:id/status',
  requireAny(P.editAll),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(statusSchema, req.body);
    const row = await load(req.params.id);
    if (row.status === body.status) throw badRequest(`It is already ${STATUS_LABEL[row.status].toLowerCase()}`);
    if (body.status === 'WONT_DO' && !body.note) throw badRequest('Say why it will not be done — the person who raised it reads it');
    const closing = CLOSED.includes(body.status);
    // Claimed on the status it was read with, so two administrators never both move it.
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.helpTicket.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: body.status, closedAt: closing ? new Date() : null },
      });
      if (!claimed.count) throw new HttpError(409, 'It changed a moment ago — reload');
      await tx.helpTicketReply.create({
        data: { ticketId: row.id, authorId: me.id, body: body.note || '', status: body.status },
      });
    });
    await audit(
      {
        entityType: 'help_ticket',
        entityId: row.id,
        action: 'UPDATED',
        summary: `${row.number}: ${STATUS_LABEL[row.status]} → ${STATUS_LABEL[body.status]}`,
        before: { status: row.status },
        after: { status: body.status },
      },
      req,
    );
    await tell(
      [row.createdById],
      {
        type: 'help.reply',
        title: `${row.number} is ${STATUS_LABEL[body.status].toLowerCase()}`,
        body: body.note ? body.note.slice(0, 500) : row.subject,
        link: linkOf(row.id),
      },
      me.id,
    );
    res.json({ ok: true, status: body.status });
  }),
);
