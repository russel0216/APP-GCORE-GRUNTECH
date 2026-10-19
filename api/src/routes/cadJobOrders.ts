import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma, CadJobOrderStatus, CadPriority } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  idsFilter,
  notFound,
  badRequest,
  forbidden,
  deleteOrRefuse,
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { can, impliedBy, resolveUser, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify, type NotificationType } from '../shared/notifications';
import { mailConfig, sendMail } from '../shared/mail';
import { renderDocument, formatDate, formatShortDate, formatDateTime, statusLabel, type PdfSection, type Signatory } from '../shared/pdf';
import { contactsOf, submitForApproval, cancelOpenRequest, onApprovalSettled, onApprovalReopened, pickWorkflow, mayDecide, routeBrief, type ApprovalOutcome } from '../shared/approvals';
import type { ApprovalRequest } from '@prisma/client';
import { teamOf } from '../shared/team';
import { toCsv } from '../shared/csv';
import { manilaDayStart, manilaDayEnd } from '../shared/day';
import { registerSearch } from '../shared/search';
import { registerAttachmentGuard, cadUpload, saveAttachment, deleteAttachmentsOf } from '../shared/attachments';
import { dayKey } from '../shared/aftermarket';
import { safeHttpUrl } from '../shared/partners';
import { LIST_CAP, listReference, rangeNamed, namedInFilter, filterDay, dayOf, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { requestFromCad } from './planApprovals';
import { viewScope } from '../shared/ownScope';
import { visibleOwners } from '../shared/team';

/**
 * CAD job orders — the design team's queue (2026-10-09, the owner's call:
 * "optimize the design team, consolidating job orders").
 *
 * Sales, project managers and engineers raise a request for a drawing —
 * for a customer, linked to the quotation, project or job order it is for —
 * with the scope in one box, the drawing type, the day it is needed and the
 * reference files. The Designer Lead dispatches it (or a designer takes it
 * from the queue), the designer sets the priority and reports progress in
 * percent, and submits the work as REVISIONS: R0, R1, R2 … each with its own
 * files and a note of what changed, never overwritten, so every earlier one
 * can still be opened. The output to the requestor is always a PDF (the
 * owner's call): a revision must carry one; the AutoCAD or SketchUp source
 * travels beside it. The requestor accepts, or asks for changes in the
 * comment thread, and the next revision answers. No money, no approval
 * route — it is work, not a decision — so nothing here touches the engine.
 *
 * Rights: `edit_all` is the design team (progress, revisions, priority on what
 * is assigned to them — and taking an unassigned request); `approve` is the
 * Designer Lead (assigns and reassigns, closes any); `edit_own` is the
 * requestor on their own request. Overdue is derived from `neededBy`.
 */

export const cadJobOrderRoutes = Router();
cadJobOrderRoutes.use(authenticate);

const P = {
  viewAll: 'gops.cad_job_orders.view_all',
  viewOwn: 'gops.cad_job_orders.view_own',
  create: 'gops.cad_job_orders.create',
  editOwn: 'gops.cad_job_orders.edit_own',
  editAll: 'gops.cad_job_orders.edit_all',
  approve: 'gops.cad_job_orders.approve',
  delete: 'gops.cad_job_orders.delete',
  export: 'gops.cad_job_orders.export',
} as const;

const OPEN: CadJobOrderStatus[] = ['REQUESTED', 'IN_PROGRESS', 'FOR_REVIEW', 'CHANGES_REQUESTED', 'ON_HOLD'];
const CLOSED: CadJobOrderStatus[] = ['COMPLETED', 'CANCELLED'];
/** Before the queue (2026-10-16): raised, and with the requester's Team Leader. */
const BEFORE_QUEUE: CadJobOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL'];
const DOC = 'cad_job_order';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: string, label: string): Date {
  if (!DAY.test(value)) throw badRequest(`${label} is not a valid date`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

const person = { select: { id: true, name: true, position: true } } as const;

const cadInclude = {
  customer: { select: { id: true, code: true, name: true } },
  job: { select: { id: true, number: true, name: true, status: true } },
  quotation: { select: { id: true, number: true, subject: true, outcome: true } },
  jobOrder: { select: { id: true, number: true, projectName: true, title: true, status: true } },
  drawingType: { select: { id: true, name: true } },
  team: { select: { id: true, code: true, name: true } },
  requestedBy: person,
  assignedTo: person,
  completedBy: { select: { id: true, name: true } },
  approvedPlan: { select: { id: true, number: true, title: true, drawingNo: true, revision: true, status: true } },
  revisions: { select: { sequence: true, submittedAt: true }, orderBy: { sequence: 'desc' as const }, take: 1 },
  _count: { select: { revisions: true, comments: true } },
} satisfies Prisma.CadJobOrderInclude;

type CadRow = Prisma.CadJobOrderGetPayload<{ include: typeof cadInclude }>;

/** The day for a DATE column: Manila's, never the host clock's. */
const today = () => dayKey(new Date());

function present(row: CadRow) {
  const { revisions, _count, ...rest } = row;
  const latest = revisions[0] ?? null;
  return {
    ...rest,
    amount: row.amount == null ? null : Number(row.amount),
    overdue: row.neededBy != null && OPEN.includes(row.status) && row.neededBy < today(),
    latestRevision: latest ? { sequence: latest.sequence, label: `R${latest.sequence}`, submittedAt: latest.submittedAt } : null,
    revisionCount: _count.revisions,
    commentCount: _count.comments,
  };
}

// ── Who may do what ─────────────────────────────────────────────────────────

const isDesigner = (me: ResolvedUser) => can(me, P.editAll) || can(me, P.approve);
const isLead = (me: ResolvedUser) => can(me, P.approve);
const onlyOwn = (me: ResolvedUser) => !can(me, P.viewAll);
const onIt = (me: ResolvedUser, row: { requestedById: string; assignedToId: string | null }) =>
  row.requestedById === me.id || row.assignedToId === me.id;
/** View Team (2026-10-19): raised by, or on the board of, somebody on the viewer's team. */
const onTeam = (me: ResolvedUser, row: { requestedById: string; assignedToId: string | null }) =>
  viewScope(me, 'gops', 'cad_job_orders') === 'team' &&
  [row.requestedById, row.assignedToId].some((id) => !!id && me.teamMemberIds.includes(id));
const mayOpen = (me: ResolvedUser, row: { requestedById: string; assignedToId: string | null }) =>
  !onlyOwn(me) || onIt(me, row) || onTeam(me, row);
const isRequestor = (me: ResolvedUser, row: { requestedById: string }) => row.requestedById === me.id && can(me, P.editOwn);
const isAssignee = (me: ResolvedUser, row: { assignedToId: string | null }) => row.assignedToId === me.id && isDesigner(me);
/** Who works the request: its designer, or the lead on any. */
const isWorker = (me: ResolvedUser, row: { assignedToId: string | null }) => isAssignee(me, row) || isLead(me);

function flags(me: ResolvedUser, row: CadRow) {
  const open = OPEN.includes(row.status);
  const requestor = isRequestor(me, row);
  const worker = isWorker(me, row);
  const lead = isLead(me);
  return {
    canEdit: (open && (requestor || lead)) || (row.status === 'DRAFT' && (requestor || lead)),
    canSubmit: row.status === 'DRAFT' && (requestor || lead || me.isSuperAdmin),
    canWithdraw: row.status === 'PENDING_APPROVAL' && (requestor || lead || me.isSuperAdmin),
    canTake: open && row.status !== 'ON_HOLD' && !row.assignedToId && isDesigner(me),
    canAssign: open && lead,
    canSetPriority: open && worker,
    // The progress slider is the assigned designer's alone (2026-10-16, the owner's sample).
    canProgress: isAssignee(me, row) && ['REQUESTED', 'IN_PROGRESS', 'CHANGES_REQUESTED'].includes(row.status) && !!row.assignedToId,
    canSubmitRevision: worker && ['REQUESTED', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'FOR_REVIEW'].includes(row.status) && !!row.assignedToId,
    canAccept: row.status === 'FOR_REVIEW' && (requestor || worker),
    canRequestChanges: row.status === 'FOR_REVIEW' && (requestor || lead),
    canHold: open && row.status !== 'ON_HOLD' && (requestor || worker),
    canResume: row.status === 'ON_HOLD' && (requestor || worker),
    canCancel: (open || BEFORE_QUEUE.includes(row.status)) && (requestor || lead),
    // A cancelled request is the one that may go, by its requestor or the lead, with the delete right.
    canDelete: (row.status === 'CANCELLED' || row.status === 'DRAFT') && can(me, P.delete) && (requestor || lead || me.isSuperAdmin),
    canComment: !CLOSED.includes(row.status) || requestor || worker,
    canFilePlan: row.status === 'COMPLETED' && !!row.jobId && !row.approvedPlanId && (requestor || worker),
    isDesigner: isDesigner(me),
    isLead: lead,
  };
}

/** Which of a viewer's requests "mine" means: raised by them, or on their drawing board. */
const mineWhere = (userId: string): Prisma.CadJobOrderWhereInput => ({
  OR: [{ requestedById: userId }, { assignedToId: userId }],
});
const peopleWhere = (ids: string[]): Prisma.CadJobOrderWhereInput => ({
  OR: [{ requestedById: { in: ids } }, { assignedToId: { in: ids } }],
});

async function load(id: string): Promise<CadRow> {
  const row = await prisma.cadJobOrder.findUnique({ where: { id }, include: cadInclude });
  if (!row) throw notFound('CAD job order not found');
  return row;
}

const subjectOf = (row: { number: string; title: string; customer: { name: string } }) => `${row.number} — ${row.title} (${row.customer.name})`;
const linkOf = (id: string) => `/g-ops/cad-job-orders/${id}`;

// ── Telling people ──────────────────────────────────────────────────────────

/**
 * Everyone on the design team: active logins holding the design right or the
 * lead's, through a role — the people picker's rule.
 * Super admins hold everything and are not told (they are not designers).
 */
async function designTeam(): Promise<string[]> {
  const holding = (key: string): Prisma.UserWhereInput => ({
    roles: { some: { role: { permissions: { some: { permission: { key: { in: impliedBy(key) } } } } } } },
  });
  const rows = await prisma.user.findMany({
    where: { isActive: true, OR: [holding(P.editAll), holding(P.approve)] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** A bell each, and an email each where SMTP is set — sent after the save, never allowed to fail it. */
async function tell(
  userIds: (string | null | undefined)[],
  message: { type: NotificationType; title: string; body: string; link: string },
  except: string | null = null,
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
      console.error(`CAD job order email to ${p.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// ── The files on a request, its revisions and its comments ──────────────────

const fileSelect = {
  id: true,
  entityType: true,
  entityId: true,
  fileName: true,
  mimeType: true,
  size: true,
  uploadedAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttachmentSelect;

async function filesFor(entityType: string, ids: string[]) {
  if (!ids.length) return new Map<string, Prisma.AttachmentGetPayload<{ select: typeof fileSelect }>[]>();
  const rows = await prisma.attachment.findMany({ where: { entityType, entityId: { in: ids } }, select: fileSelect, orderBy: { uploadedAt: 'asc' } });
  const map = new Map<string, typeof rows>();
  for (const r of rows) map.set(r.entityId, [...(map.get(r.entityId) ?? []), r]);
  return map;
}

const isPdf = (f: { originalname: string; mimetype: string }) => f.mimetype === 'application/pdf' || path.extname(f.originalname).toLowerCase() === '.pdf';

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

// Knowing a file's id is not the same right as seeing the request it is on.
registerAttachmentGuard('cad_job_order', async (user, id) => {
  const row = await prisma.cadJobOrder.findUnique({ where: { id }, select: { requestedById: true, assignedToId: true } });
  return !!row && mayOpen(user, row);
});
registerAttachmentGuard('cad_revision', async (user, id) => {
  const row = await prisma.cadRevision.findUnique({ where: { id }, select: { cadJobOrder: { select: { requestedById: true, assignedToId: true } } } });
  return !!row && mayOpen(user, row.cadJobOrder);
});
registerAttachmentGuard('cad_comment', async (user, id) => {
  const row = await prisma.cadComment.findUnique({ where: { id }, select: { cadJobOrder: { select: { requestedById: true, assignedToId: true } } } });
  return !!row && mayOpen(user, row.cadJobOrder);
});

// ── List ────────────────────────────────────────────────────────────────────

const SORTABLE = ['number', 'neededBy', 'createdAt', 'updatedAt', 'progressPct'];

/**
 * The one query for the rows, the summary cards and the printed list. `base`
 * is the visibility rule, the scope and the search; `where` adds the filters.
 */
export function cadListWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>) {
  const and: Prisma.CadJobOrderWhereInput[] = [];
  if (q.scope === 'mine') and.push(mineWhere(me.id));
  else if (onlyOwn(me)) and.push(peopleWhere(visibleOwners(me, 'gops', 'cad_job_orders')));
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { scope: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  const base: Prisma.CadJobOrderWhereInput = and.length ? { AND: and } : {};

  const f = q.filters;
  const more: Prisma.CadJobOrderWhereInput[] = [];
  // One status, or several comma-separated (the report's tick boxes).
  const statuses = (f.status ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => choice(v, CadJobOrderStatus, 'Status')!);
  if (statuses.length) more.push({ status: { in: statuses } });
  if (f.teamId) more.push({ teamId: f.teamId === 'none' ? null : f.teamId });
  const createdFrom = filterDay(f.createdFrom, 'Requested from');
  const createdTo = filterDay(f.createdTo, 'Requested to');
  if (createdFrom || createdTo) {
    more.push({ createdAt: { ...(createdFrom ? { gte: manilaDayStart(createdFrom) } : {}), ...(createdTo ? { lte: manilaDayEnd(createdTo) } : {}) } });
  }
  const priority = choice(f.priority, CadPriority, 'Priority');
  if (priority) more.push({ priority });
  if (f.open === 'true') more.push({ status: { in: OPEN } });
  if (f.overdue === 'true') more.push({ status: { in: OPEN }, neededBy: { lt: today() } });
  if (f.unassigned === 'true') more.push({ assignedToId: null, status: { in: OPEN } });
  for (const key of ['assignedToId', 'requestedById', 'drawingTypeId', 'customerId', 'jobId', 'quotationId'] as const) {
    if (f[key]) more.push({ [key]: f[key] === 'none' && key === 'assignedToId' ? null : f[key] });
  }
  const neededFrom = filterDay(f.neededFrom, 'Needed from');
  const neededTo = filterDay(f.neededTo, 'Needed to');
  if (neededFrom || neededTo) more.push({ neededBy: { ...(neededFrom ? { gte: dayOf(neededFrom) } : {}), ...(neededTo ? { lte: dayOf(neededTo) } : {}) } });
  const where: Prisma.CadJobOrderWhereInput = more.length ? { AND: [base, ...more] } : base;
  return { base, where };
}

/** The cards over the list: how the queue stands, under the viewer's own visibility. */
export async function cadListSummary(base: Prisma.CadJobOrderWhereInput) {
  const [byStatus, overdue, unassigned, value] = await Promise.all([
    prisma.cadJobOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    prisma.cadJobOrder.count({ where: { AND: [base, { status: { in: OPEN }, neededBy: { lt: today() } }] } }),
    prisma.cadJobOrder.count({ where: { AND: [base, { status: { in: OPEN }, assignedToId: null }] } }),
    prisma.cadJobOrder.aggregate({ where: { AND: [base, { status: { not: 'CANCELLED' } }] }, _sum: { amount: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const r of byStatus) counts[r.status] = r._count._all;
  const open = OPEN.reduce((t, s) => t + (counts[s] ?? 0), 0);
  return {
    count: open,
    open,
    requested: counts.REQUESTED ?? 0,
    inProgress: (counts.IN_PROGRESS ?? 0) + (counts.CHANGES_REQUESTED ?? 0),
    forReview: counts.FOR_REVIEW ?? 0,
    onHold: counts.ON_HOLD ?? 0,
    completed: counts.COMPLETED ?? 0,
    pendingApproval: counts.PENDING_APPROVAL ?? 0,
    drafts: counts.DRAFT ?? 0,
    totalValue: Number(value._sum.amount ?? 0),
    overdue,
    unassigned,
    tabCounts: counts,
  };
}

cadJobOrderRoutes.get(
  '/',
  requireAny(P.viewAll, P.viewOwn),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = cadListWhere(me, q);
    const [rows, total, summary] = await Promise.all([
      prisma.cadJobOrder.findMany({
        where,
        include: cadInclude,
        orderBy: orderBy(q, SORTABLE, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.cadJobOrder.count({ where }),
      cadListSummary(base),
    ]);
    res.json({ ...listResult(rows.map((r) => ({ ...present(r), canProgress: flags(me, r).canProgress })), total, q), summary });
  }),
);

// ── The printed list (above /:id — route order) ─────────────────────────────

const PRIORITY_LABEL: Record<CadPriority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent' };
const STATUS_LABEL: Record<CadJobOrderStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'TL approval',
  REQUESTED: 'Requested',
  IN_PROGRESS: 'In progress',
  FOR_REVIEW: 'For review',
  CHANGES_REQUESTED: 'Changes requested',
  COMPLETED: 'Completed',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
};

cadJobOrderRoutes.get(
  '/pdf',
  requireAny(P.viewAll, P.viewOwn),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = cadListWhere(me, q);
    // The counts are of the set PRINTED — the list's own where, filters and
    // all — never the queue's cards, which stand under the visibility rule
    // alone: a list narrowed to one designer must not say the whole queue's
    // open and overdue.
    const [rows, count, open, overdue] = await Promise.all([
      prisma.cadJobOrder.findMany({ where, include: cadInclude, orderBy: orderBy(q, SORTABLE, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.cadJobOrder.count({ where }),
      prisma.cadJobOrder.count({ where: { AND: [where, { status: { in: OPEN } }] } }),
      prisma.cadJobOrder.count({ where: { AND: [where, { status: { in: OPEN }, neededBy: { lt: today() } }] } }),
    ]);
    const f = q.filters;
    // Every filter `cadListWhere` applies is said on the paper, by name — a
    // list narrowed to one drawing type, customer, project, quotation,
    // designer or requestor never reads as the whole queue. The customer,
    // project and people are read the way every delivery list reads them
    // (`namedInFilter`); the drawing type and quotation are this list's own.
    const [inFilter, designer, drawingType, quotation] = await Promise.all([
      namedInFilter({ customerId: f.customerId, jobId: f.jobId, userId: f.requestedById }),
      namedInFilter({ userId: f.assignedToId && f.assignedToId !== 'none' ? f.assignedToId : undefined }),
      f.drawingTypeId ? prisma.cadDrawingType.findUnique({ where: { id: f.drawingTypeId }, select: { name: true } }) : null,
      f.quotationId ? prisma.quotation.findUnique({ where: { id: f.quotationId }, select: { number: true } }) : null,
    ]);
    const filters = [
      q.search ? `search "${q.search}"` : null,
      f.status ? `status ${f.status.split(',').map((v) => STATUS_LABEL[v as CadJobOrderStatus] ?? v).join(' or ')}` : null,
      f.teamId ? `team ${f.teamId === 'none' ? 'none' : ((await prisma.industry.findUnique({ where: { id: f.teamId }, select: { code: true } }))?.code ?? 'not found')}` : null,
      rangeNamed('requested', f.createdFrom, f.createdTo),
      f.priority ? `priority ${statusLabel(f.priority)}` : null,
      f.open === 'true' ? 'open' : null,
      f.overdue === 'true' ? 'overdue' : null,
      f.unassigned === 'true' ? 'not yet assigned' : null,
      f.assignedToId ? (f.assignedToId === 'none' ? 'no designer' : `designer ${designer.person}`) : null,
      inFilter.person ? `requested by ${inFilter.person}` : null,
      f.drawingTypeId ? `drawing type ${drawingType?.name ?? 'not found'}` : null,
      inFilter.customer ? `customer ${inFilter.customer}` : null,
      inFilter.project ? `project ${inFilter.project}` : null,
      f.quotationId ? `quotation ${quotation?.number ?? 'not found'}` : null,
      rangeNamed('needed', f.neededFrom, f.neededTo),
      q.scope === 'mine' ? 'raised by me or on my board' : null,
      f.ids ? 'the rows selected' : null,
    ];
    // "12 CAD job orders, 5 open, 2 overdue" — "first 1,000 of 1,234 … printed"
    // when cut — then every filter that narrowed it.
    const named = filters.filter(Boolean);
    const reference =
      `${listReference(count, rows.length, ['CAD job order', 'CAD job orders'], [])}, ` +
      `${open.toLocaleString('en-PH')} open, ${overdue.toLocaleString('en-PH')} overdue` +
      (named.length ? ` — ${named.join(' · ')}` : '');
    // Ten columns: landscape, and the engine's own widths (a head never
    // breaks mid-word); a list's dates are short, its words statusLabel's.
    const pdf = await renderDocument({
      title: 'CAD Job Orders',
      date: new Date(),
      landscape: true,
      reference,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Drawing', 'Customer / project', 'Type', 'Requested by', 'Designer', 'Priority', 'Progress', 'Needed by', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'left', 'right', 'left', 'left'],
          rows: rows.map((r) => [
            r.number,
            { title: r.title, body: r.revisions[0] ? `R${r.revisions[0].sequence}` : undefined },
            { title: r.customer.name, body: r.job ? `${r.job.number} — ${r.job.name}` : undefined },
            r.drawingType?.name ?? '—',
            r.requestedBy.name,
            r.assignedTo?.name ?? 'Open',
            statusLabel(r.priority),
            `${r.progressPct}%`,
            r.neededBy ? formatShortDate(r.neededBy) : '—',
            STATUS_LABEL[r.status],
          ]),
        },
      ],
      signatories: [],
    });
    await audit(
      { entityType: 'cad_job_order', entityId: 'list', action: 'EXPORTED', summary: `Exported the CAD job orders list as PDF (${listReference(count, rows.length, ['CAD job order', 'CAD job orders'], [])})` },
      req,
    );
    sendListPdf(res, pdf, 'cad-job-orders.pdf');
  }),
);

/** The list as a CSV that opens in Excel — the report dialog's "Excel" (above /:id). */
cadJobOrderRoutes.get(
  '/csv',
  requireAny(P.viewAll, P.viewOwn),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = cadListWhere(me, q);
    const rows = await prisma.cadJobOrder.findMany({ where, include: cadInclude, orderBy: orderBy(q, SORTABLE, { createdAt: 'desc' }), take: 5000 });
    await audit({ entityType: 'cad_job_order', entityId: 'list', action: 'EXPORTED', summary: `Exported ${rows.length} CAD job orders as CSV` }, req);
    const day = (d: Date | null) => (d ? dayKey(d).toISOString().slice(0, 10) : '');
    const csv = toCsv([
      ['Number', 'Date requested', 'Requested by', 'Team', 'Drawing', 'Drawing type', 'Customer', 'Project', 'Designer', 'Date started', 'Priority', 'Progress %', 'Needed by', 'Amount', 'Status'],
      ...rows.map((r) => [
        r.number,
        day(r.createdAt),
        r.requestedBy.name,
        r.team?.code ?? '',
        r.title,
        r.drawingType?.name ?? '',
        r.customer.name,
        r.job ? `${r.job.number} — ${r.job.name}` : '',
        r.assignedTo?.name ?? '',
        day(r.startedAt),
        PRIORITY_LABEL[r.priority],
        r.progressPct,
        r.neededBy ? r.neededBy.toISOString().slice(0, 10) : '',
        r.amount == null ? '' : Number(r.amount),
        STATUS_LABEL[r.status],
      ]),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cad-job-orders.csv"');
    res.send(csv);
  }),
);

// ── Lookups for the form (above /:id) ───────────────────────────────────────

/**
 * The pickers the form needs, behind the form's own permission: the customer
 * names, then — for one customer — its quotations (any but a lost one),
 * projects and job orders. Names and numbers only.
 */
cadJobOrderRoutes.get(
  '/options',
  requireAny(P.create, P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    const drawingTypes = await prisma.cadDrawingType.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (!customerId) {
      const customers = await prisma.customer.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 1000,
      });
      res.json({ customers, drawingTypes });
      return;
    }
    const [quotations, jobs, jobOrders] = await Promise.all([
      prisma.quotation.findMany({
        where: { customerId, outcome: { not: 'LOST' } },
        select: { id: true, number: true, subject: true, outcome: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.job.findMany({
        where: { customerId, status: { not: 'CANCELLED' } },
        select: { id: true, number: true, name: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.jobOrder.findMany({
        where: { customerId, status: { notIn: ['CANCELLED', 'REJECTED'] } },
        select: { id: true, number: true, projectName: true, title: true, status: true, quotationId: true, jobId: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    res.json({ drawingTypes, quotations, jobs, jobOrders });
  }),
);

// ── Create and edit ─────────────────────────────────────────────────────────

const cadSchema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  jobId: z.string().optional().nullable(),
  quotationId: z.string().optional().nullable(),
  jobOrderId: z.string().optional().nullable(),
  drawingTypeId: z.string().optional().nullable(),
  title: z.string().trim().min(3, 'Say in a line what drawing is wanted').max(300),
  scope: z.string().trim().min(5, 'Describe what the drawing should show').max(20000),
  neededBy: z.string().regex(DAY, 'Use a date').optional().nullable(),
  plannedStart: z.string().regex(DAY, 'Use a date').optional().nullable(),
  teamId: z.string().optional().nullable(),
  amount: z.number().min(0).optional().nullable(),
});

/** A team the body names must be active; none named is the requester's own. */
async function teamFor(teamId: string | null | undefined, requesterId: string): Promise<string | null> {
  if (teamId) {
    const team = await prisma.industry.findUnique({ where: { id: teamId }, select: { isActive: true } });
    if (!team?.isActive) throw badRequest('That team is not offered');
    return teamId;
  }
  return (await teamOf(requesterId))?.id ?? null;
}

/** Everything a body names belongs to the request's customer, and the drawing type is one that is offered. */
async function checkLinks(customerId: string, body: { jobId?: string | null; quotationId?: string | null; jobOrderId?: string | null; drawingTypeId?: string | null }) {
  const [customer, job, quotation, jobOrder, drawingType] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } }),
    body.jobId ? prisma.job.findUnique({ where: { id: body.jobId }, select: { customerId: true } }) : null,
    body.quotationId ? prisma.quotation.findUnique({ where: { id: body.quotationId }, select: { customerId: true } }) : null,
    body.jobOrderId ? prisma.jobOrder.findUnique({ where: { id: body.jobOrderId }, select: { customerId: true } }) : null,
    body.drawingTypeId ? prisma.cadDrawingType.findUnique({ where: { id: body.drawingTypeId }, select: { isActive: true } }) : null,
  ]);
  if (!customer) throw badRequest('That customer does not exist');
  if (body.jobId && job?.customerId !== customerId) throw badRequest('That project is for another customer');
  if (body.quotationId && quotation?.customerId !== customerId) throw badRequest('That quotation is for another customer');
  if (body.jobOrderId && jobOrder?.customerId !== customerId) throw badRequest('That job order is for another customer');
  if (body.drawingTypeId && !drawingType) throw badRequest('That drawing type does not exist');
  if (drawingType && !drawingType.isActive) throw badRequest('That drawing type is no longer offered');
}

cadJobOrderRoutes.post(
  '/',
  require_(P.create),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(cadSchema, req.body);
    await checkLinks(body.customerId, body);
    const neededBy = body.neededBy ? asDate(body.neededBy, 'Needed by') : null;
    const plannedStart = body.plannedStart ? asDate(body.plannedStart, 'Start date') : null;
    if (plannedStart && neededBy && plannedStart > neededBy) throw badRequest('The start date is after the target date to finish');
    const teamId = await teamFor(body.teamId, me.id);

    const row = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('cad_job_order', tx);
      return tx.cadJobOrder.create({
        data: {
          number,
          customerId: body.customerId,
          jobId: body.jobId || null,
          quotationId: body.quotationId || null,
          jobOrderId: body.jobOrderId || null,
          drawingTypeId: body.drawingTypeId || null,
          title: body.title,
          scope: body.scope,
          neededBy,
          plannedStart,
          requestedById: me.id,
          // A new request is a draft until it goes to the Team Leader (2026-10-16).
          status: 'DRAFT',
          teamId,
          amount: body.amount == null ? null : new Prisma.Decimal(body.amount),
        },
        include: cadInclude,
      });
    });

    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'CREATED', summary: `${row.number} — ${row.title} for ${row.customer.name}` }, req);
    res.status(201).json(present(row));
  }),
);

cadJobOrderRoutes.get(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    // The Team Leader deciding it may hold no CAD right: the decider's door.
    const reader = can(me, P.viewAll) || can(me, P.viewOwn);
    if (!(reader && mayOpen(me, row)) && !(await mayDecide(me.id, DOC, [row.id]))) throw forbidden('That is someone else’s CAD job order');
    const route = row.status === 'DRAFT' ? await routeBrief(DOC, row.amount == null ? null : Number(row.amount), row.requestedById) : null;

    const [revisions, comments] = await Promise.all([
      prisma.cadRevision.findMany({
        where: { cadJobOrderId: row.id },
        include: { submittedBy: { select: { id: true, name: true } } },
        orderBy: { sequence: 'desc' },
      }),
      prisma.cadComment.findMany({
        where: { cadJobOrderId: row.id },
        include: { author: { select: { id: true, name: true, photoPath: true } }, revision: { select: { id: true, sequence: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const [revisionFiles, commentFiles] = await Promise.all([
      filesFor('cad_revision', revisions.map((r) => r.id)),
      filesFor('cad_comment', comments.map((c) => c.id)),
    ]);

    res.json({
      ...present(row),
      ...flags(me, row),
      approvalRoute: route,
      revisions: revisions.map((r) => ({ ...r, label: `R${r.sequence}`, files: revisionFiles.get(r.id) ?? [] })),
      comments: comments.map((c) => ({ ...c, files: commentFiles.get(c.id) ?? [] })),
    });
  }),
);

/** The requestor (or the lead) corrects the request while it is open; the designer is told. */
cadJobOrderRoutes.patch(
  '/:id',
  requireAny(P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(cadSchema.omit({ customerId: true }).partial(), req.body);
    const existing = await load(req.params.id);
    if (!flags(me, existing).canEdit) {
      throw forbidden(CLOSED.includes(existing.status) ? 'A completed or cancelled request is a record' : 'Only whoever raised this request, or the Designer Lead, can change it');
    }
    await checkLinks(existing.customerId, {
      jobId: body.jobId !== undefined ? body.jobId : existing.jobId,
      quotationId: body.quotationId !== undefined ? body.quotationId : existing.quotationId,
      jobOrderId: body.jobOrderId !== undefined ? body.jobOrderId : existing.jobOrderId,
      drawingTypeId: body.drawingTypeId !== undefined ? body.drawingTypeId : existing.drawingTypeId,
    });
    const updated = await prisma.cadJobOrder.update({
      where: { id: existing.id },
      data: {
        ...(body.jobId !== undefined ? { jobId: body.jobId || null } : {}),
        ...(body.quotationId !== undefined ? { quotationId: body.quotationId || null } : {}),
        ...(body.jobOrderId !== undefined ? { jobOrderId: body.jobOrderId || null } : {}),
        ...(body.drawingTypeId !== undefined ? { drawingTypeId: body.drawingTypeId || null } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.neededBy !== undefined ? { neededBy: body.neededBy ? asDate(body.neededBy, 'Needed by') : null } : {}),
        ...(body.plannedStart !== undefined ? { plannedStart: body.plannedStart ? asDate(body.plannedStart, 'Start date') : null } : {}),
        ...(body.teamId !== undefined ? { teamId: await teamFor(body.teamId, existing.requestedById) } : {}),
        ...(body.amount !== undefined ? { amount: body.amount == null ? null : new Prisma.Decimal(body.amount) } : {}),
      },
      include: cadInclude,
    });
    await audit(
      { entityType: 'cad_job_order', entityId: updated.id, action: 'UPDATED', summary: `${updated.number} updated`, before: present(existing), after: present(updated) },
      req,
    );
    await tell([updated.assignedToId], { type: 'cad.updated', title: `${updated.number} was changed`, body: `${me.name} changed the request: ${updated.title}`, link: linkOf(updated.id) }, me.id);
    res.json(present(updated));
  }),
);

// ── Dispatch: take, assign ──────────────────────────────────────────────────

/** A designer takes an unassigned request from the queue; the lead and the requestor are told. */
cadJobOrderRoutes.post(
  '/:id/take',
  requireAny(P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!flags(me, row).canTake) {
      throw badRequest(row.assignedToId ? `${row.assignedTo?.name ?? 'Somebody'} already has it — the Designer Lead reassigns it` : 'This request cannot be taken now');
    }
    const claimed = await prisma.cadJobOrder.updateMany({
      where: { id: row.id, assignedToId: null },
      data: { assignedToId: me.id, assignedAt: new Date(), startedAt: row.startedAt ?? new Date(), ...(row.status === 'REQUESTED' ? { status: 'IN_PROGRESS' } : {}) },
    });
    if (claimed.count === 0) throw badRequest('Somebody took it a moment ago');
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} taken by ${me.name}` }, req);
    await tell([row.requestedById], { type: 'cad.assigned', title: `${row.number} is with ${me.name}`, body: `${row.title} — ${row.customer.name}`, link: linkOf(row.id) }, me.id);
    res.json(present(await load(row.id)));
  }),
);

/** The Designer Lead assigns, reassigns or unassigns. The designer must hold the design right. */
cadJobOrderRoutes.post(
  '/:id/assign',
  require_(P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ userId: z.string().optional().nullable() }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canAssign) throw badRequest('A completed or cancelled request is not assigned');
    let designer: { id: string; name: string } | null = null;
    if (body.userId) {
      const resolved = await resolveUser(body.userId);
      if (!resolved || !isDesigner(resolved)) throw badRequest('That person is not on the design team');
      designer = { id: resolved.id, name: resolved.name };
    }
    const updated = await prisma.cadJobOrder.update({
      where: { id: row.id },
      data: {
        assignedToId: designer?.id ?? null,
        assignedAt: designer ? new Date() : null,
        ...(designer && !row.startedAt ? { startedAt: new Date() } : {}),
        ...(designer && row.status === 'REQUESTED' ? { status: 'IN_PROGRESS' } : {}),
        ...(!designer && row.status === 'IN_PROGRESS' && row._count.revisions === 0 ? { status: 'REQUESTED', progressPct: 0 } : {}),
      },
      include: cadInclude,
    });
    await audit(
      {
        entityType: 'cad_job_order',
        entityId: row.id,
        action: 'UPDATED',
        summary: designer ? `${row.number} assigned to ${designer.name}${row.assignedTo ? ` (was ${row.assignedTo.name})` : ''}` : `${row.number} unassigned${row.assignedTo ? ` (was ${row.assignedTo.name})` : ''}`,
      },
      req,
    );
    if (designer) {
      await tell([designer.id], { type: 'cad.assigned', title: `${row.number} assigned to you`, body: `${row.title} — ${row.customer.name}${row.neededBy ? `, needed by ${formatDate(row.neededBy)}` : ''}`, link: linkOf(row.id) }, me.id);
    }
    await tell(
      [row.requestedById, row.assignedToId !== designer?.id ? row.assignedToId : null],
      { type: 'cad.assigned', title: designer ? `${row.number} is with ${designer.name}` : `${row.number} is waiting for a designer`, body: `${row.title} — ${row.customer.name}`, link: linkOf(row.id) },
      me.id,
    );
    res.json(present(updated));
  }),
);

// ── The designer's side: priority, progress, revisions ──────────────────────

cadJobOrderRoutes.post(
  '/:id/priority',
  requireAny(P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ priority: z.nativeEnum(CadPriority) }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canSetPriority) throw forbidden('Only the designer on it, or the Designer Lead, sets the priority');
    const updated = await prisma.cadJobOrder.update({ where: { id: row.id }, data: { priority: body.priority }, include: cadInclude });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} priority ${PRIORITY_LABEL[row.priority]} → ${PRIORITY_LABEL[body.priority]}` }, req);
    await tell([row.requestedById, row.assignedToId], { type: 'cad.updated', title: `${row.number} is now ${PRIORITY_LABEL[body.priority].toLowerCase()} priority`, body: `${row.title} — set by ${me.name}`, link: linkOf(row.id) }, me.id);
    res.json(present(updated));
  }),
);

cadJobOrderRoutes.post(
  '/:id/progress',
  requireAny(P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ progressPct: z.number().int().min(0).max(100) }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canProgress) throw badRequest('Progress is reported by the designer assigned to it while the drawing is in progress');
    // Reaching 100% puts it up for review (2026-10-16, the owner's sample).
    const done = body.progressPct === 100;
    const updated = await prisma.cadJobOrder.update({
      where: { id: row.id },
      data: { progressPct: body.progressPct, status: done ? 'FOR_REVIEW' : 'IN_PROGRESS' },
      include: cadInclude,
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} progress ${row.progressPct}% → ${body.progressPct}% by ${me.name}${done ? ' — for review' : ''}` }, req);
    if (done) {
      await tell([row.requestedById], { type: 'cad.revision', title: `${row.number} is ready for your review`, body: `${row.title} — ${me.name} reports it done`, link: linkOf(row.id) }, me.id);
    }
    res.json(present(updated));
  }),
);

/**
 * A revision: the files and a note of what changed. At least one PDF — the
 * output to the requestor is always a PDF (the owner's call); the AutoCAD or
 * SketchUp source may travel beside it. R0, R1, R2 … never overwritten.
 */
cadJobOrderRoutes.post(
  '/:id/revisions',
  requireAny(P.editAll, P.approve),
  cadUpload.array('files', 20),
  handler(async (req, res) => {
    const me = currentUser(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const body = parseBody(
        z.object({
          note: z.string().trim().min(2, 'Say what this revision covers or what changed').max(5000),
          externalUrl: z.string().trim().optional().nullable(),
        }),
        req.body,
      );
      const row = await load(req.params.id);
      if (!flags(me, row).canSubmitRevision) {
        throw badRequest(row.assignedToId ? 'Only the designer on it, or the Designer Lead, submits a revision' : 'Take the request first');
      }
      if (!files.some(isPdf)) throw badRequest('Attach the PDF output — the requestor always receives a PDF; the source files go with it');
      const externalUrl = body.externalUrl ? safeHttpUrl(body.externalUrl) : null;

      const revision = await prisma.$transaction(async (tx) => {
        const last = await tx.cadRevision.findFirst({ where: { cadJobOrderId: row.id }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
        const made = await tx.cadRevision.create({
          data: { cadJobOrderId: row.id, sequence: last ? last.sequence + 1 : 0, note: body.note, externalUrl, submittedById: me.id },
        });
        await tx.cadJobOrder.update({ where: { id: row.id }, data: { status: 'FOR_REVIEW', progressPct: 100 } });
        return made;
      });
      for (const file of files) {
        await saveAttachment({ entityType: 'cad_revision', entityId: revision.id, file, uploadedById: me.id });
      }
      await audit(
        { entityType: 'cad_job_order', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} R${revision.sequence} submitted (${files.length} file${files.length === 1 ? '' : 's'}): ${body.note}` },
        req,
      );
      await tell(
        [row.requestedById],
        { type: 'cad.revision', title: `${row.number} R${revision.sequence} is ready for your review`, body: `${row.title}: ${body.note}`, link: linkOf(row.id) },
        me.id,
      );
      res.status(201).json({ ...revision, label: `R${revision.sequence}` });
    } catch (err) {
      discard(files);
      throw err;
    }
  }),
);

// ── The requestor's side: accept, ask for changes ───────────────────────────

cadJobOrderRoutes.post(
  '/:id/accept',
  requireAny(P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ note: z.string().trim().max(5000).optional().nullable() }), req.body);
    const row = await load(req.params.id);
    const f = flags(me, row);
    if (!f.canAccept) throw badRequest(row.status === 'FOR_REVIEW' ? 'Only whoever raised this request, its designer or the Designer Lead can close it' : 'Nothing is waiting to be accepted');
    const requestor = isRequestor(me, row);
    // A designer closing it on the requestor's behalf says why.
    if (!requestor && !body.note?.trim()) throw badRequest('Say why it is being closed without the requestor’s acceptance');
    const claimed = await prisma.cadJobOrder.updateMany({
      where: { id: row.id, status: 'FOR_REVIEW' },
      data: { status: 'COMPLETED', completedAt: new Date(), completedById: me.id, completionNote: body.note?.trim() || null, progressPct: 100 },
    });
    if (claimed.count === 0) throw badRequest('Somebody changed it a moment ago');
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'COMPLETED', summary: `${row.number} ${requestor ? 'accepted' : 'closed'} by ${me.name}${body.note ? `: ${body.note}` : ''}` }, req);
    await tell(
      [row.requestedById, row.assignedToId],
      { type: 'cad.updated', title: `${row.number} ${requestor ? 'accepted' : 'closed'}`, body: `${row.title} — ${me.name}${body.note ? `: ${body.note}` : ''}`, link: linkOf(row.id) },
      me.id,
    );
    res.json(present(await load(row.id)));
  }),
);

/** The requestor asks for changes: a comment on the latest revision, and the drawing goes back to the designer. */
cadJobOrderRoutes.post(
  '/:id/changes',
  requireAny(P.editOwn, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ comment: z.string().trim().min(3, 'Say what should change').max(20000) }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canRequestChanges) throw badRequest(row.status === 'FOR_REVIEW' ? 'Only whoever raised this request, or the Designer Lead, asks for changes' : 'Nothing is under review');
    const latest = await prisma.cadRevision.findFirst({ where: { cadJobOrderId: row.id }, orderBy: { sequence: 'desc' }, select: { id: true, sequence: true } });
    const comment = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cadJobOrder.updateMany({ where: { id: row.id, status: 'FOR_REVIEW' }, data: { status: 'CHANGES_REQUESTED' } });
      if (claimed.count === 0) throw badRequest('Somebody changed it a moment ago');
      return tx.cadComment.create({
        data: { cadJobOrderId: row.id, revisionId: latest?.id ?? null, authorId: me.id, body: body.comment, isChangeRequest: true },
      });
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'RETURNED', summary: `${row.number} changes requested on R${latest?.sequence ?? 0}: ${body.comment}` }, req);
    await tell(
      [row.assignedToId],
      { type: 'cad.comment', title: `${row.number}: changes requested`, body: `${me.name}: ${body.comment}`, link: linkOf(row.id) },
      me.id,
    );
    res.status(201).json({ ...comment, status: 'CHANGES_REQUESTED' });
  }),
);

// ── Hold, resume, cancel ────────────────────────────────────────────────────

cadJobOrderRoutes.post(
  '/:id/hold',
  requireAny(P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is on hold').max(2000) }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canHold) throw badRequest('This request cannot be put on hold now');
    const updated = await prisma.cadJobOrder.update({
      where: { id: row.id },
      data: { status: 'ON_HOLD', statusBeforeHold: row.status, holdReason: body.reason },
      include: cadInclude,
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} on hold: ${body.reason}` }, req);
    await tell([row.requestedById, row.assignedToId], { type: 'cad.updated', title: `${row.number} is on hold`, body: `${me.name}: ${body.reason}`, link: linkOf(row.id) }, me.id);
    res.json(present(updated));
  }),
);

cadJobOrderRoutes.post(
  '/:id/resume',
  requireAny(P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!flags(me, row).canResume) throw badRequest('This request is not on hold');
    const back = row.statusBeforeHold && row.statusBeforeHold !== 'ON_HOLD' ? row.statusBeforeHold : row.assignedToId ? 'IN_PROGRESS' : 'REQUESTED';
    const updated = await prisma.cadJobOrder.update({
      where: { id: row.id },
      data: { status: back, statusBeforeHold: null, holdReason: null },
      include: cadInclude,
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} resumed — ${STATUS_LABEL[back]}` }, req);
    await tell([row.requestedById, row.assignedToId], { type: 'cad.updated', title: `${row.number} resumed`, body: `${row.title} — ${STATUS_LABEL[back].toLowerCase()}`, link: linkOf(row.id) }, me.id);
    res.json(present(updated));
  }),
);

/**
 * Deletes a CANCELLED request — its requestor or the Designer Lead, with the
 * delete right. Its revisions and comments cascade; their files go too. A
 * plan already filed from it stays the project's.
 */
cadJobOrderRoutes.delete(
  '/:id',
  require_(P.delete),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!flags(me, row).canDelete) {
      throw badRequest(row.status !== 'CANCELLED' && row.status !== 'DRAFT' ? 'Only a draft or a cancelled request can be deleted — cancel it first' : 'Only whoever raised this request, or the Designer Lead, deletes it');
    }
    const [revisions, comments] = await Promise.all([
      prisma.cadRevision.findMany({ where: { cadJobOrderId: row.id }, select: { id: true } }),
      prisma.cadComment.findMany({ where: { cadJobOrderId: row.id }, select: { id: true } }),
    ]);
    await deleteOrRefuse(row.number, () => prisma.cadJobOrder.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf('cad_revision', revisions.map((r) => r.id));
    await deleteAttachmentsOf('cad_comment', comments.map((c) => c.id));
    await deleteAttachmentsOf('cad_job_order', [row.id]);
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'DELETED', summary: `Deleted cancelled request ${row.number} — ${row.title}` }, req);
    res.json({ ok: true });
  }),
);

cadJobOrderRoutes.post(
  '/:id/cancel',
  requireAny(P.editOwn, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled').max(2000) }), req.body);
    const row = await load(req.params.id);
    if (!flags(me, row).canCancel) {
      throw badRequest(CLOSED.includes(row.status) ? 'This request is already closed' : 'Only whoever raised this request, or the Designer Lead, cancels it');
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.cadJobOrder.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason } });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      if (row.status === 'PENDING_APPROVAL') await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${body.reason}` }, req);
    await tell([row.requestedById, row.assignedToId], { type: 'cad.updated', title: `${row.number} cancelled`, body: `${me.name}: ${body.reason}`, link: linkOf(row.id) }, me.id);
    res.json({ ok: true });
  }),
);

// ── The Team Leader's approval (2026-10-16) ─────────────────────────────────

/** Into the designers' queue: every designer hears of it. */
async function intoQueue(row: CadRow, actorId: string | null) {
  await tell(
    await designTeam(),
    {
      type: 'cad.requested',
      title: `New CAD job order ${row.number}`,
      body: `${row.title} — ${row.customer.name}, requested by ${row.requestedBy.name}${row.neededBy ? `, needed by ${formatDate(row.neededBy)}` : ''}`,
      link: linkOf(row.id),
    },
    actorId,
  );
}

/**
 * "Request for Approval": the draft goes to the requester's Team Leader
 * through the one engine, filed in the REQUESTER's name. With the route
 * switched off it goes straight into the designers' queue.
 */
cadJobOrderRoutes.post(
  '/:id/submit',
  requireAny(P.create, P.editOwn, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!flags(me, row).canSubmit) throw badRequest(row.status === 'DRAFT' ? 'Only whoever raised this request sends it for approval' : 'Only a draft is sent for approval');
    const amount = row.amount == null ? null : Number(row.amount);
    if (!(await pickWorkflow(DOC, amount, { requesterId: row.requestedById }))) {
      const claimed = await prisma.cadJobOrder.updateMany({ where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt }, data: { status: 'REQUESTED' } });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent to the design team (no approval route)` }, req);
      await intoQueue(row, me.id);
      return res.json({ ok: true, status: 'REQUESTED' });
    }
    const claimed = await prisma.cadJobOrder.updateMany({ where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: row.number,
        subject: subjectOf(row),
        amount,
        link: linkOf(row.id),
        requesterId: row.requestedById,
        jobId: row.jobId,
      });
    } catch (err) {
      await prisma.cadJobOrder.update({ where: { id: row.id }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent for the Team Leader's approval` }, req);
    res.json({ ok: true, status: 'PENDING_APPROVAL' });
  }),
);

/** Pulled back to draft before the Team Leader decides. */
cadJobOrderRoutes.post(
  '/:id/withdraw',
  requireAny(P.create, P.editOwn, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!flags(me, row).canWithdraw) throw badRequest('Only a request waiting for approval is pulled back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.cadJobOrder.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json({ ok: true });
  }),
);

/** The Team Leader's decision: approved goes into the queue; returned or rejected back to draft. */
export async function settleCadJobOrder(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.cadJobOrder.findUnique({ where: { id: approval.documentId }, include: cadInclude });
  if (!row) return;
  const next = outcome === 'APPROVED' ? 'REQUESTED' : 'DRAFT';
  const claimed = await prisma.cadJobOrder.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: next } });
  await audit({
    entityType: 'cad_job_order',
    entityId: row.id,
    action: outcome,
    summary: claimed.count
      ? outcome === 'APPROVED'
        ? `${row.number} approved — into the designers' queue`
        : `${row.number} ${outcome.toLowerCase()} — back to draft`
      : `${row.number} ${outcome.toLowerCase()} after it was ${STATUS_LABEL[row.status].toLowerCase()} — not applied`,
  });
  if (claimed.count && outcome === 'APPROVED') await intoQueue(row, null);
}
onApprovalSettled(DOC, settleCadJobOrder);

/**
 * Pulled back after the Team Leader's approval (2026-10-16): back to DRAFT,
 * out of the designers' queue — only while nobody has started on it: still
 * REQUESTED, no designer given or taking it, no revision drawn. Once design
 * work has started it is refused; cancel it or put it on hold instead.
 */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const row = await prisma.cadJobOrder.findUnique({ where: { id }, select: { status: true, requestedById: true } });
    // Any request past its approval: one the designers have started is
    // refused by `reopen`, naming why, rather than hiding the button.
    return !!row && !BEFORE_QUEUE.includes(row.status) && (isRequestor(actor, row) || isLead(actor) || actor.isSuperAdmin);
  },
  reopen: async ({ documentId, tx }) => {
    const row = await tx.cadJobOrder.findUnique({
      where: { id: documentId },
      select: { id: true, number: true, status: true, assignedToId: true, startedAt: true, _count: { select: { revisions: true } } },
    });
    if (!row) throw notFound('CAD job order not found');
    if (row.status !== 'REQUESTED' || row.assignedToId || row.startedAt || row._count.revisions) {
      throw badRequest(
        `${row.number} is already with the design team (${STATUS_LABEL[row.status].toLowerCase()}${row.assignedToId ? ', a designer on it' : ''}${row._count.revisions ? `, ${row._count.revisions} revision${row._count.revisions === 1 ? '' : 's'} drawn` : ''}) — it cannot go back to draft; cancel it or put it on hold instead`,
      );
    }
    const claimed = await tx.cadJobOrder.updateMany({
      where: { id: row.id, status: 'REQUESTED', assignedToId: null, startedAt: null },
      data: { status: 'DRAFT', progressPct: 0 },
    });
    if (!claimed.count) throw badRequest('A designer took it a moment ago — it cannot go back to draft');
  },
});

// ── The thread ──────────────────────────────────────────────────────────────

/** A comment, with files if any, naming a revision if it is about one. The other side is told. */
cadJobOrderRoutes.post(
  '/:id/comments',
  requireAny(P.viewAll, P.viewOwn),
  cadUpload.array('files', 10),
  handler(async (req, res) => {
    const me = currentUser(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      const body = parseBody(
        z.object({ body: z.string().trim().min(1, 'Write something').max(20000), revisionId: z.string().optional().nullable() }),
        req.body,
      );
      const row = await load(req.params.id);
      if (!mayOpen(me, row)) throw forbidden('That is someone else’s CAD job order');
      if (!flags(me, row).canComment) throw badRequest('This request is closed');
      if (body.revisionId) {
        const rev = await prisma.cadRevision.findFirst({ where: { id: body.revisionId, cadJobOrderId: row.id }, select: { id: true } });
        if (!rev) throw badRequest('That revision is not on this request');
      }
      const comment = await prisma.cadComment.create({
        data: { cadJobOrderId: row.id, revisionId: body.revisionId || null, authorId: me.id, body: body.body },
        include: { author: { select: { id: true, name: true, photoPath: true } }, revision: { select: { id: true, sequence: true } } },
      });
      for (const file of files) {
        await saveAttachment({ entityType: 'cad_comment', entityId: comment.id, file, uploadedById: me.id });
      }
      await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'UPDATED', summary: `${row.number}: ${body.body.slice(0, 200)}` }, req);
      // The requestor and the designer hear each other; a third party's comment reaches both.
      await tell(
        [row.requestedById, row.assignedToId],
        { type: 'cad.comment', title: `${row.number}: ${me.name} commented`, body: body.body.slice(0, 500), link: linkOf(row.id) },
        me.id,
      );
      const saved = await filesFor('cad_comment', [comment.id]);
      res.status(201).json({ ...comment, files: saved.get(comment.id) ?? [] });
    } catch (err) {
      discard(files);
      throw err;
    }
  }),
);

// ── Hand-off: raise the accepted revision as a Request for Approval ─────────

/**
 * One click raises the accepted revision as a Request for Approval on the
 * linked project (2026-10-13; "file as approved plan" before): a DRAFT
 * request with the request's number as the drawing reference, `R<n>` as the
 * revision and the revision's files copied onto it — `requestFromCad()`, the
 * same function the request form's "From a CAD J.O." uses. The requester then
 * submits it on its own page, where the approval route decides it.
 */
cadJobOrderRoutes.post(
  '/:id/file-plan',
  requireAny(P.editOwn, P.editAll, P.approve),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(2).max(300).optional().nullable(),
        description: z.string().trim().max(5000).optional().nullable(),
        discipline: z.string().trim().max(80).optional().nullable(),
      }),
      req.body,
    );
    const row = await load(req.params.id);
    if (!flags(me, row).canFilePlan) {
      throw badRequest(
        row.approvedPlanId
          ? 'This drawing has already been raised for approval'
          : !row.jobId
            ? 'Link the request to a project first'
            : row.status !== 'COMPLETED'
              ? 'Only an accepted drawing is raised for approval'
              : 'Only whoever raised this request, its designer or the Designer Lead raises it for approval',
      );
    }
    const { plan, revision } = await requestFromCad(row.id, row.jobId!, me, {
      title: body.title ?? undefined,
      description: body.description ?? undefined,
      discipline: body.discipline ?? undefined,
    });
    await audit({ entityType: 'approved_plan', entityId: plan.id, action: 'CREATED', summary: `Raised ${plan.number} for ${row.job?.number ?? 'the project'} from CAD job order ${row.number} R${revision}` }, req);
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'CONVERTED', summary: `${row.number} R${revision} raised for approval as ${plan.number}` }, req);
    res.status(201).json(plan);
  }),
);

// ── The paper ───────────────────────────────────────────────────────────────

cadJobOrderRoutes.get(
  '/:id/pdf',
  requireAny(P.viewAll, P.viewOwn),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!mayOpen(me, row)) throw forbidden('That is someone else’s CAD job order');
    const [revisions, comments] = await Promise.all([
      prisma.cadRevision.findMany({ where: { cadJobOrderId: row.id }, include: { submittedBy: { select: { id: true, name: true } } }, orderBy: { sequence: 'asc' } }),
      prisma.cadComment.findMany({ where: { cadJobOrderId: row.id }, include: { author: { select: { name: true } }, revision: { select: { sequence: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const revisionFiles = await filesFor('cad_revision', revisions.map((r) => r.id));
    // The contact lines under each sign-off, for the paper only (the JSON
    // never carries a mobile).
    const latest = revisions.length ? revisions[revisions.length - 1] : null;
    const contacts = await contactsOf([row.requestedById, row.assignedToId, row.completedById, latest?.submittedBy.id]);

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'The request',
        columns: 2,
        fields: [
          { label: 'Drawing', value: row.title },
          { label: 'Drawing type', value: row.drawingType?.name ?? '—' },
          { label: 'Customer', value: row.customer.name },
          { label: 'Project', value: row.job ? `${row.job.number} — ${row.job.name}` : '—' },
          { label: 'Quotation', value: row.quotation ? `${row.quotation.number} — ${row.quotation.subject}` : '—' },
          { label: 'Job order', value: row.jobOrder ? `${row.jobOrder.number} — ${row.jobOrder.projectName ?? row.jobOrder.title}` : '—' },
          // The name only: the dated "Requested by" sign-off says when, in
          // Manila, so the paper never carries two dates for one request.
          { label: 'Requested by', value: row.requestedBy.name },
          { label: 'Start date', value: row.plannedStart ? formatDate(row.plannedStart) : '—' },
          { label: 'Needed by', value: row.neededBy ? formatDate(row.neededBy) : '—' },
          { label: 'Designer', value: row.assignedTo?.name ?? 'Open' },
          { label: 'Priority', value: statusLabel(row.priority) },
          { label: 'Status', value: statusLabel(row.status) },
          { label: 'Progress', value: `${row.progressPct}%` },
        ],
      },
      { kind: 'text', title: 'Scope of the drawing', body: row.scope },
      // A table of one row of dashes says less than a sentence does.
      revisions.length
        ? {
            kind: 'table',
            title: 'Revisions',
            head: ['Revision', 'Submitted', 'By', 'What changed', 'Files'],
            rows: revisions.map((r) => [
              `R${r.sequence}`,
              formatDateTime(r.submittedAt),
              r.submittedBy.name,
              r.note,
              [...(revisionFiles.get(r.id) ?? []).map((f) => f.fileName), ...(r.externalUrl ? [r.externalUrl] : [])].join('\n') || '—',
            ]),
          }
        : { kind: 'text', title: 'Revisions', body: 'No revision submitted yet.' },
    ];
    if (comments.length) {
      sections.push({
        kind: 'table',
        title: 'Thread',
        head: ['When', 'Who', 'Comment'],
        widths: [1.6, 1.6, 6.8],
        rows: comments.map((c) => [formatDateTime(c.createdAt), c.author.name, `${c.isChangeRequest ? 'Changes requested' : ''}${c.revision ? ` (R${c.revision.sequence})` : ''}${c.isChangeRequest || c.revision ? ': ' : ''}${c.body}`]),
      });
    }
    if (row.status === 'CANCELLED' && row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    if (row.status === 'ON_HOLD' && row.holdReason) sections.push({ kind: 'text', title: 'On hold', body: row.holdReason });

    // No route: the three sign-offs of what actually happened, each dated —
    // and never a slot nobody is named for. Requested by the requestor, when
    // raised. Drawn by whoever submitted the latest revision, when; before
    // one exists, the designer on it with "Pending" under their name, and no
    // slot at all while nobody has taken it. Accepted by the requestor, when
    // they did — "Closed by" the designer or the lead who closed it instead —
    // and until then the requestor's name over "Pending", for it is theirs
    // to accept. A cancelled request fills nothing more, so its unfilled
    // slots are left out rather than printed "Pending" for ever.
    const cancelled = row.status === 'CANCELLED';
    const signer = (role: string, id: string | null | undefined, name: string | undefined, at?: Date | null): Signatory => {
      const c = id ? contacts.get(id) : undefined;
      return { role, name, phone: c?.phone, email: c?.email, at: at ?? undefined };
    };
    const signatories: Signatory[] = [signer('Requested by', row.requestedById, row.requestedBy.name, row.createdAt)];
    if (latest) signatories.push(signer('Drawn by', latest.submittedBy.id, latest.submittedBy.name, latest.submittedAt));
    else if (row.assignedTo && !cancelled) signatories.push(signer('Drawn by', row.assignedToId, row.assignedTo.name));
    if (row.completedBy) {
      signatories.push(
        signer(row.completedById !== row.requestedById ? 'Closed by' : 'Accepted by', row.completedById, row.completedBy.name, row.completedAt),
      );
    } else if (!cancelled) {
      signatories.push(signer('Accepted by', row.requestedById, row.requestedBy.name));
    }
    const pdf = await renderDocument({
      title: 'CAD Job Order',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${row.title} — ${row.customer.name}`,
      sections,
      signatories,
    });
    await audit({ entityType: 'cad_job_order', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'CAD Job Order', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: 'cad_job_order',
  label: 'CAD job orders',
  permission: [P.viewAll, P.viewOwn],
  ownWhere: (user) => mineWhere(user.id),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.cadJobOrder.findMany({
      where: {
        AND: [
          own ?? {},
          {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { title: { contains: term, mode: 'insensitive' } },
              { customer: { name: { contains: term, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, title: true, status: true, customer: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: 'cad_job_order',
      id: r.id,
      title: `${r.number} — ${r.title}`,
      subtitle: `${r.customer.name} · ${STATUS_LABEL[r.status].toLowerCase()}`,
      link: linkOf(r.id),
    }));
  },
});
