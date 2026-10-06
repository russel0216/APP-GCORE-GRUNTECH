import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, notFound, badRequest } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { globalSearch, searchProviders, canSearch } from '../shared/search';
import { act, approversForStep, historyFor, pendingFor } from '../shared/approvals';
import {
  upload,
  saveAttachment,
  attachmentPath,
  deleteAttachment,
  mayAccessAttachments,
} from '../shared/attachments';
import { renderDocument, formatDate } from '../shared/pdf';
import { can, type ResolvedUser } from '../permissions/resolve';
import { aftermarketSettings, renewalPipeline, sweepOverdue } from '../shared/aftermarket';

// ════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════

export const notificationRoutes = Router();
notificationRoutes.use(authenticate);

notificationRoutes.get(
  '/',
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = {
      userId: me.id,
      ...(q.filters.unread === 'true' ? { isRead: false } : {}),
    };
    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: me.id, isRead: false } }),
    ]);
    res.json({ ...listResult(rows, total, q), unread });
  }),
);

notificationRoutes.post(
  '/:id/read',
  handler(async (req, res) => {
    const me = currentUser(req);
    // Scoped by userId so one person can never mark another's notification.
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: me.id },
      data: { isRead: true, readAt: new Date() },
    });
    if (!result.count) throw notFound('Notification not found');
    res.json({ ok: true });
  }),
);

notificationRoutes.post(
  '/read-all',
  handler(async (req, res) => {
    const me = currentUser(req);
    const result = await prisma.notification.updateMany({
      where: { userId: me.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ ok: true, count: result.count });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  GLOBAL SEARCH  (Ctrl+K)
// ════════════════════════════════════════════════════════════════════

export const searchRoutes = Router();
searchRoutes.use(authenticate);

searchRoutes.get(
  '/',
  handler(async (req, res) => {
    const me = currentUser(req);
    const term = String(req.query.q ?? '');
    res.json({
      term,
      hits: await globalSearch(term, me),
      kinds: searchProviders()
        .filter((p) => canSearch(me, p))
        .map((p) => ({ kind: p.kind, label: p.label })),
    });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  APPROVALS
// ════════════════════════════════════════════════════════════════════

export const approvalRoutes = Router();
approvalRoutes.use(authenticate);

approvalRoutes.get(
  '/pending',
  handler(async (req, res) => {
    const rows = await pendingFor(currentUser(req).id);
    res.json(
      rows.map((r) => ({
        ...r,
        amount: r.amount ? Number(r.amount) : null,
        // Who raised it, so the approver decides on more than a subject line.
        requester: { name: r.requester.name },
      })),
    );
  }),
);

approvalRoutes.get(
  '/mine',
  handler(async (req, res) => {
    const rows = await prisma.approvalRequest.findMany({
      where: { requesterId: currentUser(req).id },
      include: {
        actions: {
          include: { approver: { select: { name: true } } },
          orderBy: { actedAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rows.map((r) => ({ ...r, amount: r.amount ? Number(r.amount) : null })));
  }),
);

approvalRoutes.get(
  '/history/:documentType/:documentId',
  handler(async (req, res) => {
    const me = currentUser(req);
    const rows = await historyFor(req.params.documentType, req.params.documentId);
    // `canAct`: whether the viewer may decide the step a PENDING request is at
    // — the rule act() applies (never the requester; an eligible approver or a
    // super admin) — so the document's own page can offer the decision the
    // notification sent them there for. The decision still goes through
    // POST /approvals/:id/act, the one path.
    res.json(
      await Promise.all(
        rows.map(async (r) => {
          if (r.status !== 'PENDING' || r.requesterId === me.id) return { ...r, canAct: false };
          const step = await prisma.approvalStep.findFirst({
            where: { workflowId: r.workflowId ?? '', sequence: r.currentSequence },
          });
          const canAct = !!step && (me.isSuperAdmin || (await approversForStep(step, r.requesterId)).includes(me.id));
          return { ...r, canAct };
        }),
      ),
    );
  }),
);

const actSchema = z.object({
  action: z.enum(['APPROVED', 'REJECTED', 'RETURNED']),
  comment: z.string().optional(),
});

approvalRoutes.post(
  '/:id/act',
  handler(async (req, res) => {
    const body = parseBody(actSchema, req.body);
    const result = await act({
      requestId: req.params.id,
      userId: currentUser(req).id,
      action: body.action,
      comment: body.comment,
    });
    res.json({ ...result, amount: result.amount ? Number(result.amount) : null });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  MY WORK  — the real home page (model §8)
// ════════════════════════════════════════════════════════════════════

/**
 * One row of "today" on My Work: a meeting, a training session, a planned
 * activity — anything with a start and an end that a person is expected at.
 */
export interface ScheduleItem {
  kind: 'meeting' | 'training' | string;
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** App path of the record, always starting with `/`. */
  link: string;
  /** A join link when the thing happens online, else null. */
  meetLink: string | null;
  sub?: string;
}

export type ScheduleProvider = (
  user: ResolvedUser,
  window: { from: Date; to: Date },
) => Promise<ScheduleItem[]>;

const scheduleProviders: ScheduleProvider[] = [];

/**
 * The `registerSearch` pattern for today's schedule: Meetings and the Academy
 * each register a provider from their own route module, and this file never
 * learns what a session is. A verify script that wants a row here imports
 * the module that registers it — otherwise the provider was never loaded.
 */
export function registerSchedule(fn: ScheduleProvider): void {
  scheduleProviders.push(fn);
}

/** Every provider's rows for one window, in time order. */
export async function scheduleFor(
  user: ResolvedUser,
  window: { from: Date; to: Date },
): Promise<ScheduleItem[]> {
  const results = await Promise.all(
    scheduleProviders.map((fn) =>
      fn(user, window).catch((err) => {
        console.error('Schedule provider failed:', err);
        return [] as ScheduleItem[];
      }),
    ),
  );
  return results.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * A planned sales activity is a schedule row like any meeting: it has a start,
 * a duration and a person expected at it. Registered here rather than in
 * sales.ts because the activity is the one "today" source that predates the
 * seam — the module never had a provider to move.
 */
registerSchedule(async (user, { from, to }) => {
  const rows = await prisma.salesActivity.findMany({
    // Booked for them, or invited to it.
    where: {
      OR: [{ assignedToId: user.id }, { invitees: { some: { userId: user.id } } }],
      status: 'PLANNED',
      startsAt: { gte: from, lt: to },
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      type: true,
      assignedToId: true,
      assignedTo: { select: { name: true } },
      subject: true,
      location: true,
      startsAt: true,
      durationMinutes: true,
      lead: { select: { companyName: true } },
      customer: { select: { name: true } },
      quotation: { select: { number: true } },
    },
  });
  return rows.map((r) => ({
    kind: 'activity',
    id: r.id,
    title: r.subject,
    startsAt: r.startsAt,
    endsAt: new Date(r.startsAt.getTime() + r.durationMinutes * 60_000),
    link: `/g-ops/calendar?activity=${r.id}`,
    meetLink: null,
    sub: [
      humanise(r.type),
      r.lead?.companyName ?? r.customer?.name ?? r.quotation?.number ?? null,
      r.location,
      r.assignedToId === user.id ? null : `with ${r.assignedTo.name} (invited)`,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
});

/**
 * One row of "assigned to me" or "my drafts" — the contract every module's
 * rows share (audits plan §3 item 7). `link` always starts with `/`, which is
 * what verify-workspace.ts checks for every row the route returns.
 */
export interface WorkRow {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  /** The date that matters — next action, due date, target end — if any. */
  when?: Date | null;
  overdue?: boolean;
  link: string;
}

function humanise(value: string): string {
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TAKE = 10;

/** Past its date and still open. A missing date is never overdue. */
function isOverdue(when: Date | null | undefined, today: Date): boolean {
  return when != null && when.getTime() < today.getTime();
}

/** Overdue first, then by date with undated rows last. */
function byUrgency(a: WorkRow, b: WorkRow): number {
  if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
  const at = a.when ? a.when.getTime() : Number.POSITIVE_INFINITY;
  const bt = b.when ? b.when.getTime() : Number.POSITIVE_INFINITY;
  return at - bt;
}

/**
 * What is on my plate that nobody has to approve: the leads I am working,
 * the jobs I manage, the visits I am booked on, the tasks on my name, the
 * job orders I am to attend, and any planned activity I let slip past its day.
 * Ten of each, oldest date first.
 */
async function assignedTo(me: ResolvedUser, dayStart: Date): Promise<WorkRow[]> {
  const [leads, jobs, visits, tasks, jobOrders, slipped] = await Promise.all([
    prisma.lead.findMany({
      where: { assignedToId: me.id, status: { notIn: ['WON', 'LOST'] } },
      orderBy: [{ nextActionDate: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: TAKE,
      select: { id: true, number: true, companyName: true, status: true, nextAction: true, nextActionDate: true },
    }),
    prisma.job.findMany({
      where: { projectManagerId: me.id, status: { in: ['PLANNING', 'IN_PROGRESS', 'ON_HOLD'] } },
      orderBy: [{ targetEndDate: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: TAKE,
      select: { id: true, number: true, name: true, status: true, targetEndDate: true, customer: { select: { name: true } } },
    }),
    prisma.serviceVisit.findMany({
      where: { assignedToId: me.id, status: 'SCHEDULED' },
      orderBy: { dueDate: 'asc' },
      take: TAKE,
      select: {
        id: true,
        number: true,
        kind: true,
        dueDate: true,
        customer: { select: { name: true } },
        site: { select: { name: true } },
      },
    }),
    prisma.jobTask.findMany({
      where: { assignedToId: me.id, status: { not: 'DONE' } },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: TAKE,
      select: { id: true, name: true, status: true, dueDate: true, jobId: true, job: { select: { number: true, name: true } } },
    }),
    prisma.jobOrder.findMany({
      where: { assignedToId: me.id, status: 'APPROVED' },
      orderBy: { requestedFor: 'asc' },
      take: TAKE,
      select: { id: true, number: true, title: true, urgent: true, requestedFor: true, customer: { select: { name: true } } },
    }),
    // Planned before today and never marked done — the follow-up that slipped.
    prisma.salesActivity.findMany({
      where: { assignedToId: me.id, status: 'PLANNED', startsAt: { lt: dayStart } },
      orderBy: { startsAt: 'desc' },
      take: TAKE,
      select: {
        id: true,
        type: true,
        subject: true,
        startsAt: true,
        lead: { select: { companyName: true } },
        customer: { select: { name: true } },
      },
    }),
  ]);

  const rows: WorkRow[] = [
    ...leads.map((r) => ({
      id: r.id,
      kind: 'lead',
      title: r.companyName,
      subtitle: `${r.number} · ${r.nextAction ?? humanise(r.status)}`,
      when: r.nextActionDate,
      overdue: isOverdue(r.nextActionDate, dayStart),
      link: `/g-ops/leads/${r.id}`,
    })),
    ...jobs.map((r) => ({
      id: r.id,
      kind: 'job',
      title: r.name,
      subtitle: `${r.number} · ${r.customer.name} · ${humanise(r.status)}`,
      when: r.targetEndDate,
      overdue: r.status !== 'ON_HOLD' && isOverdue(r.targetEndDate, dayStart),
      link: `/g-ops/projects/${r.id}`,
    })),
    ...visits.map((r) => ({
      id: r.id,
      kind: 'visit',
      title: r.customer.name,
      subtitle: `${r.number} · ${humanise(r.kind)}${r.site ? ` · ${r.site.name}` : ''}`,
      when: r.dueDate,
      overdue: isOverdue(r.dueDate, dayStart),
      link: `/g-ops/visits?visit=${r.id}`,
    })),
    ...tasks.map((r) => ({
      id: r.id,
      kind: 'task',
      title: r.name,
      subtitle: `${r.job.number} · ${r.job.name} · ${humanise(r.status)}`,
      when: r.dueDate,
      overdue: isOverdue(r.dueDate, dayStart),
      link: `/g-ops/projects/${r.jobId}`,
    })),
    ...jobOrders.map((r) => ({
      id: r.id,
      kind: 'job_order',
      title: r.title,
      subtitle: `${r.number} · ${r.customer.name}${r.urgent ? ' · URGENT' : ''}`,
      when: r.requestedFor,
      overdue: isOverdue(r.requestedFor, dayStart),
      link: `/g-ops/job-orders/${r.id}`,
    })),
    ...slipped.map((r) => ({
      id: r.id,
      kind: 'activity',
      title: r.subject,
      subtitle: [humanise(r.type), r.lead?.companyName ?? r.customer?.name ?? null].filter(Boolean).join(' · '),
      when: r.startsAt,
      overdue: true,
      link: `/g-ops/calendar?activity=${r.id}`,
    })),
  ];
  return rows.sort(byUrgency);
}

/**
 * Documents I started and never submitted. A draft is invisible to everyone
 * else by design, which is exactly why it needs a place on my own screen —
 * nobody will chase it. Overtime has no draft: filing it submits it.
 */
async function draftsOf(me: ResolvedUser): Promise<WorkRow[]> {
  const [revisions, prs, claims, advances, leave, jobOrders] = await Promise.all([
    prisma.quotationRevision.findMany({
      where: { status: 'DRAFT', quotation: { ownerId: me.id } },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: {
        id: true,
        revision: true,
        updatedAt: true,
        quotation: { select: { id: true, number: true, subject: true } },
      },
    }),
    prisma.purchaseRequest.findMany({
      where: { requestedById: me.id, status: 'DRAFT' },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: { id: true, number: true, purpose: true, updatedAt: true },
    }),
    prisma.expenseClaim.findMany({
      where: { claimedById: me.id, status: 'DRAFT' },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: { id: true, number: true, purpose: true, updatedAt: true },
    }),
    prisma.cashAdvance.findMany({
      where: { requestedById: me.id, status: 'DRAFT' },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: { id: true, number: true, purpose: true, updatedAt: true },
    }),
    prisma.leaveRequest.findMany({
      where: { status: 'DRAFT', employee: { userId: me.id } },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: { id: true, number: true, reason: true, startDate: true, updatedAt: true, leaveType: { select: { name: true } } },
    }),
    prisma.jobOrder.findMany({
      where: { requestedById: me.id, status: 'DRAFT' },
      orderBy: { updatedAt: 'desc' },
      take: TAKE,
      select: { id: true, number: true, title: true, updatedAt: true, customer: { select: { name: true } } },
    }),
  ]);

  const rows: WorkRow[] = [
    ...revisions.map((r) => ({
      id: r.quotation.id,
      kind: 'quotation',
      title: r.quotation.subject,
      subtitle: `${r.quotation.number} · revision ${r.revision}`,
      when: r.updatedAt,
      link: `/g-ops/quotations/${r.quotation.id}`,
    })),
    ...prs.map((r) => ({
      id: r.id,
      kind: 'purchase_request',
      title: r.purpose,
      subtitle: r.number,
      when: r.updatedAt,
      link: `/g-chain/purchase-requests/${r.id}`,
    })),
    ...claims.map((r) => ({
      id: r.id,
      kind: 'expense_claim',
      title: r.purpose,
      subtitle: r.number,
      when: r.updatedAt,
      link: `/g-fin/expenses/${r.id}`,
    })),
    ...advances.map((r) => ({
      id: r.id,
      kind: 'cash_advance',
      title: r.purpose,
      subtitle: r.number,
      when: r.updatedAt,
      link: `/g-fin/cash-advances/${r.id}`,
    })),
    ...leave.map((r) => ({
      id: r.id,
      kind: 'leave_request',
      title: `${r.leaveType.name} from ${formatDate(r.startDate)}`,
      subtitle: `${r.number} · ${r.reason}`,
      when: r.updatedAt,
      link: `/g-hr/leave/${r.id}`,
    })),
    ...jobOrders.map((r) => ({
      id: r.id,
      kind: 'job_order',
      title: r.title,
      subtitle: `${r.number} · ${r.customer.name}`,
      when: r.updatedAt,
      link: `/g-ops/job-orders/${r.id}`,
    })),
  ];
  // Most recently touched first — the one you were in the middle of.
  return rows.sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0));
}

/**
 * What is about to run out, for the people who sell renewals. Read off the
 * aftermarket module's own pipeline so this list and Service Contracts agree.
 */
async function renewalsFor(me: ResolvedUser) {
  if (!can(me, 'gops.service_contracts.view_all')) return [];
  const settings = await aftermarketSettings();
  const rows = await renewalPipeline(settings.expiryWarningDays);
  return rows.slice(0, TAKE).map((r) => ({
    ...r,
    link: r.kind === 'CONTRACT' ? `/g-ops/service-contracts/${r.id}` : `/g-ops/installed-base/${r.id}`,
  }));
}

export const myWorkRoutes = Router();
myWorkRoutes.use(authenticate);

myWorkRoutes.get(
  '/',
  handler(async (req, res) => {
    const me = currentUser(req);

    // Today on the server's clock — local midnight to the next one, a window
    // over timestamps. (HR's dayKey() is a key for @db.Date columns, which is
    // a different thing: it is UTC midnight of the local date.)
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(dayStart.getTime() + 86400000);

    // Expiry and missed visits are derived on read (Phase 8). Once per
    // request, before the queries that depend on the result run.
    await sweepOverdue();

    const [approvals, submitted, unread, recentActivity, todaysSchedule, assignedToMe, myDrafts, renewals] =
      await Promise.all([
        pendingFor(me.id),
        prisma.approvalRequest.findMany({
          where: { requesterId: me.id, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: TAKE,
        }),
        prisma.notification.count({ where: { userId: me.id, isRead: false } }),
        prisma.auditLog.findMany({
          where: { actorId: me.id },
          orderBy: { at: 'desc' },
          take: 8,
        }),
        scheduleFor(me, { from: dayStart, to: dayEnd }),
        assignedTo(me, dayStart),
        draftsOf(me),
        renewalsFor(me),
      ]);

    res.json({
      awaitingMyApproval: approvals.map((a) => ({
        id: a.id,
        subject: a.subject,
        documentType: a.documentType,
        documentNumber: a.documentNumber,
        amount: a.amount ? Number(a.amount) : null,
        link: a.link,
        createdAt: a.createdAt,
        requester: { name: a.requester.name },
      })),
      myPendingSubmissions: submitted.map((s) => ({
        id: s.id,
        subject: s.subject,
        documentType: s.documentType,
        documentNumber: s.documentNumber,
        link: s.link,
        createdAt: s.createdAt,
      })),
      unreadNotifications: unread,
      recentActivity,
      assignedToMe,
      todaysSchedule,
      myDrafts,
      renewals,
    });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  ATTACHMENTS
// ════════════════════════════════════════════════════════════════════

export const attachmentRoutes = Router();
attachmentRoutes.use(authenticate);

/*
  /file/:id has to be registered before the generic /:entityType/:entityId
  routes below, or Express matches it there first — "file" becomes the
  entityType, "id" the entityId, and the ORM query simply finds nothing,
  which came back as a 200 with an empty list rather than an error. Nothing
  had called this route until the account-photo avatar did (see ui.tsx's
  Avatar), so it sat wrong, unnoticed, for however long it's been here — the
  same class of route-order fault the Phase 6 notes already flag for
  /overtime/chargeable. Keep this one on top.
*/
attachmentRoutes.get(
  '/file/:id',
  handler(async (req, res) => {
    const row = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Attachment not found');
    // Knowing a file's id is not the same right as seeing the record it is on.
    if (!(await mayAccessAttachments(currentUser(req), row.entityType, row.entityId))) {
      throw notFound('Attachment not found');
    }

    const full = attachmentPath(row.storedName);
    if (!fs.existsSync(full)) throw notFound('The stored file is missing from disk');

    res.setHeader('Content-Type', row.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(row.fileName)}"`,
    );
    fs.createReadStream(full).pipe(res);
  }),
);

/** Refuses before multer writes anything to disk, so a refused upload leaves no stray file. */
const guardRecord = handler(async (req, _res, next) => {
  if (!(await mayAccessAttachments(currentUser(req), req.params.entityType, req.params.entityId))) {
    throw notFound('Record not found');
  }
  next();
});

attachmentRoutes.get(
  '/:entityType/:entityId',
  guardRecord,
  handler(async (req, res) => {
    const rows = await prisma.attachment.findMany({
      where: { entityType: req.params.entityType, entityId: req.params.entityId },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { uploadedAt: 'asc' },
    });
    res.json(rows);
  }),
);

attachmentRoutes.post(
  '/:entityType/:entityId',
  guardRecord,
  upload.array('files', 20),
  handler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('No files were uploaded');

    const capturedAt = req.body.capturedAt ? new Date(req.body.capturedAt) : undefined;
    const saved = [];
    for (const file of files) {
      saved.push(
        await saveAttachment({
          entityType: req.params.entityType,
          entityId: req.params.entityId,
          file,
          uploadedById: currentUser(req).id,
          caption: req.body.caption,
          capturedAt,
        }),
      );
    }
    res.status(201).json(saved);
  }),
);

attachmentRoutes.delete(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.attachment.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Attachment not found');
    if (row.uploadedById !== me.id && !me.isSuperAdmin) {
      throw badRequest('Only the person who uploaded a file can remove it');
    }
    await deleteAttachment(req.params.id);
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SAVED FILTERS  (the shared list pattern)
// ════════════════════════════════════════════════════════════════════

export const savedFilterRoutes = Router();
savedFilterRoutes.use(authenticate);

savedFilterRoutes.get(
  '/:listKey',
  handler(async (req, res) => {
    const me = currentUser(req);
    res.json(
      await prisma.savedFilter.findMany({
        where: {
          listKey: req.params.listKey,
          OR: [{ userId: me.id }, { isShared: true }],
        },
        orderBy: { name: 'asc' },
      }),
    );
  }),
);

savedFilterRoutes.post(
  '/:listKey',
  handler(async (req, res) => {
    const body = parseBody(
      z.object({ name: z.string().min(1), query: z.record(z.unknown()), isShared: z.boolean().default(false) }),
      req.body,
    );
    const row = await prisma.savedFilter.create({
      data: {
        listKey: req.params.listKey,
        userId: currentUser(req).id,
        name: body.name,
        query: body.query as object,
        isShared: body.isShared,
      },
    });
    res.status(201).json(row);
  }),
);

/** Rename, re-point or share a view — the owner's only, scoped like delete. */
savedFilterRoutes.patch(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        name: z.string().min(1).optional(),
        query: z.record(z.unknown()).optional(),
        isShared: z.boolean().optional(),
      }),
      req.body,
    );
    const result = await prisma.savedFilter.updateMany({
      where: { id: req.params.id, userId: me.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.query !== undefined ? { query: body.query as object } : {}),
        ...(body.isShared !== undefined ? { isShared: body.isShared } : {}),
      },
    });
    if (!result.count) throw notFound('Saved filter not found');
    res.json(await prisma.savedFilter.findUnique({ where: { id: req.params.id } }));
  }),
);

savedFilterRoutes.delete(
  '/:id',
  handler(async (req, res) => {
    const result = await prisma.savedFilter.deleteMany({
      where: { id: req.params.id, userId: currentUser(req).id },
    });
    if (!result.count) throw notFound('Saved filter not found');
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  PDF ENGINE — proof that branding is uniform before any module uses it
// ════════════════════════════════════════════════════════════════════

export const pdfRoutes = Router();
pdfRoutes.use(authenticate);

/**
 * Renders a specimen of every section type the engine supports. This is not a
 * toy: it is how you check the company header, fonts, table rules, signature
 * block and page numbering after changing Company Settings — without needing a
 * real quotation to exist first.
 */
pdfRoutes.get(
  '/specimen',
  handler(async (req, res) => {
    const me = currentUser(req);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });

    const pdf = await renderDocument({
      title: 'Document Specimen',
      documentNumber: `${company?.numberPrefix ?? 'GT'}-SPEC-${new Date().getFullYear()}-0001`,
      revision: '0',
      date: new Date(),
      reference: 'Specimen — every G-Core document renders through this one engine',
      sections: [
        {
          kind: 'fields',
          title: 'Header fields',
          columns: 3,
          fields: [
            { label: 'Customer', value: 'Sample Customer Inc.' },
            { label: 'Project', value: 'Oxygen Plant Expansion' },
            { label: 'Site', value: 'Cagayan de Oro' },
            { label: 'Prepared by', value: me.name },
            { label: 'Currency', value: company?.currency ?? 'PHP' },
            { label: 'Date', value: formatDate(new Date()) },
          ],
        },
        {
          kind: 'text',
          title: 'Scope of work',
          body:
            'Supply, fabrication, installation, testing and commissioning of the ' +
            'oxygen generation skid including controller assembly, piping ' +
            'interconnection, and turnover documentation. This paragraph exists to ' +
            'show how body text wraps and justifies inside the content column.',
        },
        {
          kind: 'table',
          title: 'Cost summary',
          head: ['Category', 'Description', 'Qty', 'Unit cost', 'Amount'],
          widths: [16, 40, 10, 17, 17],
          align: ['left', 'left', 'right', 'right', 'right'],
          rows: [
            ['Materials', 'Piping, fittings and valves', '1', '850,000.00', '850,000.00'],
            ['Equipment', 'Oxygen generator skid', '1', '2,400,000.00', '2,400,000.00'],
            ['Labor', 'Fabrication and installation crew', '1', '620,000.00', '620,000.00'],
            ['Subcontractor', 'Civil works', '1', '310,000.00', '310,000.00'],
            ['Indirect', 'Mobilisation, permits, supervision', '1', '180,000.00', '180,000.00'],
            ['', 'TOTAL', '', '', '4,360,000.00'],
          ],
        },
        {
          kind: 'fields',
          title: 'Tax treatment',
          columns: 3,
          fields: [
            { label: 'VAT rate', value: `${((Number(company?.vatRate) || 0) * 100).toFixed(0)}%` },
            { label: 'EWT rate', value: `${((Number(company?.ewtRate) || 0) * 100).toFixed(0)}%` },
            { label: 'Note', value: 'EWT is withheld at source — invoiced ≠ collectible' },
          ],
        },
      ],
      signatories: [
        // Dated, so the specimen shows the timestamp line every real document
        // carries rather than a preview that quietly omits it.
        { role: 'Prepared by', name: me.name, position: me.position ?? undefined, at: new Date(Date.now() - 36 * 3600_000) },
        { role: 'Checked by', name: me.name, at: new Date(Date.now() - 20 * 3600_000) },
        { role: 'Approved by' },
      ],
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="gcore-specimen.pdf"');
    res.send(pdf);
  }),
);
