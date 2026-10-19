import { Router } from 'express';
import { z } from 'zod';
import { Prisma, PlanStatus, type ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, idsFilter, notFound, badRequest, forbidden, deleteOrRefuse } from '../http/kit';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import {
  approvalSlots,
  cancelOpenRequest,
  contactOf,
  mayDecide,
  onApprovalSettled,
  onApprovalReopened,
  preparedAt,
  routeBrief,
  slotSignatories,
  submitForApproval,
  type ApprovalOutcome,
} from '../shared/approvals';
import { registerAttachmentGuard, deleteAttachmentsOf } from '../shared/attachments';
import { attachedFiles, copyAttachments, withAttachments } from '../shared/pdfAttachments';
import { registerSearch } from '../shared/search';
import { renderDocument, formatDate, formatMoney, formatShortDate, statusLabel, companyCurrency, type PdfSection, type Signatory } from '../shared/pdf';
import { LIST_CAP, listReference, recordNamed, choice, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { visibleOwners } from '../shared/team';

/**
 * REQUEST FOR APPROVAL (2026-10-13, the owner's call: "replace the Approved
 * Plans with Request for Approval — a form with internal approval: Technical
 * Manager, Team Leader, and the CEO above ₱1,000,000 of project costing — and
 * a drawing reference number, which could come from a CAD J.O.").
 *
 * The record is the old `ApprovedPlan` row and its keys (`gops.plans.*`), a
 * routed document now: DRAFT → PENDING_APPROVAL → APPROVED, through the one
 * engine as `plan_approval` (rule 2). Nobody approves one by hand any more —
 * the old `PATCH /jobs/:jobId/plans/:planId { status }` is gone. The amount
 * the route is chosen by is the PROJECT's contract value, snapshotted at
 * submit; the seeded routes are Technical Manager › Team Leader, and the
 * CEO / President too above ₱1,000,000, with `preparerSigns` and `standIns`
 * as the costing's. A return or a rejection sends it back to DRAFT for a new
 * drawing; approving one SUPERSEDES any earlier approved request on the same
 * project and drawing reference.
 */

export const planApprovalRoutes = Router();
planApprovalRoutes.use(authenticate);

const DOC = 'plan_approval';
const VIEW = ['gops.plans.view_all', 'gops.plans.view_own'];
export const PLAN_LINK = (id: string) => `/g-ops/plans/${id}`;

const planInclude = {
  job: {
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      contractValue: true,
      customer: { select: { id: true, name: true } },
    },
  },
  uploadedBy: { select: { id: true, name: true, email: true, position: true } },
  cadJobOrder: { select: { id: true, number: true, title: true } },
} satisfies Prisma.ApprovedPlanInclude;

type PlanRow = Prisma.ApprovedPlanGetPayload<{ include: typeof planInclude }>;

const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

/** Statuses still in the requester's hands: a draft, or one registered before 2026-10-13. */
const EDITABLE: PlanStatus[] = ['DRAFT', 'FOR_APPROVAL'];

/** "CJO-2026-0012 · R2" — the drawing reference as it prints. */
export function referenceOf(p: { drawingNo: string | null; revision: string }): string {
  return [p.drawingNo, p.revision && p.revision !== '0' ? (/^r/i.test(p.revision) ? p.revision : `Rev ${p.revision}`) : null].filter(Boolean).join(' · ');
}

/** view_all, the person who raised it, or — while it waits on them — whoever may decide it. */
async function mayRead(me: ResolvedUser, row: { id: string; uploadedById: string }, deciderOnly = false): Promise<boolean> {
  if (!deciderOnly && (me.isSuperAdmin || can(me, 'gops.plans.view_all') || visibleOwners(me, 'gops', 'plans').includes(row.uploadedById))) return true;
  return mayDecide(me.id, DOC, [row.id]);
}

async function loadVisible(me: ResolvedUser, id: string, deciderOnly = false): Promise<PlanRow> {
  const row = await prisma.approvedPlan.findUnique({ where: { id }, include: planInclude });
  if (!row || !(await mayRead(me, row, deciderOnly))) throw notFound('Request for approval not found');
  return row;
}

const mayEdit = (me: ResolvedUser, row: { uploadedById: string }) => canEditRecord(me, 'gops', 'plans', row.uploadedById);

/** The record as the page reads it, and what the viewer may do with it. */
async function present(me: ResolvedUser, row: PlanRow) {
  const editable = EDITABLE.includes(row.status);
  const editor = mayEdit(me, row);
  const contractValue = num(row.job.contractValue);
  return {
    ...row,
    amount: row.amount == null ? null : num(row.amount),
    job: { ...row.job, contractValue },
    requestedBy: row.uploadedBy,
    reference: referenceOf(row),
    canEdit: editable && editor,
    canSubmit: editable && editor,
    canWithdraw: row.status === 'PENDING_APPROVAL' && editor,
    canCancel: (editable || row.status === 'PENDING_APPROVAL') && editor,
    canDelete: (editable || row.status === 'CANCELLED') && editor && can(me, 'gops.plans.delete'),
    // The route a draft WOULD take, by name — the project's contract value
    // picks the band, as the submit will.
    approvalRoute: editable ? await routeBrief(DOC, contractValue, row.uploadedById, null, { jobId: row.jobId }) : null,
  };
}

// The drawings are read by whoever may read the request, and change only on
// a draft, in the hands of whoever may edit it — what the approvers decide on
// is what they were sent.
registerAttachmentGuard(
  'approved_plan',
  async (user, id) => {
    const row = await prisma.approvedPlan.findUnique({ where: { id }, select: { id: true, uploadedById: true } });
    return !!row && (await mayRead(user, row));
  },
  {
    write: async (user, id) => {
      const row = await prisma.approvedPlan.findUnique({ where: { id }, select: { status: true, uploadedById: true } });
      return !!row && EDITABLE.includes(row.status) && mayEdit(user, row);
    },
  },
);

// ── List ─────────────────────────────────────────────────────────────────────

/** The list's where-builder — the register, the project tab's own query and the paper read it. */
export function planListWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>) {
  const and: Prisma.ApprovedPlanWhereInput[] = [];
  const seesAll = me.isSuperAdmin || can(me, 'gops.plans.view_all');
  const mine = !seesAll || q.scope === 'mine';
  if (q.scope === 'mine') and.push({ uploadedById: me.id });
  else if (mine) and.push({ uploadedById: { in: visibleOwners(me, 'gops', 'plans') } });
  if (q.filters.jobId) and.push({ jobId: q.filters.jobId });
  const status = choice(q.filters.status, PlanStatus, 'Status');
  if (status) and.push({ status });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { drawingNo: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
        { job: { number: { contains: q.search, mode: 'insensitive' } } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
      ],
    });
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  return { where: { AND: and } as Prisma.ApprovedPlanWhereInput, mine, status };
}

const SORTS = ['number', 'title', 'drawingNo', 'status', 'createdAt'];

planApprovalRoutes.get(
  '/',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = planListWhere(me, q);
    const [rows, total] = await Promise.all([
      prisma.approvedPlan.findMany({
        where,
        include: planInclude,
        orderBy: orderBy(q, SORTS, { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.approvedPlan.count({ where }),
    ]);
    res.json(
      listResult(
        rows.map((r) => ({ ...r, amount: r.amount == null ? null : num(r.amount), job: { ...r.job, contractValue: num(r.job.contractValue) }, requestedBy: r.uploadedBy, reference: referenceOf(r) })),
        total,
        q,
      ),
    );
  }),
);

/** The register on paper — the list as filtered, or the rows ticked. Above `/:id`. */
planApprovalRoutes.get(
  '/pdf',
  requireAny(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where, mine, status } = planListWhere(me, q);
    const [rows, count, project] = await Promise.all([
      prisma.approvedPlan.findMany({ where, include: planInclude, orderBy: orderBy(q, SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.approvedPlan.count({ where }),
      recordNamed('project', q.filters.jobId),
    ]);
    const reference = listReference(count, rows.length, ['request for approval', 'requests for approval'], [
      q.search && `search "${q.search}"`,
      status && `status ${statusLabel(status)}`,
      project,
      mine && 'raised by me',
      q.filters.ids && 'the rows selected',
    ]);
    const pdf = await renderDocument({
      title: 'Requests for Approval',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Request', 'Drawing reference', 'Project', 'Requested by', 'Raised', 'Approved', 'Status'],
          rows: rows.map((r) => [
            r.number ?? '—',
            r.description ? { title: r.title, body: r.description } : r.title,
            referenceOf(r) || '—',
            { title: r.job.number, body: r.job.name },
            r.uploadedBy.name,
            formatShortDate(r.createdAt),
            r.approvedAt ? formatShortDate(r.approvedAt) : '',
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: 'approved_plan', entityId: 'list', action: 'EXPORTED', summary: `Exported the requests for approval as PDF (${rows.length})` }, req);
    sendListPdf(res, pdf, 'requests-for-approval.pdf');
  }),
);

/**
 * The project's accepted CAD drawings not yet raised for approval — what the
 * form's "From a CAD J.O." picker offers. Above `/:id`.
 */
planApprovalRoutes.get(
  '/cad-options',
  require_('gops.plans.create'),
  handler(async (req, res) => {
    const jobId = String(req.query.jobId ?? '');
    if (!jobId) throw badRequest('Which project?');
    const rows = await prisma.cadJobOrder.findMany({
      where: { jobId, status: 'COMPLETED', approvedPlanId: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        title: true,
        drawingType: { select: { name: true } },
        revisions: { orderBy: { sequence: 'desc' }, take: 1, select: { sequence: true } },
      },
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        drawingType: r.drawingType?.name ?? null,
        revision: r.revisions[0] ? `R${r.revisions[0].sequence}` : null,
      })),
    );
  }),
);

// ── One ──────────────────────────────────────────────────────────────────────

planApprovalRoutes.get(
  '/:id',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    res.json(await present(me, row));
  }),
);

const planSchema = z.object({
  title: z.string().trim().min(2, 'Say what is to be approved').max(300),
  description: z.string().trim().max(5000).optional().nullable(),
  drawingNo: z.string().trim().max(80).optional().nullable(),
  revision: z.string().trim().max(20).optional().nullable(),
  discipline: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

/**
 * A request raised from a CAD J.O.'s accepted drawing (2026-10-09's "file as
 * approved plan", now a DRAFT request): its number as the drawing reference,
 * `R<n>` as the revision, the drawing type as the discipline, and the
 * revision's files COPIED onto the request — a copy, because deleting an
 * attachment row unlinks its bytes and the revision keeps its own. The one
 * way both doors (the CAD J.O. page and the request form) raise it.
 */
export async function requestFromCad(
  cadJobOrderId: string,
  jobId: string,
  me: { id: string },
  fields: Partial<z.infer<typeof planSchema>> = {},
) {
  const cad = await prisma.cadJobOrder.findUnique({
    where: { id: cadJobOrderId },
    select: { id: true, number: true, title: true, jobId: true, status: true, approvedPlanId: true, drawingType: { select: { name: true } } },
  });
  if (!cad) throw notFound('CAD job order not found');
  if (cad.jobId !== jobId) throw badRequest(`${cad.number} is for another project`);
  if (cad.status !== 'COMPLETED') throw badRequest(`${cad.number} has no accepted drawing yet`);
  if (cad.approvedPlanId) throw badRequest(`${cad.number} has already been raised for approval`);
  const latest = await prisma.cadRevision.findFirst({ where: { cadJobOrderId: cad.id }, orderBy: { sequence: 'desc' } });
  if (!latest) throw badRequest(`${cad.number} has no revision to raise`);

  const plan = await prisma.$transaction(async (tx) => {
    // Claimed on the link: two clicks raise one request.
    const made = await tx.approvedPlan.create({
      data: {
        number: await nextNumber(DOC, tx),
        jobId,
        title: fields.title?.trim() || cad.title,
        description: fields.description?.trim() || null,
        drawingNo: cad.number,
        revision: `R${latest.sequence}`,
        discipline: fields.discipline?.trim() || cad.drawingType?.name || null,
        notes: fields.notes?.trim() || `From CAD job order ${cad.number}: ${latest.note}`,
        uploadedById: me.id,
      },
    });
    const linked = await tx.cadJobOrder.updateMany({ where: { id: cad.id, approvedPlanId: null }, data: { approvedPlanId: made.id } });
    if (!linked.count) throw badRequest(`${cad.number} has already been raised for approval`);
    return made;
  });
  await copyAttachments({ entityType: 'cad_revision', entityId: latest.id }, { entityType: 'approved_plan', entityId: plan.id }, `From ${cad.number} R${latest.sequence}`, me.id);
  return { plan, cad, revision: latest.sequence };
}

planApprovalRoutes.post(
  '/',
  require_('gops.plans.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(planSchema.extend({ jobId: z.string().min(1, 'Which project?'), cadJobOrderId: z.string().optional().nullable() }), req.body);
    const job = await prisma.job.findUnique({ where: { id: body.jobId }, select: { id: true, number: true, status: true } });
    if (!job) throw notFound('Project not found');
    if (job.status === 'CANCELLED') throw badRequest(`${job.number} is cancelled`);

    let plan;
    if (body.cadJobOrderId) {
      const made = await requestFromCad(body.cadJobOrderId, job.id, me, body);
      plan = made.plan;
      await audit({ entityType: 'cad_job_order', entityId: made.cad.id, action: 'CONVERTED', summary: `${made.cad.number} R${made.revision} raised for approval as ${plan.number}` }, req);
    } else {
      plan = await prisma.$transaction(async (tx) =>
        tx.approvedPlan.create({
          data: {
            number: await nextNumber(DOC, tx),
            jobId: job.id,
            title: body.title,
            description: body.description || null,
            drawingNo: body.drawingNo || null,
            revision: body.revision || '0',
            discipline: body.discipline || null,
            notes: body.notes || null,
            uploadedById: me.id,
          },
        }),
      );
    }
    await audit({ entityType: 'approved_plan', entityId: plan.id, action: 'CREATED', summary: `Raised ${plan.number} for ${job.number}: ${plan.title}` }, req);
    res.status(201).json(await present(me, await loadVisible(me, plan.id)));
  }),
);

planApprovalRoutes.put(
  '/:id',
  requireAny('gops.plans.edit_own', 'gops.plans.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(planSchema, req.body);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can change it');
    if (!EDITABLE.includes(row.status)) throw badRequest('Only a draft can be changed — pull it back first');
    const claimed = await prisma.approvedPlan.updateMany({
      where: { id: row.id, status: { in: EDITABLE } },
      data: {
        title: body.title,
        description: body.description || null,
        drawingNo: body.drawingNo || null,
        revision: body.revision || '0',
        discipline: body.discipline || null,
        notes: body.notes || null,
      },
    });
    if (!claimed.count) throw badRequest('It was submitted a moment ago — reload');
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'UPDATED', summary: `${row.number ?? row.title} changed` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

/**
 * Submitting: claimed on DRAFT, the project's contract value snapshotted as
 * the amount, the request filed in the requester's name whoever presses the
 * button, and back to DRAFT if the engine refuses — never pending with no
 * request behind it.
 */
planApprovalRoutes.post(
  '/:id/submit',
  requireAny('gops.plans.create', 'gops.plans.edit_own', 'gops.plans.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can submit it');
    if (!EDITABLE.includes(row.status)) throw badRequest('This request has already been submitted');
    const files = await prisma.attachment.count({ where: { entityType: 'approved_plan', entityId: row.id } });
    if (!files) throw badRequest('Attach the drawing or document to be approved first');

    const amount = num(row.job.contractValue);
    const number = await prisma.$transaction(async (tx) => {
      const claimed = await tx.approvedPlan.updateMany({
        where: { id: row.id, status: { in: EDITABLE } },
        data: { status: 'PENDING_APPROVAL', amount: new Prisma.Decimal(amount), submittedAt: new Date() },
      });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      // A plan registered before 2026-10-13 is numbered when it is first sent.
      if (row.number) return row.number;
      const issued = await nextNumber(DOC, tx);
      await tx.approvedPlan.update({ where: { id: row.id }, data: { number: issued } });
      return issued;
    });
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: number,
        subject: `${row.job.number} — ${row.title}${referenceOf(row) ? ` (${referenceOf(row)})` : ''}`,
        amount,
        link: PLAN_LINK(row.id),
        requesterId: row.uploadedById,
        jobId: row.jobId,
      });
    } catch (err) {
      await prisma.approvedPlan.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'SUBMITTED', summary: `${number} sent for approval` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

/** Pulled back to DRAFT before anybody decides — the request withdrawn in the same transaction. */
planApprovalRoutes.post(
  '/:id/withdraw',
  requireAny('gops.plans.create', 'gops.plans.edit_own', 'gops.plans.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.approvedPlan.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

planApprovalRoutes.post(
  '/:id/cancel',
  requireAny('gops.plans.create', 'gops.plans.edit_own', 'gops.plans.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('Only the person who raised this request can cancel it');
    if (![...EDITABLE, 'PENDING_APPROVAL'].includes(row.status)) throw badRequest(`This request is ${statusLabel(row.status).toLowerCase()} — it cannot be cancelled`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.approvedPlan.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
    });
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'CANCELLED', summary: `${row.number ?? row.title} cancelled — ${body.reason}` }, req);
    res.json(await present(me, await loadVisible(me, row.id)));
  }),
);

planApprovalRoutes.delete(
  '/:id',
  require_('gops.plans.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id);
    if (!mayEdit(me, row)) throw forbidden('That is someone else’s request');
    if (![...EDITABLE, 'CANCELLED'].includes(row.status)) {
      throw badRequest('Only a draft or a cancelled request can be deleted — an approved one is a record');
    }
    await deleteOrRefuse(row.number ?? row.title, () =>
      prisma.$transaction(async (tx) => {
        // A CAD J.O. that raised it may raise it again.
        await tx.cadJobOrder.updateMany({ where: { approvedPlanId: row.id }, data: { approvedPlanId: null } });
        await tx.approvedPlan.delete({ where: { id: row.id } });
      }),
    );
    await deleteAttachmentsOf('approved_plan', [row.id]);
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number ?? row.title}` }, req);
    res.json({ ok: true });
  }),
);

// ── Settle ───────────────────────────────────────────────────────────────────

/**
 * Applied only while the request is still PENDING_APPROVAL (a conditional
 * claim), so a decision that lands after a pull-back or a cancel changes
 * nothing and the trail says so. Approved: dated and signed by the last
 * approver, and any earlier approved request on the same project and drawing
 * reference is SUPERSEDED. Returned or rejected: back to DRAFT, for the
 * requester to change and send again. Exported so a test can call it twice.
 */
export async function settlePlanApproval(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.approvedPlan.findUnique({ where: { id: approval.documentId } });
  if (!row) return;
  const last = await prisma.approvalAction.findFirst({
    where: { requestId: approval.id, action: 'APPROVED' },
    orderBy: { actedAt: 'desc' },
    include: { approver: { select: { name: true } } },
  });
  const claimed = await prisma.approvedPlan.updateMany({
    where: { id: row.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date(), approvedBy: last?.approver?.name ?? null } : { status: 'DRAFT' },
  });
  if (!claimed.count) {
    await audit({
      entityType: 'approved_plan',
      entityId: row.id,
      action: outcome,
      summary: `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(row.status).toLowerCase()} — not applied`,
    });
    return;
  }
  if (outcome !== 'APPROVED') {
    await audit({ entityType: 'approved_plan', entityId: row.id, action: 'REJECTED', summary: `${row.number} returned to draft` });
    return;
  }
  let superseded = 0;
  if (row.drawingNo?.trim()) {
    ({ count: superseded } = await prisma.approvedPlan.updateMany({
      where: { jobId: row.jobId, id: { not: row.id }, status: 'APPROVED', drawingNo: { equals: row.drawingNo.trim(), mode: 'insensitive' } },
      data: { status: 'SUPERSEDED' },
    }));
  }
  await audit({
    entityType: 'approved_plan',
    entityId: row.id,
    action: 'APPROVED',
    summary: `${row.number} approved${superseded ? ` — supersedes ${superseded} earlier approval${superseded === 1 ? '' : 's'} of ${row.drawingNo}` : ''}`,
  });
}
onApprovalSettled(DOC, settlePlanApproval);

/**
 * Pulled back after approval (2026-10-16): the APPROVED request goes back to
 * DRAFT, undated and unsigned, for its requester to change and send again.
 * Only the one still APPROVED — one superseded since by a later approval of
 * the same drawing is a record and stays. The earlier approvals it
 * superseded stay superseded: re-approving it is how the drawing stands again.
 */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const row = await prisma.approvedPlan.findUnique({ where: { id }, select: { status: true, uploadedById: true } });
    // A superseded one is refused by `reopen`, saying why.
    return !!row && mayEdit(actor, row);
  },
  reopen: async ({ documentId, tx }) => {
    const row = await tx.approvedPlan.findUnique({ where: { id: documentId }, select: { id: true, number: true, title: true, status: true } });
    if (!row) throw notFound('Request for approval not found');
    if (row.status !== 'APPROVED') {
      throw badRequest(
        `${row.number ?? row.title} is ${statusLabel(row.status).toLowerCase()} — only the approved request goes back to draft${row.status === 'SUPERSEDED' ? '; a later approval of the drawing replaced it' : ''}`,
      );
    }
    const claimed = await tx.approvedPlan.updateMany({
      where: { id: row.id, status: 'APPROVED' },
      data: { status: 'DRAFT', approvedAt: null, approvedBy: null },
    });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
  },
});

// ── The paper ────────────────────────────────────────────────────────────────

/**
 * "Request for Approval" through `renderDocument`: the project, the drawing
 * reference, what is asked, then Requested by and one sign-off per step of
 * its route (a draft prints the route submitting would take, Pending until
 * each signs); the drawings and documents follow it (`withAttachments`) unless
 * `?attachments=0`.
 */
planApprovalRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider(...VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadVisible(me, req.params.id, res.locals.deciderOnly === true);
    const currency = await companyCurrency();
    const contractValue = num(row.amount ?? row.job.contractValue);
    const slots = EDITABLE.includes(row.status)
      ? await approvalSlots(DOC, row.id, { amount: contractValue, requesterId: row.uploadedById, jobId: row.jobId })
      : await approvalSlots(DOC, row.id);
    const requester = { name: row.uploadedBy.name, ...(await contactOf(row.uploadedById)) };
    const signatories: Signatory[] = [
      { role: 'Requested by', ...requester, at: preparedAt(slots) ?? row.createdAt },
      ...(slots.length
        ? slotSignatories(slots)
        : row.status === 'APPROVED' && row.approvedBy
          ? [{ role: 'Approved by', name: row.approvedBy, at: row.approvedAt ?? undefined }]
          : []),
    ];
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Project', value: `${row.job.number} — ${row.job.name}` },
          { label: 'Customer', value: row.job.customer?.name ?? '' },
          { label: 'Drawing reference', value: row.drawingNo ?? '' },
          { label: 'Revision', value: row.revision && row.revision !== '0' ? row.revision : '' },
          { label: 'Discipline', value: row.discipline ?? '' },
          { label: 'Contract value', value: formatMoney(contractValue, currency) },
          { label: 'Status', value: statusLabel(row.status) },
          { label: 'Submitted', value: row.submittedAt && row.status !== 'DRAFT' ? formatDate(row.submittedAt) : '' },
        ],
      },
      { kind: 'text', title: 'Request', body: [row.title, row.description].filter(Boolean).join('\n\n') },
    ];
    if (row.notes) sections.push({ kind: 'text', title: 'Notes', body: row.notes });
    if (row.cancelReason && row.status === 'CANCELLED') sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });

    const bare = await renderDocument({
      title: 'Request for Approval',
      documentNumber: row.number ?? undefined,
      date: row.createdAt,
      reference: `${row.job.number} — ${row.job.name}`,
      sections,
      signatories,
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles('approved_plan', row.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Request for Approval', number: row.number ?? row.title, reference: row.job.name });
    await audit(
      { entityType: 'approved_plan', entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number ?? row.title}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Request for Approval', number: row.number ?? row.title, author: row.uploadedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

registerSearch({
  kind: 'approved_plan',
  label: 'Requests for approval',
  permission: VIEW,
  ownWhere: (user) => ({ uploadedById: user.id }),
  async search(term, _user, limit, own) {
    const rows = await prisma.approvedPlan.findMany({
      where: {
        ...((own ?? {}) as Prisma.ApprovedPlanWhereInput),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { drawingNo: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: { id: true, number: true, title: true, drawingNo: true, status: true, job: { select: { number: true } } },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'approved_plan',
      id: r.id,
      title: `${r.number ?? r.drawingNo ?? 'Request'} — ${r.title}`,
      subtitle: `${r.job.number} · ${statusLabel(r.status).toLowerCase()}`,
      link: PLAN_LINK(r.id),
    }));
  },
});
