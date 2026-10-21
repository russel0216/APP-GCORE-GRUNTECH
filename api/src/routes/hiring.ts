import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type ApprovalRequest, type CandidateStatus, type EmploymentType } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, conflict, forbidden, idsFilter, deleteOrRefuse, type ListQuery } from '../http/kit';
import { authenticate, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { requireView, requireEdit, ownOnly, viewScope } from '../shared/ownScope';
import { visibleOwners } from '../shared/team';
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
import { renderDocument, formatDate, formatShortDate, formatMoney, companyCurrency, statusLabel, type PdfSection, type Signatory } from '../shared/pdf';
import { LIST_CAP, listReference, sendListPdf, choice } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { manilaDate } from '../shared/day';
import { CANDIDATE_CLOSED, CANDIDATE_FLOW, examPct, hiredBenchmark, nextStatuses, weightedScore, type CandidateStatusKey } from '../shared/hiring';

/**
 * G-HR › HIRING (2026-10-21, the owner's Hiring module — "print and sign
 * only": the hire has no G-CORE access yet, so there is no online contract
 * link). Four screens on the section's strip:
 *
 * - **Man Power Request** (`manpower_request`, GT-MPR-2026-0001): a hiring
 *   manager asks for people — the PDF's five boxes, the headcount, the team.
 *   Routed through the one engine (Team Leader › HR Officer › CEO /
 *   President). Approved, candidates are gathered against it; FILLED once
 *   its headcount is hired.
 * - **Candidates**: applicants against an approved request, moved along the
 *   PDF's chips (`nextStatuses`), each move a dated `CandidateEvent`; their
 *   exam score the weighted percentage of their results.
 * - **Entrance Exam**: the catalogue, and the analytics card — a candidate's
 *   score per exam beside the average of the HIRED candidates' (the owner's
 *   "company average": employees never sit the entrance exam).
 * - **Contracts & Approvals** (`employment_contract`, GT-EC-2026-0001): HR
 *   prepares it for a candidate at the contract stage; routed Technical
 *   Manager › Team Leader › HR Officer › CEO / President of the REQUEST'S
 *   team (`teamId` on the request, `ApprovalContext.teamId`), printed for the
 *   wet signature, marked signed, and the hire links the employee record
 *   made through the one employee form.
 */

export const hiringRoutes = Router();
hiringRoutes.use(authenticate);

const MPR = 'manpower_request';
const CANDIDATE = 'candidate';
const CONTRACT = 'employment_contract';
const EXAM = 'entrance_exam';
export const MPR_LINK = (id: string) => `/g-hr/hiring/mpr/${id}`;
export const CANDIDATE_LINK = (id: string) => `/g-hr/hiring/candidates/${id}`;
export const CONTRACT_LINK = (id: string) => `/g-hr/hiring/contracts/${id}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (key: string) => new Date(`${key}T00:00:00Z`);
const today = () => manilaDate(new Date()).toISOString().slice(0, 10);
const keyOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));
const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const nameOf = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
const EMPLOYMENT_TYPES = ['REGULAR', 'PROBATIONARY', 'PROJECT_BASED', 'CONTRACTUAL', 'PART_TIME', 'TRAINEE'] as const;

function addAnd<W extends { AND?: unknown }>(where: W, extra: W[]): W {
  if (!extra.length) return where;
  const prior = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
  return { ...where, AND: [...prior, ...extra] };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAN POWER REQUEST
// ═════════════════════════════════════════════════════════════════════════════

const mprInclude = {
  position: { select: { id: true, title: true, code: true } },
  team: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, name: true, position: true } },
  candidates: { select: { id: true, status: true } },
} satisfies Prisma.ManpowerRequestInclude;
type MprRow = Prisma.ManpowerRequestGetPayload<{ include: typeof mprInclude }>;

const MPR_EDITABLE = ['DRAFT'] as const;
const mayEditMpr = (me: ResolvedUser, r: { requestedById: string }) => canEditRecord(me, 'ghr', 'manpower_requests', r.requestedById);

async function mayReadMpr(me: ResolvedUser, r: { id: string; requestedById: string }, deciderOnly = false) {
  if (!deciderOnly && (me.isSuperAdmin || visibleOwners(me, 'ghr', 'manpower_requests').includes(r.requestedById) || viewScope(me, 'ghr', 'manpower_requests') === 'all')) return true;
  // Candidates and contracts are gathered against an approved request: their readers read it too.
  if (!deciderOnly && viewScope(me, 'ghr', 'candidates') === 'all') return true;
  return mayDecide(me.id, MPR, [r.id]);
}

async function loadMpr(me: ResolvedUser, id: string, deciderOnly = false): Promise<MprRow> {
  const row = await prisma.manpowerRequest.findUnique({ where: { id }, include: mprInclude });
  if (!row || !(await mayReadMpr(me, row, deciderOnly))) throw notFound('Man power request not found');
  return row;
}

function mprFigures(r: MprRow) {
  const hired = r.candidates.filter((c) => c.status === 'HIRED').length;
  const active = r.candidates.filter((c) => !CANDIDATE_CLOSED.includes(c.status as CandidateStatusKey)).length;
  return { hired, active, applicants: r.candidates.length, openings: Math.max(0, r.headcount - hired) };
}

async function presentMpr(me: ResolvedUser, r: MprRow, withRoute = false) {
  const { candidates: _c, ...rest } = r;
  const editor = mayEditMpr(me, r);
  const draft = r.status === 'DRAFT';
  return {
    ...rest,
    salaryMin: num(r.salaryMin),
    salaryMax: num(r.salaryMax),
    ...mprFigures(r),
    canEdit: draft && editor,
    canSubmit: draft && editor,
    canWithdraw: r.status === 'PENDING_APPROVAL' && editor,
    canCancel: (draft || r.status === 'PENDING_APPROVAL' || (r.status === 'APPROVED' && !r.candidates.some((c) => c.status === 'HIRED'))) && editor,
    canDelete: (draft || r.status === 'CANCELLED') && editor && can(me, 'ghr.manpower_requests.delete') && !r.candidates.length,
    approvalRoute: withRoute && draft ? await routeBrief(MPR, num(r.salaryMax), r.requestedById) : null,
  };
}

const MPR_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FILLED', 'CANCELLED'] as const;

function mprListWhere(me: ResolvedUser, q: ListQuery) {
  const and: Prisma.ManpowerRequestWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    const t = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ number: t }, { title: t }, { education: t }, { licenses: t }, { experience: t }, { requestedBy: { name: t } }] });
  }
  if (q.scope === 'mine') and.push({ requestedById: me.id });
  const base = ownOnly<Prisma.ManpowerRequestWhereInput>(me, 'ghr', 'manpower_requests', and.length ? { AND: and } : {}, (owners) => ({ requestedById: { in: owners } }));
  const extra: Prisma.ManpowerRequestWhereInput[] = [];
  const status = choice(q.filters.status, MPR_STATUSES, 'Status');
  if (status) extra.push({ status });
  if (q.filters.teamId === 'none') extra.push({ teamId: null });
  else if (q.filters.teamId) extra.push({ teamId: q.filters.teamId });
  if (q.filters.requestedById) extra.push({ requestedById: q.filters.requestedById });
  return { base, where: addAnd(base, extra) };
}

const MPR_SORTS = ['number', 'title', 'status', 'neededBy', 'createdAt', 'updatedAt'];

hiringRoutes.get(
  '/mprs',
  requireView('ghr', 'manpower_requests'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = mprListWhere(me, q);
    const [rows, total, live, pending, approved] = await Promise.all([
      prisma.manpowerRequest.findMany({ where, include: mprInclude, orderBy: orderBy(q, MPR_SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.manpowerRequest.count({ where }),
      prisma.manpowerRequest.count({ where: { ...base, status: { not: 'CANCELLED' } } }),
      prisma.manpowerRequest.count({ where: { ...base, status: 'PENDING_APPROVAL' } }),
      prisma.manpowerRequest.findMany({ where: { ...base, status: 'APPROVED' }, select: { headcount: true, candidates: { select: { status: true } } } }),
    ]);
    const openings = approved.reduce((a, r) => a + Math.max(0, r.headcount - r.candidates.filter((c) => c.status === 'HIRED').length), 0);
    const inPipeline = approved.reduce((a, r) => a + r.candidates.filter((c) => !CANDIDATE_CLOSED.includes(c.status as CandidateStatusKey)).length, 0);
    res.json({
      ...listResult(await Promise.all(rows.map((r) => presentMpr(me, r))), total, q),
      summary: { total: live, pending, open: approved.length, openings, inPipeline },
    });
  }),
);

/** The approved requests a candidate may be added against — the candidate form's picker. Above /:id. */
hiringRoutes.get(
  '/mprs/open',
  requireAny('ghr.candidates.create', 'ghr.candidates.edit_all', 'ghr.candidates.edit_own', 'ghr.candidates.view_all', 'ghr.manpower_requests.view_all'),
  handler(async (_req, res) => {
    const rows = await prisma.manpowerRequest.findMany({ where: { status: 'APPROVED' }, include: mprInclude, orderBy: { number: 'asc' } });
    res.json(rows.map((r) => ({ id: r.id, number: r.number, title: r.title, team: r.team?.code ?? null, ...mprFigures(r) })));
  }),
);

hiringRoutes.get(
  '/mprs/pdf',
  requireView('ghr', 'manpower_requests'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = mprListWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.manpowerRequest.findMany({ where, include: mprInclude, orderBy: orderBy(q, MPR_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.manpowerRequest.count({ where }),
    ]);
    const currency = await companyCurrency();
    const reference = listReference(count, rows.length, ['request', 'requests'], [
      q.search ? `search "${q.search}"` : null,
      q.filters.status ? `status ${statusLabel(q.filters.status)}` : null,
      q.scope === 'mine' ? 'mine' : null,
      q.filters.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Man Power Requests',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Position', 'Team', 'Headcount', `Salary range (${currency})`, 'Needed by', 'Requested by', 'Hired', 'Status'],
          rows: rows.map((r) => [
            r.number,
            r.title,
            r.team?.code ?? '—',
            String(r.headcount),
            salaryRange(r.salaryMin, r.salaryMax, null) || '—',
            r.neededBy ? formatShortDate(r.neededBy) : '—',
            r.requestedBy.name,
            `${mprFigures(r).hired} of ${r.headcount}`,
            statusLabel(r.status),
          ]),
        },
      ],
    });
    await audit({ entityType: MPR, entityId: 'list', action: 'EXPORTED', summary: `Exported the man power requests as PDF (${listReference(count, rows.length, ['request', 'requests'], [])})` }, req);
    sendListPdf(res, pdf, 'man-power-requests.pdf');
  }),
);

function salaryRange(min: Prisma.Decimal | number | null, max: Prisma.Decimal | number | null, currency: string | null): string {
  const f = (v: Prisma.Decimal | number) => (currency ? formatMoney(Number(v), currency) : Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (min != null && max != null) return `${f(min)} – ${f(max)}`;
  if (min != null) return `from ${f(min)}`;
  if (max != null) return `up to ${f(max)}`;
  return '';
}

const mprSchema = z.object({
  positionId: z.string().optional().nullable(),
  title: z.string().trim().min(2, 'Name the position requested').max(200),
  headcount: z.number().int().min(1, 'At least one').max(500).optional(),
  salaryMin: z.number().nonnegative().max(1e9).optional().nullable(),
  salaryMax: z.number().nonnegative().max(1e9).optional().nullable(),
  education: z.string().trim().max(1000).optional().nullable(),
  licenses: z.string().trim().max(1000).optional().nullable(),
  experience: z.string().trim().max(4000).optional().nullable(),
  justification: z.string().trim().max(4000).optional().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  neededBy: z.string().regex(DAY, 'Use a date').optional().nullable(),
  teamId: z.string().optional().nullable(),
});

async function checkMprRefs(body: Partial<z.infer<typeof mprSchema>>) {
  if (body.salaryMin != null && body.salaryMax != null && body.salaryMin > body.salaryMax) throw badRequest('The salary range runs from the lower figure to the higher');
  if (body.positionId) {
    const p = await prisma.position.findUnique({ where: { id: body.positionId }, select: { isActive: true } });
    if (!p) throw badRequest('That position is not on the Plantilla');
    if (!p.isActive) throw badRequest('That position is no longer active on the Plantilla');
  }
  if (body.teamId) {
    const t = await prisma.industry.findUnique({ where: { id: body.teamId }, select: { isActive: true } });
    if (!t?.isActive) throw badRequest('That team is not active');
  }
}

/** The requester's own team, the default. */
async function teamOfUser(userId: string) {
  const e = await prisma.employee.findUnique({ where: { userId }, select: { industryId: true } });
  return e?.industryId ?? null;
}

hiringRoutes.post(
  '/mprs',
  requireAny('ghr.manpower_requests.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(mprSchema, req.body);
    await checkMprRefs(body);
    const teamId = body.teamId !== undefined ? body.teamId : await teamOfUser(me.id);
    const row = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(MPR, tx);
      return tx.manpowerRequest.create({
        data: {
          number,
          positionId: body.positionId || null,
          title: body.title,
          headcount: body.headcount ?? 1,
          salaryMin: body.salaryMin ?? null,
          salaryMax: body.salaryMax ?? null,
          education: blank(body.education),
          licenses: blank(body.licenses),
          experience: blank(body.experience),
          justification: blank(body.justification),
          employmentType: body.employmentType ?? 'PROBATIONARY',
          neededBy: body.neededBy ? dayOf(body.neededBy) : null,
          teamId: teamId || null,
          requestedById: me.id,
        },
        include: mprInclude,
      });
    });
    await audit({ entityType: MPR, entityId: row.id, action: 'CREATED', summary: `Raised ${row.number} — ${row.headcount} × ${row.title}` }, req);
    res.status(201).json(await presentMpr(me, row, true));
  }),
);

hiringRoutes.get(
  '/mprs/:id',
  requireAnyOrDecider('ghr.manpower_requests.view_all', 'ghr.manpower_requests.view_team', 'ghr.manpower_requests.view_own', 'ghr.candidates.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadMpr(me, req.params.id, res.locals.deciderOnly === true);
    const candidates = await prisma.candidate.findMany({ where: { mprId: row.id }, include: candidateInclude, orderBy: { createdAt: 'asc' } });
    res.json({
      ...(await presentMpr(me, row, true)),
      currency: await companyCurrency(),
      candidates: viewScope(me, 'ghr', 'candidates') ? candidates.map((c) => presentCandidate(me, c)) : [],
    });
  }),
);

hiringRoutes.patch(
  '/mprs/:id',
  requireAny('ghr.manpower_requests.create', 'ghr.manpower_requests.edit_own', 'ghr.manpower_requests.edit_team', 'ghr.manpower_requests.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(mprSchema.partial(), req.body);
    const row = await loadMpr(me, req.params.id);
    if (!mayEditMpr(me, row)) throw forbidden('That is someone else’s request');
    if (row.status !== 'DRAFT') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — pull it back to draft to change it`);
    await checkMprRefs({ salaryMin: body.salaryMin ?? num(row.salaryMin), salaryMax: body.salaryMax ?? num(row.salaryMax), positionId: body.positionId, teamId: body.teamId });
    const claimed = await prisma.manpowerRequest.updateMany({
      where: { id: row.id, status: 'DRAFT' },
      data: {
        ...(body.positionId !== undefined ? { positionId: body.positionId || null } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.headcount ? { headcount: body.headcount } : {}),
        ...(body.salaryMin !== undefined ? { salaryMin: body.salaryMin } : {}),
        ...(body.salaryMax !== undefined ? { salaryMax: body.salaryMax } : {}),
        ...(body.education !== undefined ? { education: blank(body.education) } : {}),
        ...(body.licenses !== undefined ? { licenses: blank(body.licenses) } : {}),
        ...(body.experience !== undefined ? { experience: blank(body.experience) } : {}),
        ...(body.justification !== undefined ? { justification: blank(body.justification) } : {}),
        ...(body.employmentType ? { employmentType: body.employmentType } : {}),
        ...(body.neededBy !== undefined ? { neededBy: body.neededBy ? dayOf(body.neededBy) : null } : {}),
        ...(body.teamId !== undefined ? { teamId: body.teamId || null } : {}),
      },
    });
    if (!claimed.count) throw conflict('It moved a moment ago — reload to see where it stands');
    await audit({ entityType: MPR, entityId: row.id, action: 'UPDATED', summary: `Modified ${row.number}` }, req);
    res.json(await presentMpr(me, await loadMpr(me, row.id), true));
  }),
);

const MPR_EDIT_RIGHTS = ['ghr.manpower_requests.create', 'ghr.manpower_requests.edit_own', 'ghr.manpower_requests.edit_team', 'ghr.manpower_requests.edit_all'] as const;

/** Sent in the REQUESTER's name, whoever presses it; back to DRAFT if the engine refuses. */
hiringRoutes.post(
  '/mprs/:id/submit',
  requireAny(...MPR_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadMpr(me, req.params.id);
    if (!mayEditMpr(me, row)) throw forbidden('Only the person who raised this request can submit it');
    const claimed = await prisma.manpowerRequest.updateMany({ where: { id: row.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('This request has already been submitted');
    try {
      await submitForApproval({
        documentType: MPR,
        documentId: row.id,
        documentNumber: row.number,
        subject: `${row.headcount} × ${row.title}${row.team ? ` (${row.team.code})` : ''}`,
        amount: num(row.salaryMax),
        link: MPR_LINK(row.id),
        requesterId: row.requestedById,
      });
    } catch (err) {
      await prisma.manpowerRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: MPR, entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent for approval` }, req);
    res.json(await presentMpr(me, await loadMpr(me, row.id), true));
  }),
);

hiringRoutes.post(
  '/mprs/:id/withdraw',
  requireAny(...MPR_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadMpr(me, req.params.id);
    if (!mayEditMpr(me, row)) throw forbidden('Only the person who raised this request can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.manpowerRequest.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(MPR, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: MPR, entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await presentMpr(me, await loadMpr(me, row.id), true));
  }),
);

/** A draft, a pending one (its request withdrawn) or an approved one nobody was hired on. */
hiringRoutes.post(
  '/mprs/:id/cancel',
  requireAny(...MPR_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await loadMpr(me, req.params.id);
    if (!mayEditMpr(me, row)) throw forbidden('Only the person who raised this request can cancel it');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(row.status)) throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — it cannot be cancelled`);
    if (row.candidates.some((c) => c.status === 'HIRED')) throw badRequest(`Somebody was hired on ${row.number} — it is kept`);
    const live = await prisma.employmentContract.count({ where: { candidate: { mprId: row.id }, status: { not: 'CANCELLED' } } });
    if (live) throw badRequest(`A contract stands on ${row.number} — cancel it first`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.manpowerRequest.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(MPR, row.id, tx, `cancelled by ${me.name}: ${reason}`, me.id);
    });
    await audit({ entityType: MPR, entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${reason}` }, req);
    res.json(await presentMpr(me, await loadMpr(me, row.id), true));
  }),
);

hiringRoutes.delete(
  '/mprs/:id',
  requireAny('ghr.manpower_requests.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadMpr(me, req.params.id);
    if (!mayEditMpr(me, row)) throw forbidden('That is someone else’s request');
    if (!['DRAFT', 'CANCELLED'].includes(row.status)) throw badRequest('Only a draft or a cancelled request can be deleted');
    if (row.candidates.length) throw badRequest(`${row.number} has ${row.candidates.length} candidate${row.candidates.length === 1 ? '' : 's'} on it — it is kept`);
    await deleteOrRefuse(row.number, () => prisma.manpowerRequest.delete({ where: { id: row.id } }));
    await audit({ entityType: MPR, entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

export async function settleManpowerRequest(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.manpowerRequest.findUnique({ where: { id: approval.documentId } });
  if (!row) return;
  const claimed = await prisma.manpowerRequest.updateMany({
    where: { id: row.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'DRAFT' },
  });
  if (!claimed.count) {
    await audit({ entityType: MPR, entityId: row.id, action: outcome, summary: `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(row.status).toLowerCase()} — not applied` });
    return;
  }
  await audit({ entityType: MPR, entityId: row.id, action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED', summary: outcome === 'APPROVED' ? `${row.number} approved — candidates may be gathered` : `${row.number} returned to draft` });
}
onApprovalSettled(MPR, settleManpowerRequest);

onApprovalReopened(MPR, {
  may: async (actor, id) => {
    const row = await prisma.manpowerRequest.findUnique({ where: { id }, select: { requestedById: true } });
    return !!row && mayEditMpr(actor, row);
  },
  reopen: async ({ documentId, tx }) => {
    const row = await tx.manpowerRequest.findUnique({ where: { id: documentId }, select: { id: true, number: true, status: true } });
    if (!row) throw notFound('Man power request not found');
    if (row.status !== 'APPROVED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved request goes back to draft`);
    const contracts = await tx.employmentContract.count({ where: { candidate: { mprId: row.id }, status: { not: 'CANCELLED' } } });
    if (contracts) throw badRequest(`A contract stands on ${row.number} — cancel it first`);
    const claimed = await tx.manpowerRequest.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
  },
});

/** "Man Power Requisition" — the PDF's five boxes, the headcount, the request, Requested by and the route's steps. */
hiringRoutes.get(
  '/mprs/:id/pdf',
  requireAnyOrDecider('ghr.manpower_requests.view_all', 'ghr.manpower_requests.view_team', 'ghr.manpower_requests.view_own', 'ghr.candidates.view_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadMpr(me, req.params.id, res.locals.deciderOnly === true);
    const currency = await companyCurrency();
    const slots = row.status === 'DRAFT' ? await approvalSlots(MPR, row.id, { amount: num(row.salaryMax), requesterId: row.requestedById }) : await approvalSlots(MPR, row.id);
    const signatories: Signatory[] = [
      { role: 'Requested by', name: row.requestedBy.name, ...(await contactOf(row.requestedById)), at: preparedAt(slots) ?? row.createdAt },
      ...slotSignatories(slots),
    ];
    const f = mprFigures(row);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Position title requested', value: row.title },
          { label: 'Plantilla position', value: row.position ? `${row.position.code} — ${row.position.title}` : '' },
          { label: 'Proposed salary range', value: salaryRange(row.salaryMin, row.salaryMax, currency) ? `${salaryRange(row.salaryMin, row.salaryMax, currency)} / month` : '' },
          { label: 'Headcount', value: String(row.headcount) },
          { label: 'Employment type', value: statusLabel(row.employmentType) },
          { label: 'Needed by', value: row.neededBy ? formatDate(row.neededBy) : '' },
          { label: 'Team', value: row.team ? `${row.team.code} — ${row.team.name}` : '' },
          { label: 'Hired', value: row.status === 'APPROVED' || row.status === 'FILLED' ? `${f.hired} of ${row.headcount}` : '' },
        ],
      },
      { kind: 'fields', title: 'Requirements', fields: [
        { label: 'Required education', value: row.education ?? '' },
        { label: 'Required licenses & certs', value: row.licenses ?? '' },
        { label: 'Experience & required skill sets', value: row.experience ?? '' },
      ] },
    ];
    if (row.justification) sections.push({ kind: 'text', title: 'Justification', body: row.justification });
    if (row.status === 'CANCELLED' && row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    const pdf = await renderDocument({ title: 'Man Power Requisition', documentNumber: row.number, date: row.createdAt, reference: `${row.headcount} × ${row.title}`, sections, signatories });
    await audit({ entityType: MPR, entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Man Power Requisition', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// CANDIDATES
// ═════════════════════════════════════════════════════════════════════════════

const candidateInclude = {
  mpr: { select: { id: true, number: true, title: true, status: true, teamId: true, team: { select: { code: true } } } },
  examResults: { include: { exam: { select: { id: true, name: true, maxScore: true, weight: true } } } },
  createdBy: { select: { id: true, name: true } },
  employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
} satisfies Prisma.CandidateInclude;
type CandidateRow = Prisma.CandidateGetPayload<{ include: typeof candidateInclude }>;

const scoreOf = (c: CandidateRow) => weightedScore(c.examResults.map((r) => ({ score: Number(r.score), maxScore: r.exam.maxScore, weight: Number(r.exam.weight) })));
const mayEditCandidate = (me: ResolvedUser, c: { createdById: string }) => canEditRecord(me, 'ghr', 'candidates', c.createdById);

function presentCandidate(me: ResolvedUser, c: CandidateRow) {
  const closed = CANDIDATE_CLOSED.includes(c.status as CandidateStatusKey);
  const editor = mayEditCandidate(me, c);
  return {
    ...c,
    name: nameOf(c),
    examScore: scoreOf(c),
    examResults: c.examResults.map((r) => ({ ...r, score: Number(r.score), pct: examPct(Number(r.score), r.exam.maxScore), exam: { ...r.exam, weight: Number(r.exam.weight) } })),
    canEdit: editor && c.status !== 'HIRED',
    moves: editor ? nextStatuses(c.status as CandidateStatusKey) : [],
    canScore: editor && !closed,
    canContract: can(me, 'ghr.employment_contracts.create') && (c.status === 'INTERVIEW_PASSED' || c.status === 'CONTRACT_STAGE'),
  };
}

async function loadCandidate(me: ResolvedUser, id: string): Promise<CandidateRow> {
  const row = await prisma.candidate.findUnique({ where: { id }, include: candidateInclude });
  const scope = viewScope(me, 'ghr', 'candidates');
  const readable = !!row && (me.isSuperAdmin || scope === 'all' || visibleOwners(me, 'ghr', 'candidates').includes(row.createdById));
  if (!row || !readable) throw notFound('Candidate not found');
  return row;
}

const CANDIDATE_STATUSES = CANDIDATE_FLOW;

function candidateListWhere(me: ResolvedUser, q: ListQuery) {
  const and: Prisma.CandidateWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    const t = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ firstName: t }, { lastName: t }, { email: t }, { education: t }, { license: t }, { skills: t }, { mpr: { OR: [{ number: t }, { title: t }] } }] });
  }
  if (q.scope === 'mine') and.push({ createdById: me.id });
  const base = ownOnly<Prisma.CandidateWhereInput>(me, 'ghr', 'candidates', and.length ? { AND: and } : {}, (owners) => ({ createdById: { in: owners } }));
  const extra: Prisma.CandidateWhereInput[] = [];
  if (q.filters.status) {
    const list = q.filters.status.split(',').map((s) => choice(s, CANDIDATE_STATUSES, 'Status')).filter((s): s is CandidateStatusKey => !!s);
    extra.push({ status: { in: list as CandidateStatus[] } });
  }
  if (q.filters.mprId) extra.push({ mprId: q.filters.mprId });
  const open = choice(q.filters.open, ['true', 'false'] as const, 'Open');
  if (open === 'true') extra.push({ status: { notIn: CANDIDATE_CLOSED as CandidateStatus[] } });
  return { base, where: addAnd(base, extra) };
}

const CANDIDATE_SORTS = ['lastName', 'status', 'createdAt', 'updatedAt'];

hiringRoutes.get(
  '/candidates',
  requireView('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = candidateListWhere(me, q);
    const [rows, total, groups] = await Promise.all([
      prisma.candidate.findMany({ where, include: candidateInclude, orderBy: orderBy(q, CANDIDATE_SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.candidate.count({ where }),
      prisma.candidate.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const n = (s: CandidateStatusKey[]) => groups.filter((g) => s.includes(g.status as CandidateStatusKey)).reduce((a, g) => a + g._count._all, 0);
    res.json({
      ...listResult(rows.map((c) => presentCandidate(me, c)), total, q),
      summary: {
        total: n([...CANDIDATE_FLOW]),
        screening: n(['APPLIED', 'UNDER_SCREENING']),
        exams: n(['EXAM_SCHEDULED', 'EXAM_DONE']),
        interviews: n(['INTERVIEW_SCHEDULED', 'INTERVIEW_PASSED']),
        contract: n(['CONTRACT_STAGE']),
        hired: n(['HIRED']),
      },
    });
  }),
);

hiringRoutes.get(
  '/candidates/pdf',
  requireView('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = candidateListWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.candidate.findMany({ where, include: candidateInclude, orderBy: orderBy(q, CANDIDATE_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.candidate.count({ where }),
    ]);
    const reference = listReference(count, rows.length, ['candidate', 'candidates'], [
      q.search ? `search "${q.search}"` : null,
      q.filters.status ? `status ${q.filters.status.split(',').map(statusLabel).join(', ')}` : null,
      q.filters.open === 'true' ? 'in the running' : null,
      q.scope === 'mine' ? 'mine' : null,
      q.filters.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Applicants & Candidate Pool',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Applicant name', 'Position applied', 'Education & school', 'License / cert', 'Key skills & experience', 'Exam score', 'Status'],
          rows: rows.map((c) => {
            const score = scoreOf(c);
            return [
              { title: nameOf(c), body: c.email ?? '' },
              { title: c.mpr.title, body: c.mpr.number },
              c.education ?? '—',
              c.license ?? '—',
              [c.skills, c.yearsExperience != null ? `${c.yearsExperience} yrs exp` : null].filter(Boolean).join(' · ') || '—',
              score == null ? '—' : `${score.toFixed(1)}%`,
              statusLabel(c.status),
            ];
          }),
        },
      ],
    });
    await audit({ entityType: CANDIDATE, entityId: 'list', action: 'EXPORTED', summary: `Exported the candidate pool as PDF (${listReference(count, rows.length, ['candidate', 'candidates'], [])})` }, req);
    sendListPdf(res, pdf, 'candidates.pdf');
  }),
);

const candidateSchema = z.object({
  mprId: z.string().min(1, 'Which man power request is this applicant for?'),
  firstName: z.string().trim().min(1, 'First name').max(100),
  lastName: z.string().trim().min(1, 'Last name').max(100),
  email: z.string().trim().email('Use an email address').max(200).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(60).optional().nullable(),
  education: z.string().trim().max(500).optional().nullable(),
  license: z.string().trim().max(500).optional().nullable(),
  skills: z.string().trim().max(2000).optional().nullable(),
  yearsExperience: z.number().int().min(0).max(60).optional().nullable(),
  source: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

async function checkOpenMpr(mprId: string) {
  const m = await prisma.manpowerRequest.findUnique({ where: { id: mprId }, select: { status: true, number: true } });
  if (!m) throw badRequest('That man power request does not exist');
  if (m.status !== 'APPROVED') throw badRequest(`${m.number} is ${statusLabel(m.status).toLowerCase()} — applicants are added to an approved request`);
}

hiringRoutes.post(
  '/candidates',
  requireAny('ghr.candidates.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(candidateSchema, req.body);
    await checkOpenMpr(body.mprId);
    const row = await prisma.$transaction(async (tx) => {
      const c = await tx.candidate.create({
        data: {
          mprId: body.mprId,
          firstName: body.firstName,
          lastName: body.lastName,
          email: blank(body.email || null),
          phone: blank(body.phone),
          education: blank(body.education),
          license: blank(body.license),
          skills: blank(body.skills),
          yearsExperience: body.yearsExperience ?? null,
          source: blank(body.source),
          notes: blank(body.notes),
          createdById: me.id,
        },
      });
      await tx.candidateEvent.create({ data: { candidateId: c.id, toStatus: 'APPLIED', on: dayOf(today()), byId: me.id, note: 'Added to the candidate pool' } });
      return tx.candidate.findUniqueOrThrow({ where: { id: c.id }, include: candidateInclude });
    });
    await audit({ entityType: CANDIDATE, entityId: row.id, action: 'CREATED', summary: `Added applicant ${nameOf(row)} for ${row.mpr.number} — ${row.mpr.title}` }, req);
    res.status(201).json(presentCandidate(me, row));
  }),
);

hiringRoutes.get(
  '/candidates/:id',
  requireView('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadCandidate(me, req.params.id);
    const [events, contracts, exams, benchmark] = await Promise.all([
      prisma.candidateEvent.findMany({ where: { candidateId: row.id }, orderBy: [{ on: 'desc' }, { createdAt: 'desc' }], include: { by: { select: { name: true } } } }),
      prisma.employmentContract.findMany({ where: { candidateId: row.id }, orderBy: { createdAt: 'desc' }, select: { id: true, number: true, status: true, startDate: true, monthlySalary: true } }),
      prisma.examCatalog.findMany({ where: { OR: [{ isActive: true }, { results: { some: { candidateId: row.id } } }] }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      hiredBenchmark(),
    ]);
    res.json({
      ...presentCandidate(me, row),
      events,
      contracts: contracts.map((k) => ({ ...k, monthlySalary: Number(k.monthlySalary) })),
      exams: exams.map((e) => {
        const mine = row.examResults.find((r) => r.examId === e.id);
        return {
          id: e.id,
          name: e.name,
          maxScore: e.maxScore,
          weight: Number(e.weight),
          isActive: e.isActive,
          score: mine ? Number(mine.score) : null,
          takenOn: mine?.takenOn ?? null,
          pct: mine ? examPct(Number(mine.score), e.maxScore) : null,
          benchmark: benchmark.get(e.id)?.pct ?? null,
          benchmarkCount: benchmark.get(e.id)?.count ?? 0,
        };
      }),
    });
  }),
);

hiringRoutes.patch(
  '/candidates/:id',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(candidateSchema.partial(), req.body);
    const row = await loadCandidate(me, req.params.id);
    if (!mayEditCandidate(me, row)) throw forbidden('That candidate is someone else’s');
    if (row.status === 'HIRED') throw badRequest(`${nameOf(row)} was hired — the employee record is what changes now`);
    if (body.mprId && body.mprId !== row.mprId) await checkOpenMpr(body.mprId);
    const updated = await prisma.candidate.update({
      where: { id: row.id },
      data: {
        ...(body.mprId ? { mprId: body.mprId } : {}),
        ...(body.firstName ? { firstName: body.firstName } : {}),
        ...(body.lastName ? { lastName: body.lastName } : {}),
        ...(body.email !== undefined ? { email: blank(body.email || null) } : {}),
        ...(body.phone !== undefined ? { phone: blank(body.phone) } : {}),
        ...(body.education !== undefined ? { education: blank(body.education) } : {}),
        ...(body.license !== undefined ? { license: blank(body.license) } : {}),
        ...(body.skills !== undefined ? { skills: blank(body.skills) } : {}),
        ...(body.yearsExperience !== undefined ? { yearsExperience: body.yearsExperience } : {}),
        ...(body.source !== undefined ? { source: blank(body.source) } : {}),
        ...(body.notes !== undefined ? { notes: blank(body.notes) } : {}),
      },
      include: candidateInclude,
    });
    await audit({ entityType: CANDIDATE, entityId: row.id, action: 'UPDATED', summary: `Modified applicant ${nameOf(updated)}` }, req);
    res.json(presentCandidate(me, updated));
  }),
);

/**
 * Moves a candidate along the pipeline with a dated note — the trail. Only the
 * moves `nextStatuses` allows; HIRED is the hire's alone. Claimed on the
 * status read, so two moves never both land.
 */
hiringRoutes.post(
  '/candidates/:id/move',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ to: z.enum(CANDIDATE_FLOW), on: z.string().regex(DAY).optional(), note: z.string().trim().max(2000).optional().nullable() }),
      req.body,
    );
    const row = await loadCandidate(me, req.params.id);
    if (!mayEditCandidate(me, row)) throw forbidden('That candidate is someone else’s');
    const allowed = nextStatuses(row.status as CandidateStatusKey);
    if (!allowed.includes(body.to)) {
      throw badRequest(body.to === 'HIRED' ? 'A candidate is hired from their signed contract' : `From ${statusLabel(row.status).toLowerCase()} a candidate moves to ${allowed.map((s) => statusLabel(s).toLowerCase()).join(', ') || 'nothing'}`);
    }
    if (['DECLINED', 'WITHDRAWN', 'INTERVIEW_FAILED'].includes(body.to) && !body.note?.trim()) throw badRequest('Say why');
    const on = body.on ?? today();
    if (on > today() && !['EXAM_SCHEDULED', 'INTERVIEW_SCHEDULED'].includes(body.to)) throw badRequest('Only a schedule is dated in the days to come');
    if (['DECLINED', 'WITHDRAWN'].includes(body.to)) {
      const live = await prisma.employmentContract.count({ where: { candidateId: row.id, status: { notIn: ['CANCELLED'] } } });
      if (live) throw badRequest('A contract stands for this candidate — cancel it first');
    }
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.candidate.updateMany({ where: { id: row.id, status: row.status }, data: { status: body.to } });
      if (!claimed.count) throw conflict('It moved a moment ago — reload to see where it stands');
      await tx.candidateEvent.create({ data: { candidateId: row.id, fromStatus: row.status, toStatus: body.to, on: dayOf(on), note: blank(body.note), byId: me.id } });
    });
    await audit({ entityType: CANDIDATE, entityId: row.id, action: 'UPDATED', summary: `${nameOf(row)}: ${statusLabel(row.status)} → ${statusLabel(body.to)}${body.note ? ` — ${body.note}` : ''}` }, req);
    res.json(presentCandidate(me, await loadCandidate(me, row.id)));
  }),
);

/** The candidate's exam scores, replaced whole: one row per exam sat (a blank score removes it). */
hiringRoutes.put(
  '/candidates/:id/exams',
  requireEdit('ghr', 'candidates'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        results: z.array(z.object({ examId: z.string().min(1), score: z.number().nonnegative().max(100000), takenOn: z.string().regex(DAY).optional(), notes: z.string().trim().max(500).optional().nullable() })).max(50),
      }),
      req.body,
    );
    const row = await loadCandidate(me, req.params.id);
    if (!mayEditCandidate(me, row)) throw forbidden('That candidate is someone else’s');
    if (CANDIDATE_CLOSED.includes(row.status as CandidateStatusKey)) throw badRequest(`${nameOf(row)} is ${statusLabel(row.status).toLowerCase()} — their scores are kept as they are`);
    const exams = await prisma.examCatalog.findMany({ where: { id: { in: body.results.map((r) => r.examId) } } });
    const seen = new Set<string>();
    for (const r of body.results) {
      const e = exams.find((x) => x.id === r.examId);
      if (!e) throw badRequest('That exam is not on the catalogue');
      if (seen.has(e.id)) throw badRequest(`${e.name} is listed twice`);
      seen.add(e.id);
      if (r.score > e.maxScore) throw badRequest(`${e.name} is scored out of ${e.maxScore}`);
      if (r.takenOn && r.takenOn > today()) throw badRequest(`${e.name} cannot have been taken on a day still to come`);
    }
    await prisma.$transaction(async (tx) => {
      await tx.examResult.deleteMany({ where: { candidateId: row.id, examId: { notIn: [...seen] } } });
      for (const r of body.results) {
        const data = { score: r.score, takenOn: dayOf(r.takenOn ?? today()), notes: blank(r.notes), examinerId: me.id };
        await tx.examResult.upsert({ where: { candidateId_examId: { candidateId: row.id, examId: r.examId } }, create: { candidateId: row.id, examId: r.examId, ...data }, update: data });
      }
    });
    const after = await loadCandidate(me, row.id);
    // The scores are between HR and the applicant: the trail says what moved, never the figures.
    await audit({ entityType: CANDIDATE, entityId: row.id, action: 'UPDATED', summary: `Recorded ${body.results.length} entrance exam score${body.results.length === 1 ? '' : 's'} for ${nameOf(row)}` }, req);
    res.json(presentCandidate(me, after));
  }),
);

// CVs, licences, IDs: read as the candidate is, added or removed by whoever may change it.
registerAttachmentGuard(
  CANDIDATE,
  async (user, id) => {
    try {
      await loadCandidate(user, id);
      return true;
    } catch {
      return false;
    }
  },
  {
    write: async (user, id) => {
      const row = await prisma.candidate.findUnique({ where: { id }, select: { createdById: true } });
      return !!row && mayEditCandidate(user, row);
    },
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// ENTRANCE EXAMS
// ═════════════════════════════════════════════════════════════════════════════

const EXAM_READERS = ['ghr.entrance_exams.view_all', 'ghr.entrance_exams.view_team', 'ghr.entrance_exams.view_own', 'ghr.candidates.view_all', 'ghr.candidates.view_team', 'ghr.candidates.view_own'] as const;

/** The catalogue, each exam with how many sat it and the hired candidates' average. */
hiringRoutes.get(
  '/exams',
  requireAny(...EXAM_READERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const [exams, benchmark] = await Promise.all([
      prisma.examCatalog.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { results: true } } } }),
      hiredBenchmark(),
    ]);
    res.json({
      canEdit: !!(can(me, 'ghr.entrance_exams.edit_all') || can(me, 'ghr.entrance_exams.edit_own') || can(me, 'ghr.entrance_exams.edit_team')),
      exams: exams.map((e) => ({ ...e, weight: Number(e.weight), sat: e._count.results, benchmark: benchmark.get(e.id)?.pct ?? null, benchmarkCount: benchmark.get(e.id)?.count ?? 0 })),
    });
  }),
);

/**
 * The analytics card: a candidate's percentage per active exam beside the
 * hired candidates' average. Without `candidateId`, the candidates who sat
 * anything (newest first) for the card's picker.
 */
hiringRoutes.get(
  '/exams/analytics',
  requireAny(...EXAM_READERS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const benchmark = await hiredBenchmark();
    const exams = await prisma.examCatalog.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    const scope = viewScope(me, 'ghr', 'candidates');
    const owners = scope && scope !== 'all' ? visibleOwners(me, 'ghr', 'candidates') : null;
    const candidates = scope
      ? await prisma.candidate.findMany({
          where: { examResults: { some: {} }, ...(owners && !me.isSuperAdmin ? { createdById: { in: owners } } : {}) },
          orderBy: { updatedAt: 'desc' },
          take: 100,
          include: candidateInclude,
        })
      : [];
    const pickedId = typeof req.query.candidateId === 'string' ? req.query.candidateId : candidates[0]?.id;
    const picked = candidates.find((c) => c.id === pickedId) ?? null;
    res.json({
      candidates: candidates.map((c) => ({ id: c.id, name: nameOf(c), position: c.mpr.title, status: c.status, examScore: scoreOf(c) })),
      candidate: picked ? { id: picked.id, name: nameOf(picked), position: picked.mpr.title, examScore: scoreOf(picked) } : null,
      rows: exams.map((e) => {
        const mine = picked?.examResults.find((r) => r.examId === e.id);
        return { examId: e.id, name: e.name, candidate: mine ? examPct(Number(mine.score), e.maxScore) : null, benchmark: benchmark.get(e.id)?.pct ?? null, benchmarkCount: benchmark.get(e.id)?.count ?? 0 };
      }),
    });
  }),
);

const examSchema = z.object({
  name: z.string().trim().min(2, 'Name the exam').max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  maxScore: z.number().int().min(1).max(10000).optional(),
  weight: z.number().positive().max(100).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});

async function nameFree(name: string, id?: string) {
  const other = await prisma.examCatalog.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(id ? { id: { not: id } } : {}) } });
  if (other) throw conflict(`${other.name} is on the catalogue already`);
}

hiringRoutes.post(
  '/exams',
  requireEdit('ghr', 'entrance_exams'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(examSchema, req.body);
    await nameFree(body.name);
    const row = await prisma.examCatalog.create({
      data: { name: body.name, description: blank(body.description), maxScore: body.maxScore ?? 100, weight: body.weight ?? 1, sortOrder: body.sortOrder ?? 100, createdById: me.id },
    });
    await audit({ entityType: EXAM, entityId: row.id, action: 'CREATED', summary: `Added the entrance exam ${row.name}` }, req);
    res.status(201).json({ ...row, weight: Number(row.weight) });
  }),
);

hiringRoutes.patch(
  '/exams/:id',
  requireEdit('ghr', 'entrance_exams'),
  handler(async (req, res) => {
    const body = parseBody(examSchema.partial(), req.body);
    const row = await prisma.examCatalog.findUnique({ where: { id: req.params.id }, include: { _count: { select: { results: true } } } });
    if (!row) throw notFound('Exam not found');
    if (body.name) await nameFree(body.name, row.id);
    // A maximum already scored against is fixed: every percentage on file reads by it.
    if (body.maxScore && body.maxScore !== row.maxScore && row._count.results) throw badRequest(`${row.name} has been scored ${row._count.results} time${row._count.results === 1 ? '' : 's'} — its maximum is fixed; add a new exam instead`);
    const updated = await prisma.examCatalog.update({
      where: { id: row.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: blank(body.description) } : {}),
        ...(body.maxScore ? { maxScore: body.maxScore } : {}),
        ...(body.weight ? { weight: body.weight } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    await audit({ entityType: EXAM, entityId: row.id, action: 'UPDATED', summary: `Modified the entrance exam ${updated.name}` }, req);
    res.json({ ...updated, weight: Number(updated.weight) });
  }),
);

/** Only an exam nobody sat, and never a seeded one; anything else is switched off. */
hiringRoutes.delete(
  '/exams/:id',
  requireEdit('ghr', 'entrance_exams'),
  handler(async (req, res) => {
    const row = await prisma.examCatalog.findUnique({ where: { id: req.params.id }, include: { _count: { select: { results: true } } } });
    if (!row) throw notFound('Exam not found');
    if (row.isSystem) throw badRequest(`${row.name} is one of the standard exams — switch it off instead`);
    if (row._count.results) throw badRequest(`${row.name} has been scored — switch it off instead, so the scores keep their exam`);
    await prisma.examCatalog.delete({ where: { id: row.id } });
    await audit({ entityType: EXAM, entityId: row.id, action: 'DELETED', summary: `Deleted the entrance exam ${row.name}` }, req);
    res.json({ ok: true });
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYMENT CONTRACTS
// ═════════════════════════════════════════════════════════════════════════════

const contractInclude = {
  candidate: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
      employeeId: true,
      mpr: { select: { id: true, number: true, title: true, teamId: true, headcount: true, team: { select: { code: true, name: true } } } },
    },
  },
  position: { select: { id: true, code: true, title: true } },
  preparedBy: { select: { id: true, name: true, position: true } },
} satisfies Prisma.EmploymentContractInclude;
type ContractRow = Prisma.EmploymentContractGetPayload<{ include: typeof contractInclude }>;

const mayEditContract = (me: ResolvedUser, k: { preparedById: string }) => canEditRecord(me, 'ghr', 'employment_contracts', k.preparedById);

async function mayReadContract(me: ResolvedUser, k: { id: string; preparedById: string }, deciderOnly = false) {
  if (!deciderOnly && (me.isSuperAdmin || viewScope(me, 'ghr', 'employment_contracts') === 'all' || visibleOwners(me, 'ghr', 'employment_contracts').includes(k.preparedById))) return true;
  return mayDecide(me.id, CONTRACT, [k.id]);
}

async function loadContract(me: ResolvedUser, id: string, deciderOnly = false): Promise<ContractRow> {
  const row = await prisma.employmentContract.findUnique({ where: { id }, include: contractInclude });
  if (!row || !(await mayReadContract(me, row, deciderOnly))) throw notFound('Contract not found');
  return row;
}

/** The submit's own context: the request's team decides the Technical Manager and Team Leader. */
const contractRoute = (k: ContractRow) => ({ amount: Number(k.monthlySalary), requesterId: k.preparedById, teamId: k.candidate.mpr.teamId });

async function presentContract(me: ResolvedUser, k: ContractRow, withRoute = false) {
  const editor = mayEditContract(me, k);
  const draft = k.status === 'DRAFT';
  const r = contractRoute(k);
  return {
    ...k,
    candidateName: nameOf(k.candidate),
    monthlySalary: Number(k.monthlySalary),
    allowances: Number(k.allowances),
    canEdit: draft && editor,
    canSubmit: draft && editor,
    canWithdraw: k.status === 'PENDING_APPROVAL' && editor,
    canCancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SIGNED'].includes(k.status) && editor && k.candidate.status !== 'HIRED',
    canDelete: ['DRAFT', 'CANCELLED'].includes(k.status) && editor && can(me, 'ghr.employment_contracts.delete'),
    canSign: k.status === 'APPROVED' && editor,
    canHire: k.status === 'SIGNED' && editor && k.candidate.status !== 'HIRED',
    approvalRoute: withRoute && draft ? await routeBrief(CONTRACT, r.amount, r.requesterId, null, { teamId: r.teamId }) : null,
  };
}

const CONTRACT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SIGNED', 'CANCELLED'] as const;

function contractListWhere(me: ResolvedUser, q: ListQuery) {
  const and: Prisma.EmploymentContractWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    const t = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ number: t }, { title: t }, { candidate: { OR: [{ firstName: t }, { lastName: t }] } }] });
  }
  if (q.scope === 'mine') and.push({ preparedById: me.id });
  const base = ownOnly<Prisma.EmploymentContractWhereInput>(me, 'ghr', 'employment_contracts', and.length ? { AND: and } : {}, (owners) => ({ preparedById: { in: owners } }));
  const extra: Prisma.EmploymentContractWhereInput[] = [];
  const status = choice(q.filters.status, CONTRACT_STATUSES, 'Status');
  if (status) extra.push({ status });
  if (q.filters.candidateId) extra.push({ candidateId: q.filters.candidateId });
  return { base, where: addAnd(base, extra) };
}

const CONTRACT_SORTS = ['number', 'title', 'status', 'startDate', 'createdAt', 'updatedAt'];

hiringRoutes.get(
  '/contracts',
  requireView('ghr', 'employment_contracts'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = contractListWhere(me, q);
    const [rows, total, groups] = await Promise.all([
      prisma.employmentContract.findMany({ where, include: contractInclude, orderBy: orderBy(q, CONTRACT_SORTS, { createdAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.employmentContract.count({ where }),
      prisma.employmentContract.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    res.json({
      ...listResult(await Promise.all(rows.map((k) => presentContract(me, k))), total, q),
      summary: { drafts: n('DRAFT'), pending: n('PENDING_APPROVAL'), toSign: n('APPROVED'), signed: n('SIGNED') },
    });
  }),
);

/** The candidates a contract may be prepared for — at the contract stage, or past the interview. Above /:id. */
hiringRoutes.get(
  '/contracts/candidates',
  requireAny('ghr.employment_contracts.create'),
  handler(async (_req, res) => {
    const rows = await prisma.candidate.findMany({
      where: { status: { in: ['INTERVIEW_PASSED', 'CONTRACT_STAGE'] }, contracts: { none: { status: { not: 'CANCELLED' } } } },
      include: { mpr: { select: { id: true, number: true, title: true, positionId: true, employmentType: true, salaryMin: true, salaryMax: true, team: { select: { code: true } } } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(rows.map((c) => ({ id: c.id, name: nameOf(c), status: c.status, mpr: { ...c.mpr, salaryMin: num(c.mpr.salaryMin), salaryMax: num(c.mpr.salaryMax) } })));
  }),
);

hiringRoutes.get(
  '/contracts/pdf',
  requireView('ghr', 'employment_contracts'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = contractListWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.employmentContract.findMany({ where, include: contractInclude, orderBy: orderBy(q, CONTRACT_SORTS, { createdAt: 'desc' }), take: LIST_CAP }),
      prisma.employmentContract.count({ where }),
    ]);
    const currency = await companyCurrency();
    const reference = listReference(count, rows.length, ['contract', 'contracts'], [
      q.search ? `search "${q.search}"` : null,
      q.filters.status ? `status ${statusLabel(q.filters.status)}` : null,
      q.scope === 'mine' ? 'mine' : null,
      q.filters.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Employment Contracts',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Employee (hired)', 'Position', `Monthly salary (${currency})`, `Allowances (${currency})`, 'Start date', 'Prepared by', 'Status'],
          rows: rows.map((k) => [
            k.number,
            nameOf(k.candidate),
            k.title,
            Number(k.monthlySalary).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
            Number(k.allowances).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
            formatShortDate(k.startDate),
            k.preparedBy.name,
            statusLabel(k.status),
          ]),
        },
      ],
    });
    await audit({ entityType: CONTRACT, entityId: 'list', action: 'EXPORTED', summary: `Exported the employment contracts as PDF (${listReference(count, rows.length, ['contract', 'contracts'], [])})` }, req);
    sendListPdf(res, pdf, 'employment-contracts.pdf');
  }),
);

export const CONTRACT_TERMS = [
  '1. Probationary period. The Employee is engaged on probation for the period stated, during which their performance is evaluated against the standards made known to them at engagement. Regularization follows a satisfactory evaluation.',
  '2. Hours of work. Mondays to Saturdays, eight (8) hours a day, at the schedule the Company sets; overtime only when authorized in writing.',
  '3. Compensation. The monthly salary and allowances stated, paid on the Company’s payroll cut-offs, less the statutory deductions (SSS, PhilHealth, Pag-IBIG, withholding tax).',
  '4. Duties. The Employee performs the duties of the position and such related tasks as the Company may assign, and follows the Company’s policies and code of conduct.',
  '5. Confidentiality. The Employee keeps the Company’s and its customers’ information confidential during and after employment.',
  '6. Company property. Property issued to the Employee is returned on demand and before the exit clearance closes.',
].join('\n\n');

const contractSchema = z.object({
  candidateId: z.string().min(1, 'Which candidate is this contract for?'),
  positionId: z.string().optional().nullable(),
  title: z.string().trim().min(2, 'Name the position').max(200).optional(),
  monthlySalary: z.number().positive('Name the agreed monthly salary').max(1e9),
  allowances: z.number().nonnegative().max(1e9).optional(),
  allowanceNote: z.string().trim().max(500).optional().nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  startDate: z.string().regex(DAY, 'Name the effective start date'),
  periodEndDate: z.string().regex(DAY).optional().nullable(),
  workLocation: z.string().trim().max(300).optional().nullable(),
  terms: z.string().trim().max(20000).optional().nullable(),
});

function checkContractDates(start: string, end: string | null | undefined) {
  if (end && end <= start) throw badRequest('The probation ends after the start date');
}

hiringRoutes.post(
  '/contracts',
  requireAny('ghr.employment_contracts.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(contractSchema, req.body);
    checkContractDates(body.startDate, body.periodEndDate);
    const candidate = await prisma.candidate.findUnique({ where: { id: body.candidateId }, include: { mpr: true } });
    if (!candidate) throw badRequest('That candidate does not exist');
    if (!['INTERVIEW_PASSED', 'CONTRACT_STAGE'].includes(candidate.status)) throw badRequest(`${nameOf(candidate)} is ${statusLabel(candidate.status).toLowerCase()} — a contract follows a passed interview`);
    if (body.positionId) {
      const p = await prisma.position.findUnique({ where: { id: body.positionId }, select: { isActive: true } });
      if (!p?.isActive) throw badRequest('That position is not active on the Plantilla');
    }
    const row = await prisma.$transaction(async (tx) => {
      // One standing contract per candidate, decided under a lock on the candidate's row.
      await tx.$queryRaw`SELECT id FROM "Candidate" WHERE id = ${candidate.id} FOR UPDATE`;
      const live = await tx.employmentContract.findFirst({ where: { candidateId: candidate.id, status: { not: 'CANCELLED' } }, select: { number: true } });
      if (live) throw conflict(`${live.number} stands for ${nameOf(candidate)} already`);
      if (candidate.status === 'INTERVIEW_PASSED') {
        await tx.candidate.update({ where: { id: candidate.id }, data: { status: 'CONTRACT_STAGE' } });
        await tx.candidateEvent.create({ data: { candidateId: candidate.id, fromStatus: 'INTERVIEW_PASSED', toStatus: 'CONTRACT_STAGE', on: dayOf(today()), note: 'Contract prepared', byId: me.id } });
      }
      const number = await nextNumber(CONTRACT, tx);
      return tx.employmentContract.create({
        data: {
          number,
          candidateId: candidate.id,
          positionId: body.positionId !== undefined ? body.positionId || null : candidate.mpr.positionId,
          title: body.title ?? candidate.mpr.title,
          monthlySalary: body.monthlySalary,
          allowances: body.allowances ?? 0,
          allowanceNote: blank(body.allowanceNote),
          employmentType: (body.employmentType ?? candidate.mpr.employmentType) as EmploymentType,
          startDate: dayOf(body.startDate),
          periodEndDate: body.periodEndDate ? dayOf(body.periodEndDate) : null,
          workLocation: blank(body.workLocation),
          terms: body.terms !== undefined ? blank(body.terms) : CONTRACT_TERMS,
          preparedById: me.id,
        },
        include: contractInclude,
      });
    });
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'CREATED', summary: `Prepared ${row.number} for ${nameOf(row.candidate)} — ${row.title}` }, req);
    res.status(201).json(await presentContract(me, row, true));
  }),
);

hiringRoutes.get(
  '/contracts/:id',
  requireAnyOrDecider('ghr.employment_contracts.view_all', 'ghr.employment_contracts.view_team', 'ghr.employment_contracts.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadContract(me, req.params.id, res.locals.deciderOnly === true);
    res.json({ ...(await presentContract(me, row, true)), currency: await companyCurrency() });
  }),
);

const CONTRACT_EDIT_RIGHTS = ['ghr.employment_contracts.create', 'ghr.employment_contracts.edit_own', 'ghr.employment_contracts.edit_team', 'ghr.employment_contracts.edit_all'] as const;

hiringRoutes.patch(
  '/contracts/:id',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(contractSchema.omit({ candidateId: true }).partial(), req.body);
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('That contract is someone else’s');
    if (row.status !== 'DRAFT') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — pull it back to draft to change it`);
    checkContractDates(body.startDate ?? keyOf(row.startDate)!, body.periodEndDate !== undefined ? body.periodEndDate : keyOf(row.periodEndDate));
    const claimed = await prisma.employmentContract.updateMany({
      where: { id: row.id, status: 'DRAFT' },
      data: {
        ...(body.positionId !== undefined ? { positionId: body.positionId || null } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.monthlySalary ? { monthlySalary: body.monthlySalary } : {}),
        ...(body.allowances !== undefined ? { allowances: body.allowances } : {}),
        ...(body.allowanceNote !== undefined ? { allowanceNote: blank(body.allowanceNote) } : {}),
        ...(body.employmentType ? { employmentType: body.employmentType } : {}),
        ...(body.startDate ? { startDate: dayOf(body.startDate) } : {}),
        ...(body.periodEndDate !== undefined ? { periodEndDate: body.periodEndDate ? dayOf(body.periodEndDate) : null } : {}),
        ...(body.workLocation !== undefined ? { workLocation: blank(body.workLocation) } : {}),
        ...(body.terms !== undefined ? { terms: blank(body.terms) } : {}),
      },
    });
    if (!claimed.count) throw conflict('It moved a moment ago — reload to see where it stands');
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'UPDATED', summary: `Modified ${row.number}` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

hiringRoutes.post(
  '/contracts/:id/submit',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('Only the person who prepared this contract can submit it');
    const claimed = await prisma.employmentContract.updateMany({ where: { id: row.id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('This contract has already been submitted');
    const r = contractRoute(row);
    try {
      await submitForApproval({
        documentType: CONTRACT,
        documentId: row.id,
        documentNumber: row.number,
        subject: `${nameOf(row.candidate)} — ${row.title}`,
        amount: r.amount,
        link: CONTRACT_LINK(row.id),
        requesterId: r.requesterId,
        teamId: r.teamId,
      });
    } catch (err) {
      await prisma.employmentContract.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      throw err;
    }
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'SUBMITTED', summary: `${row.number} sent for approval` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

hiringRoutes.post(
  '/contracts/:id/withdraw',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('Only the person who prepared this contract can pull it back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.employmentContract.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — the decision stands');
      await cancelOpenRequest(CONTRACT, row.id, tx, `pulled back by ${me.name}`, me.id);
    });
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

/** Any contract nobody was hired on; a pending one's request withdrawn in the same transaction. */
hiringRoutes.post(
  '/contracts/:id/cancel',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { reason } = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }), req.body ?? {});
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('Only the person who prepared this contract can cancel it');
    if (row.candidate.status === 'HIRED') throw badRequest(`${nameOf(row.candidate)} was hired on ${row.number} — it is kept`);
    if (row.status === 'CANCELLED') throw badRequest(`${row.number} is cancelled already`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.employmentContract.updateMany({ where: { id: row.id, status: row.status }, data: { status: 'CANCELLED', cancelReason: reason } });
      if (!claimed.count) throw badRequest('It moved a moment ago — reload to see where it stands');
      await cancelOpenRequest(CONTRACT, row.id, tx, `cancelled by ${me.name}: ${reason}`, me.id);
    });
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${reason}` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

hiringRoutes.delete(
  '/contracts/:id',
  requireAny('ghr.employment_contracts.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('That contract is someone else’s');
    if (!['DRAFT', 'CANCELLED'].includes(row.status)) throw badRequest('Only a draft or a cancelled contract can be deleted — an approved one is a record');
    await deleteOrRefuse(row.number, () => prisma.employmentContract.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf(CONTRACT, [row.id]);
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'DELETED', summary: `Deleted ${statusLabel(row.status).toLowerCase()} ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

/** HR records the signed paper: the day the hire signed it. APPROVED → SIGNED. */
hiringRoutes.post(
  '/contracts/:id/signed',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ signedOn: z.string().regex(DAY).optional() }), req.body ?? {});
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('Only the person who prepared this contract records its signing');
    const on = body.signedOn ?? today();
    if (on > today()) throw badRequest('It is signed on a day that has come');
    const claimed = await prisma.employmentContract.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'SIGNED', signedOn: dayOf(on) } });
    if (!claimed.count) throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved contract is signed`);
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'COMPLETED', summary: `${row.number} signed by ${nameOf(row.candidate)} on ${on}` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

/**
 * The hire: the employee record was made through the one employee form
 * (prefilled from this contract), and this links it — the candidate HIRED
 * with a dated event, the request FILLED once its headcount is met, the
 * contract's files copied onto the employee's record. Claimed on the
 * candidate's status, so one candidate is hired once.
 */
hiringRoutes.post(
  '/contracts/:id/hire',
  requireAny(...CONTRACT_EDIT_RIGHTS),
  handler(async (req, res) => {
    const me = currentUser(req);
    const { employeeId } = parseBody(z.object({ employeeId: z.string().min(1, 'Which employee record?') }), req.body);
    const row = await loadContract(me, req.params.id);
    if (!mayEditContract(me, row)) throw forbidden('Only the person who prepared this contract records the hire');
    if (row.status !== 'SIGNED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — the hire follows the signed contract`);
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, firstName: true, lastName: true, hiredFrom: { select: { id: true } } } });
    if (!employee) throw badRequest('That employee record does not exist');
    if (employee.hiredFrom && employee.hiredFrom.id !== row.candidateId) throw conflict(`${employee.firstName} ${employee.lastName} was hired from another candidate`);
    const filled = await prisma.$transaction(async (tx) => {
      const claimed = await tx.candidate.updateMany({ where: { id: row.candidateId, status: 'CONTRACT_STAGE' }, data: { status: 'HIRED', employeeId: employee.id } });
      if (!claimed.count) throw conflict(`${nameOf(row.candidate)} is ${statusLabel(row.candidate.status).toLowerCase()} — reload to see where they stand`);
      await tx.candidateEvent.create({ data: { candidateId: row.candidateId, fromStatus: 'CONTRACT_STAGE', toStatus: 'HIRED', on: row.startDate, note: `Hired on ${row.number}`, byId: me.id } });
      const hired = await tx.candidate.count({ where: { mprId: row.candidate.mpr.id, status: 'HIRED' } });
      if (hired >= row.candidate.mpr.headcount) {
        const n = await tx.manpowerRequest.updateMany({ where: { id: row.candidate.mpr.id, status: 'APPROVED' }, data: { status: 'FILLED', filledAt: new Date() } });
        return n.count > 0;
      }
      return false;
    });
    await copyAttachments({ entityType: CONTRACT, entityId: row.id }, { entityType: 'employee', entityId: employee.id }, `From contract ${row.number}`, me.id).catch((err) => console.error('[hiring] contract files not copied', err));
    await audit({ entityType: CANDIDATE, entityId: row.candidateId, action: 'COMPLETED', summary: `${nameOf(row.candidate)} hired on ${row.number} as ${employee.firstName} ${employee.lastName}` }, req);
    if (filled) await audit({ entityType: MPR, entityId: row.candidate.mpr.id, action: 'COMPLETED', summary: `${row.candidate.mpr.number} filled — ${row.candidate.mpr.headcount} hired` }, req);
    res.json(await presentContract(me, await loadContract(me, row.id), true));
  }),
);

export async function settleEmploymentContract(approval: ApprovalRequest, outcome: ApprovalOutcome) {
  const row = await prisma.employmentContract.findUnique({ where: { id: approval.documentId } });
  if (!row) return;
  const claimed = await prisma.employmentContract.updateMany({
    where: { id: row.id, status: 'PENDING_APPROVAL' },
    data: outcome === 'APPROVED' ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'DRAFT' },
  });
  if (!claimed.count) {
    await audit({ entityType: CONTRACT, entityId: row.id, action: outcome, summary: `${row.number} ${outcome.toLowerCase()} after it was ${statusLabel(row.status).toLowerCase()} — not applied` });
    return;
  }
  await audit({ entityType: CONTRACT, entityId: row.id, action: outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED', summary: outcome === 'APPROVED' ? `${row.number} approved — print it for signing` : `${row.number} returned to draft` });
}
onApprovalSettled(CONTRACT, settleEmploymentContract);

onApprovalReopened(CONTRACT, {
  may: async (actor, id) => {
    const row = await prisma.employmentContract.findUnique({ where: { id }, select: { preparedById: true } });
    return !!row && mayEditContract(actor, row);
  },
  reopen: async ({ documentId, tx }) => {
    const row = await tx.employmentContract.findUnique({ where: { id: documentId }, select: { id: true, number: true, status: true } });
    if (!row) throw notFound('Contract not found');
    if (row.status !== 'APPROVED') throw badRequest(`${row.number} is ${statusLabel(row.status).toLowerCase()} — only an approved, unsigned contract goes back to draft`);
    const claimed = await tx.employmentContract.updateMany({ where: { id: row.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
  },
});

/**
 * "Employment Contract" for the WET signature: the parties, the position, the
 * pay, the dates, the terms; then Prepared by and the route's four steps
 * (dated, "Pending" until each signs), and the Conforme block the hire and
 * the company sign by hand. The files behind it unless `?attachments=0`.
 */
hiringRoutes.get(
  '/contracts/:id/pdf',
  requireAnyOrDecider('ghr.employment_contracts.view_all', 'ghr.employment_contracts.view_team', 'ghr.employment_contracts.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await loadContract(me, req.params.id, res.locals.deciderOnly === true);
    const currency = await companyCurrency();
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { legalName: true, name: true } });
    const legalName = company?.legalName?.trim() || company?.name?.trim() || 'the Company';
    const slots = row.status === 'DRAFT' ? await approvalSlots(CONTRACT, row.id, contractRoute(row)) : await approvalSlots(CONTRACT, row.id);
    const signatories: Signatory[] = [
      { role: 'Prepared by', name: row.preparedBy.name, ...(await contactOf(row.preparedById)), at: preparedAt(slots) ?? row.createdAt },
      ...slotSignatories(slots),
    ];
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'Employee name (hired)', value: nameOf(row.candidate) },
          { label: 'Position title', value: row.title },
          { label: 'Agreed monthly salary', value: `${formatMoney(Number(row.monthlySalary), currency)} / month` },
          { label: 'Allowances', value: Number(row.allowances) ? `${formatMoney(Number(row.allowances), currency)} / month${row.allowanceNote ? ` — ${row.allowanceNote}` : ''}` : row.allowanceNote ?? 'None' },
          { label: 'Employment type', value: statusLabel(row.employmentType) },
          { label: 'Contract effective start date', value: formatDate(row.startDate) },
          { label: 'Probation ends', value: row.periodEndDate ? formatDate(row.periodEndDate) : '' },
          { label: 'Work location', value: row.workLocation ?? '' },
          { label: 'Man power request', value: `${row.candidate.mpr.number} — ${row.candidate.mpr.title}` },
          { label: 'Team', value: row.candidate.mpr.team ? `${row.candidate.mpr.team.code} — ${row.candidate.mpr.team.name}` : '' },
        ],
      },
      {
        kind: 'text',
        title: 'Agreement',
        body: `This contract is entered into by ${legalName} (the Company) and ${nameOf(row.candidate)} (the Employee), who is engaged as ${row.title} on the terms below, effective ${formatDate(row.startDate)}.`,
      },
    ];
    if (row.terms) sections.push({ kind: 'text', title: 'Terms and conditions', body: row.terms });
    if (row.status === 'CANCELLED' && row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    // The wet signatures: the approvals above are dated on G-CORE; the hire
    // and the company's representative sign this copy by hand.
    sections.push({
      kind: 'text',
      title: 'Conforme',
      body: [
        'Signed by both parties on the date written below, in two copies, each party keeping one.',
        '',
        `EMPLOYEE: ${nameOf(row.candidate)}`,
        'Signature over printed name: ______________________________    Date: ________________',
        '',
        `FOR ${legalName.toUpperCase()}:`,
        'Signature over printed name: ______________________________    Date: ________________',
        row.signedOn ? `\nRecorded on G-CORE as signed on ${formatDate(row.signedOn)}.` : '',
      ].join('\n'),
    });
    const bare = await renderDocument({
      title: 'Employment Contract',
      documentNumber: row.number,
      date: row.createdAt,
      reference: `${nameOf(row.candidate)} · ${row.title}`,
      sections,
      signatories,
      footerNote: row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL' ? 'DRAFT — NOT YET APPROVED.' : row.status === 'CANCELLED' ? 'CANCELLED.' : undefined,
    });
    const pdf = req.query.attachments === '0' ? bare : (await withAttachments(bare, await attachedFiles(CONTRACT, row.id), { title: 'Employment Contract', number: row.number })).pdf;
    await audit({ entityType: CONTRACT, entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number} for signing` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Employment Contract', number: row.number, author: row.preparedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

// The signed copy, IDs, the offer: read as the contract is, written by whoever may change it.
registerAttachmentGuard(
  CONTRACT,
  async (user, id) => {
    const row = await prisma.employmentContract.findUnique({ where: { id }, select: { id: true, preparedById: true } });
    return !!row && (await mayReadContract(user, row));
  },
  {
    write: async (user, id) => {
      const row = await prisma.employmentContract.findUnique({ where: { id }, select: { preparedById: true } });
      return !!row && mayEditContract(user, row);
    },
  },
);

// ── Ctrl+K ───────────────────────────────────────────────────────────────────

registerSearch({
  kind: MPR,
  label: 'Man power requests',
  permission: ['ghr.manpower_requests.view_all', 'ghr.manpower_requests.view_team', 'ghr.manpower_requests.view_own'],
  ownWhere: (user) => ({ requestedById: user.id }),
  search: async (term, _user, limit, own) => {
    const t = { contains: term, mode: 'insensitive' as const };
    const rows = await prisma.manpowerRequest.findMany({ where: { AND: [own ?? {}, { OR: [{ number: t }, { title: t }] }] }, take: limit, orderBy: { updatedAt: 'desc' } });
    return rows.map((r) => ({ kind: MPR, id: r.id, title: `${r.number} — ${r.title}`, subtitle: `${r.headcount} wanted · ${statusLabel(r.status)}`, link: MPR_LINK(r.id) }));
  },
});

registerSearch({
  kind: CANDIDATE,
  label: 'Candidates',
  permission: ['ghr.candidates.view_all', 'ghr.candidates.view_team', 'ghr.candidates.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  search: async (term, _user, limit, own) => {
    const t = { contains: term, mode: 'insensitive' as const };
    const rows = await prisma.candidate.findMany({
      where: { AND: [own ?? {}, { OR: [{ firstName: t }, { lastName: t }, { email: t }] }] },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: { mpr: { select: { title: true } } },
    });
    return rows.map((c) => ({ kind: CANDIDATE, id: c.id, title: nameOf(c), subtitle: `${c.mpr.title} · ${statusLabel(c.status)}`, link: CANDIDATE_LINK(c.id) }));
  },
});

registerSearch({
  kind: CONTRACT,
  label: 'Employment contracts',
  permission: ['ghr.employment_contracts.view_all', 'ghr.employment_contracts.view_team', 'ghr.employment_contracts.view_own'],
  ownWhere: (user) => ({ preparedById: user.id }),
  search: async (term, _user, limit, own) => {
    const t = { contains: term, mode: 'insensitive' as const };
    const rows = await prisma.employmentContract.findMany({
      where: { AND: [own ?? {}, { OR: [{ number: t }, { title: t }, { candidate: { OR: [{ firstName: t }, { lastName: t }] } }] }] },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: { candidate: { select: { firstName: true, lastName: true } } },
    });
    return rows.map((k) => ({ kind: CONTRACT, id: k.id, title: `${k.number} — ${nameOf(k.candidate)}`, subtitle: `${k.title} · ${statusLabel(k.status)}`, link: CONTRACT_LINK(k.id) }));
  },
});

