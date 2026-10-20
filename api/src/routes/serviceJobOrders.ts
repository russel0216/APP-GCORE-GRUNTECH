import { Router } from 'express';
import { z } from 'zod';
import { Prisma, JobOrderStatus, ServiceKind, ChargeBasis } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, forbidden, idsFilter, deleteOrRefuse, type ListQuery } from '../http/kit';
import { deleteAttachmentsOf } from '../shared/attachments';
import { authenticate, require_, requireAny, requireAnyOrDecider, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import {
  submitForApproval,
  onApprovalSettled,
  onApprovalReopened,
  approvalSlots,
  slotSignatories,
  contactOf,
  cancelOpenRequest,
  openSteps,
  stageWords,
  mayDecide,
  type ApprovalOutcome,
  type ApprovalSlot,
} from '../shared/approvals';
import { renderDocument, formatDate, formatMoney, formatAmount, formatShortDate, statusLabel, companyCurrency, type PdfSection, type Signatory } from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { dayKey, OPEN_VISIT_STATUSES, slotLabel } from '../shared/aftermarket';
import { KIND_LABEL } from './aftermarket';
import { manilaDayStart, manilaDayEnd } from '../shared/day';
import { teamOf } from '../shared/team';
import { LIST_CAP, listReference, totalLabel, rangeNamed, recordNamed, namedInFilter, filterDay, dayOf, choice, bracketed, bracketNote, listNotes, sendListPdf } from '../shared/listPaper';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { viewScope } from '../shared/ownScope';

/**
 * Service JOs — the SERVICE CALL on a registered machine (2026-10-20, the
 * owner's revised Aftermarket UI; what the job order was before the project
 * work order of 2026-10-09 took its table).
 *
 * The same `JobOrder` table, `category: SERVICE`: the machine from the
 * Installation Base, the activity type (commissioning, PM, inspection,
 * corrective), the priority (urgent), the day it is needed by (`requestedFor`),
 * the assigned engineer, what covers it (a contract, the warranty, chargeable,
 * goodwill) and the scope in one box. Its route is the Aftermarket Manager on
 * the requester's own team, then the requester's Team Leader; APPROVAL BOOKS
 * THE VISIT — never a project — and the approved report on that visit
 * completes it (`onReportSettled` in routes/aftermarket.ts). The register is
 * `/g-ops/service-job-orders` under Aftermarket; the project work order keeps
 * `/g-ops/job-orders` and its own category.
 */

export const serviceJobOrderRoutes = Router();
serviceJobOrderRoutes.use(authenticate);

const DOC = 'service_job_order';
const PATH = '/g-ops/service-job-orders';

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

const person = { select: { id: true, name: true, position: true } } as const;

const include = {
  customer: { select: { id: true, code: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  contact: { select: { id: true, name: true, phone: true } },
  asset: { select: { id: true, code: true, name: true, model: true, serialNo: true, address: true, warrantyEndsAt: true } },
  contract: { select: { id: true, number: true, status: true, endsAt: true } },
  job: { select: { id: true, number: true, name: true, status: true } },
  requestedBy: person,
  assignedTo: { select: { id: true, name: true, position: true, employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } },
  team: { select: { id: true, code: true, name: true } },
  visit: {
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      startTime: true,
      endTime: true,
      performedAt: true,
      report: { select: { id: true, number: true, status: true } },
    },
  },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.JobOrderInclude;

type Row = Prisma.JobOrderGetPayload<{ include: typeof include }>;

/** REJECTED reads "Returned": the order goes back to whoever raised it. */
const statusWord = (status: string) => statusLabel(status === 'REJECTED' ? 'RETURNED' : status);

/**
 * The status in the spec's words: Draft; AM Approval / TL Approval while a
 * step waits; once approved, Dispatch pending until the visit's day, In
 * progress from that day, Missed visit if the sweep marked it; Done, Returned,
 * Cancelled.
 */
function stageOf(row: Row, today: Date, openStep?: string): string {
  if (row.status === 'PENDING_APPROVAL') {
    if (openStep && /aftermarket manager|service manager/i.test(openStep)) return 'AM Approval';
    return stageWords(row.status, openStep, false);
  }
  if (row.status === 'APPROVED') {
    if (row.visit?.status === 'MISSED') return 'Missed visit';
    if (row.visit && OPEN_VISIT_STATUSES.includes(row.visit.status) && row.visit.dueDate <= today) return 'In progress';
    return 'Dispatch pending';
  }
  if (row.status === 'COMPLETED') return 'Done';
  return statusWord(row.status);
}

function present(row: Row, today: Date, openStep?: string) {
  const { assignedTo, ...rest } = row;
  return {
    ...rest,
    stageLabel: stageOf(row, today, openStep),
    neededBy: row.requestedFor,
    amount: num(row.amount),
    billable: row.chargeBasis === 'CHARGEABLE',
    assignedTo: assignedTo ? { id: assignedTo.id, name: assignedTo.name, position: assignedTo.position, team: assignedTo.employee?.industry ?? null } : null,
    visit: row.visit ? { ...row.visit, slot: slotLabel(row.visit.startTime, row.visit.endTime) } : null,
  };
}

function onlyOwn(me: ResolvedUser): boolean {
  return !can(me, 'gops.service_job_orders.view_all');
}

/** "Mine": raised by, or sent on, the viewer. */
const peopleWhere = (ids: string[]): Prisma.JobOrderWhereInput => ({ OR: [{ requestedById: { in: ids } }, { assignedToId: { in: ids } }] });

function onIt(me: ResolvedUser, row: Row): boolean {
  return row.requestedById === me.id || row.assignedToId === me.id;
}

/** View Team: an order of the viewer's team, or one raised by or sending somebody on it. */
function onTeam(me: ResolvedUser, row: Row): boolean {
  if (viewScope(me, 'gops', 'service_job_orders') !== 'team') return false;
  if (me.teamId && row.teamId === me.teamId) return true;
  return [row.requestedById, row.assignedToId].some((id) => !!id && me.teamMemberIds.includes(id));
}

function mayOpen(me: ResolvedUser, row: Row): boolean {
  return !onlyOwn(me) || onIt(me, row) || onTeam(me, row);
}

async function load(id: string): Promise<Row> {
  const row = await prisma.jobOrder.findUnique({ where: { id }, include });
  if (!row || row.category !== 'SERVICE') throw notFound('Service JO not found');
  return row;
}

const subjectOf = (row: { title: string; customer: { name: string }; asset: { name: string } | null }) =>
  `${row.title} — ${row.asset ? `${row.asset.name}, ` : ''}${row.customer.name}`;

/**
 * The order's route, one slot a step: a draft or a returned order shows the
 * route submitting it now would take; a cancelled one prints only signatures
 * that stand (the project work order's rule).
 */
async function routeSlots(row: Row): Promise<ApprovalSlot[]> {
  if (row.status === 'CANCELLED') {
    const latest = await prisma.approvalRequest.findFirst({ where: { documentType: DOC, documentId: row.id }, orderBy: { createdAt: 'desc' }, select: { status: true } });
    return latest?.status === 'APPROVED' ? approvalSlots(DOC, row.id) : [];
  }
  const unsubmitted = row.status === 'DRAFT' || row.status === 'REJECTED';
  return approvalSlots(DOC, row.id, unsubmitted ? { amount: num(row.amount), requesterId: row.requestedById, jobId: row.jobId } : undefined);
}

// ── List ────────────────────────────────────────────────────────────────────

const SORTS = ['number', 'requestedFor', 'createdAt'];
const OPEN_STATUSES: JobOrderStatus[] = ['PENDING_APPROVAL', 'APPROVED'];

/** Which Service JOs a list query means — one rule for the rows, the cards and the paper. */
function listWhere(me: ResolvedUser, q: ListQuery): { base: Prisma.JobOrderWhereInput; where: Prisma.JobOrderWhereInput } {
  const and: Prisma.JobOrderWhereInput[] = [];
  if (q.scope === 'mine') and.push(peopleWhere([me.id]));
  else if (onlyOwn(me)) {
    const team = viewScope(me, 'gops', 'service_job_orders') === 'team';
    and.push(team ? { OR: [peopleWhere(me.teamMemberIds), ...(me.teamId ? [{ teamId: me.teamId }] : [])] } : peopleWhere([me.id]));
  }
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { requestedBy: { name: { contains: q.search, mode: 'insensitive' } } },
        { assignedTo: { name: { contains: q.search, mode: 'insensitive' } } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { asset: { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { serialNo: { contains: q.search, mode: 'insensitive' } }] } },
      ],
    });
  }
  const base: Prisma.JobOrderWhereInput = { category: 'SERVICE', ...(and.length ? { AND: and } : {}) };

  const where: Prisma.JobOrderWhereInput = { ...base };
  const statuses = (q.filters.status ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => choice(v, JobOrderStatus, 'Status', statusWord)!);
  if (statuses.length) where.status = { in: statuses };
  if (q.filters.open === 'true') where.status = { in: OPEN_STATUSES };
  if (q.filters.kind) where.kind = choice(q.filters.kind, ServiceKind, 'Service type', (k) => KIND_LABEL[k] ?? k)!;
  if (q.filters.urgent === 'true') where.urgent = true;
  if (q.filters.chargeBasis) where.chargeBasis = choice(q.filters.chargeBasis, ChargeBasis, 'Covered by', statusLabel)!;
  if (q.filters.teamId) where.teamId = q.filters.teamId === 'none' ? null : q.filters.teamId;
  for (const key of ['customerId', 'requestedById'] as const) {
    if (q.filters[key]) where[key] = q.filters[key];
  }
  for (const key of ['assetId', 'contractId', 'assignedToId'] as const) {
    if (q.filters[key]) where[key] = q.filters[key] === 'none' ? null : q.filters[key];
  }
  const createdFrom = filterDay(q.filters.createdFrom, 'Requested from');
  const createdTo = filterDay(q.filters.createdTo, 'Requested to');
  if (createdFrom || createdTo) {
    where.createdAt = { ...(createdFrom ? { gte: manilaDayStart(createdFrom) } : {}), ...(createdTo ? { lte: manilaDayEnd(createdTo) } : {}) };
  }
  const from = filterDay(q.filters.from, 'Needed from');
  const to = filterDay(q.filters.to, 'Needed to');
  if (from || to) where.requestedFor = { ...(from ? { gte: dayOf(from) } : {}), ...(to ? { lte: dayOf(to) } : {}) };
  return { base, where };
}

const stepsOf = (rows: Row[]) => openSteps(DOC, rows.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.id));

serviceJobOrderRoutes.get(
  '/',
  requireAny('gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = listWhere(me, q);
    const today = dayKey(new Date());
    const [rows, total, byStatus, dispatch, urgent] = await Promise.all([
      prisma.jobOrder.findMany({ where, include, orderBy: orderBy(q, SORTS, { requestedFor: 'asc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.jobOrder.count({ where }),
      prisma.jobOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      // Approved, the visit booked but its day not yet come.
      prisma.jobOrder.count({ where: { AND: [base, { status: 'APPROVED', visit: { is: { status: { in: OPEN_VISIT_STATUSES }, dueDate: { gt: today } } } }] } }),
      prisma.jobOrder.count({ where: { AND: [base, { urgent: true, status: { in: OPEN_STATUSES } }] } }),
    ]);
    const counts: Record<string, number> = {};
    for (const r of byStatus) counts[r.status] = r._count._all;
    const steps = await stepsOf(rows);
    res.json({
      ...listResult(rows.map((r) => present(r, today, steps.get(r.id))), total, q),
      summary: {
        open: (counts.PENDING_APPROVAL ?? 0) + (counts.APPROVED ?? 0),
        pendingApproval: counts.PENDING_APPROVAL ?? 0,
        dispatchPending: dispatch,
        urgent,
        done: counts.COMPLETED ?? 0,
      },
    });
  }),
);

/** The register on paper (rule 6, A5): the list's own query, or the rows ticked; landscape. Declared above /:id. */
serviceJobOrderRoutes.get(
  '/pdf',
  requireAny('gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = listWhere(me, q);
    const f = q.filters;
    const today = dayKey(new Date());
    const [rows, count, live, cancelled, currency, named, assignee, requester, asset] = await Promise.all([
      prisma.jobOrder.findMany({ where, include, orderBy: orderBy(q, SORTS, { requestedFor: 'asc' }), take: LIST_CAP }),
      prisma.jobOrder.count({ where }),
      prisma.jobOrder.aggregate({ where: { AND: [where, { status: { not: 'CANCELLED' } }] }, _sum: { amount: true } }),
      prisma.jobOrder.count({ where: { AND: [where, { status: 'CANCELLED' }] } }),
      companyCurrency(),
      namedInFilter({ customerId: f.customerId }),
      recordNamed('person', f.assignedToId, 'assigned to'),
      recordNamed('person', f.requestedById, 'requested by'),
      f.assetId ? prisma.installedAsset.findUnique({ where: { id: f.assetId }, select: { name: true, serialNo: true } }) : null,
    ]);
    const steps = await stepsOf(rows);
    const reference = listReference(count, rows.length, ['service JO', 'service JOs'], [
      q.search ? `search "${q.search}"` : null,
      f.status && f.open !== 'true' ? `status ${f.status.split(',').map(statusWord).join(' or ')}` : null,
      f.open === 'true' ? 'open (awaiting approval or approved)' : null,
      f.kind ? `type ${KIND_LABEL[f.kind] ?? f.kind}` : null,
      f.urgent === 'true' ? 'urgent' : null,
      f.chargeBasis ? `covered by ${statusLabel(f.chargeBasis).toLowerCase()}` : null,
      named.customer ? `customer ${named.customer}` : null,
      asset ? `machine ${asset.name}${asset.serialNo ? ` (${asset.serialNo})` : ''}` : f.assetId ? 'machine not found' : null,
      assignee,
      requester,
      rangeNamed('requested', f.createdFrom, f.createdTo),
      rangeNamed('needed', f.from, f.to),
      q.scope === 'mine' ? 'raised by me or sending me' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Service JOs',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['SJO No.', 'Requested', 'Requester', 'Customer and machine', 'Service type', 'Needed by', 'Engineer', 'Covered by', `Amount (${currency})`, 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'],
          rows: rows.map((r) => [
            r.number,
            formatShortDate(r.createdAt),
            r.requestedBy.name,
            { title: r.customer.name, body: r.asset ? [r.asset.name, r.asset.model, r.asset.serialNo].filter(Boolean).join(' · ') : r.title },
            `${KIND_LABEL[r.kind] ?? r.kind}${r.urgent ? '\nURGENT' : ''}`,
            formatShortDate(r.requestedFor),
            r.assignedTo?.name ?? '—',
            statusLabel(r.chargeBasis),
            r.amount == null ? (r.chargeBasis === 'CHARGEABLE' ? 'To be billed on completion' : '—') : bracketed(formatAmount(Number(r.amount)), r.status !== 'CANCELLED'),
            stageOf(r, today, steps.get(r.id)),
          ]),
        },
        { kind: 'totals', rows: [{ label: totalLabel('Total before VAT', count, rows.length), value: formatMoney(Number(live._sum.amount ?? 0), currency), bold: true }] },
        ...listNotes([bracketNote(cancelled, ['cancelled service JO', 'cancelled service JOs'])]),
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the Service JO list as PDF (${listReference(count, rows.length, ['service JO', 'service JOs'], [])})` }, req);
    sendListPdf(res, pdf, 'service-jos.pdf');
  }),
);

// ── The form's pickers (above /:id) ─────────────────────────────────────────

/**
 * For one customer: its machines on the Installation Base (each with its
 * active contract, so picking a machine fills the cover), its active
 * contracts, sites and contacts. Behind the form's own right.
 */
serviceJobOrderRoutes.get(
  '/options',
  requireAny('gops.service_job_orders.create', 'gops.service_job_orders.edit_own', 'gops.service_job_orders.edit_all'),
  handler(async (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
    if (!customerId) {
      const customers = await prisma.customer.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { name: 'asc' }, take: 1000 });
      res.json({ customers });
      return;
    }
    const today = dayKey(new Date());
    const [sites, contacts, assets, contracts] = await Promise.all([
      prisma.customerSite.findMany({ where: { customerId }, select: { id: true, name: true, city: true }, orderBy: { name: 'asc' } }),
      prisma.customerContact.findMany({ where: { customerId }, select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' } }),
      prisma.installedAsset.findMany({
        where: { customerId, status: { not: 'DECOMMISSIONED' } },
        select: {
          id: true,
          code: true,
          name: true,
          model: true,
          serialNo: true,
          siteId: true,
          address: true,
          warrantyEndsAt: true,
          contracts: { where: { contract: { status: 'ACTIVE' } }, select: { contract: { select: { id: true, number: true, endsAt: true } } }, take: 1 },
        },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      // A contract's customer is its job's (a service contract IS a job of type SERVICE_CONTRACT).
      prisma.serviceContract.findMany({ where: { job: { customerId }, status: 'ACTIVE' }, select: { id: true, number: true, endsAt: true }, orderBy: { endsAt: 'asc' } }),
    ]);
    res.json({
      sites,
      contacts,
      assets: assets.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        model: a.model,
        serialNo: a.serialNo,
        siteId: a.siteId,
        address: a.address,
        underWarranty: !!a.warrantyEndsAt && a.warrantyEndsAt >= today,
        contractId: a.contracts[0]?.contract.id ?? null,
        contractNumber: a.contracts[0]?.contract.number ?? null,
      })),
      contracts,
    });
  }),
);

// ── Create and edit ─────────────────────────────────────────────────────────

const schema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  assetId: z.string().optional().nullable(),
  contractId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  contactNumber: z.string().trim().max(60).optional().nullable(),
  title: z.string().trim().min(3, 'Say in a line what the job is').max(300),
  scope: z.string().trim().min(5, 'Describe the work').max(20000),
  kind: z.nativeEnum(ServiceKind),
  urgent: z.boolean().optional(),
  neededBy: z.string().regex(DAY, 'Use a date'),
  assignedToId: z.string().optional().nullable(),
  teamId: z.string().optional().nullable(),
  chargeBasis: z.nativeEnum(ChargeBasis).optional().nullable(),
  customerPoNumber: z.string().trim().max(120).optional().nullable(),
  amount: z.number().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
});

/** Everything a body names belongs to the order's customer, and the engineer is an active login. */
async function checkBelongs(customerId: string, body: { assetId?: string | null; contractId?: string | null; siteId?: string | null; contactId?: string | null; assignedToId?: string | null; teamId?: string | null }) {
  if (body.teamId) {
    const team = await prisma.industry.findUnique({ where: { id: body.teamId }, select: { isActive: true } });
    if (!team?.isActive) throw badRequest('That team is not offered');
  }
  const [asset, contract, site, contact] = await Promise.all([
    body.assetId ? prisma.installedAsset.findUnique({ where: { id: body.assetId }, select: { customerId: true, status: true, warrantyEndsAt: true } }) : null,
    body.contractId ? prisma.serviceContract.findUnique({ where: { id: body.contractId }, select: { status: true, job: { select: { customerId: true } } } }) : null,
    body.siteId ? prisma.customerSite.findUnique({ where: { id: body.siteId }, select: { customerId: true } }) : null,
    body.contactId ? prisma.customerContact.findUnique({ where: { id: body.contactId }, select: { customerId: true } }) : null,
  ]);
  if (body.assetId && asset?.customerId !== customerId) throw badRequest('That machine is not this customer’s');
  if (asset?.status === 'DECOMMISSIONED') throw badRequest('That machine was decommissioned');
  if (body.contractId && contract?.job.customerId !== customerId) throw badRequest('That contract is not this customer’s');
  if (contract && contract.status !== 'ACTIVE' && contract.status !== 'DRAFT') throw badRequest('That contract is no longer active');
  if (body.siteId && site?.customerId !== customerId) throw badRequest('That site is not this customer’s');
  if (body.contactId && contact?.customerId !== customerId) throw badRequest('That contact is not at this customer');
  if (body.assignedToId) {
    const found = await prisma.user.count({ where: { id: body.assignedToId, isActive: true } });
    if (!found) throw badRequest('The engineer named is not an active login');
  }
  return { asset };
}

/** The FACT (warranty on the day) and the DECISION (cover) — the decision defaults from the facts and may be overridden. */
function coverOf(asset: { warrantyEndsAt: Date | null } | null, contractId: string | null, neededBy: Date, chosen: ChargeBasis | null | undefined) {
  const underWarranty = !!asset?.warrantyEndsAt && asset.warrantyEndsAt >= neededBy;
  const chargeBasis: ChargeBasis = chosen ?? (contractId ? 'CONTRACT' : underWarranty ? 'WARRANTY' : 'CHARGEABLE');
  return { underWarranty, chargeBasis };
}

serviceJobOrderRoutes.post(
  '/',
  require_('gops.service_job_orders.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(schema, req.body);
    const { asset } = await checkBelongs(body.customerId, body);
    const neededBy = asDate(body.neededBy, 'Needed by');
    const cover = coverOf(asset, body.contractId || null, neededBy, body.chargeBasis);
    const teamId = body.teamId || (await teamOf(me.id))?.id || null;
    const today = dayKey(new Date());

    const row = await prisma.$transaction(async (tx) =>
      tx.jobOrder.create({
        data: {
          number: await nextNumber(DOC, tx),
          category: 'SERVICE',
          kind: body.kind,
          urgent: !!body.urgent,
          customerId: body.customerId,
          siteId: body.siteId || null,
          contactId: body.contactId || null,
          contactNumber: body.contactNumber?.trim() || null,
          assetId: body.assetId || null,
          contractId: body.contractId || null,
          title: body.title,
          description: body.scope,
          scope: body.scope,
          requestedFor: neededBy,
          ...cover,
          customerPoNumber: body.customerPoNumber || null,
          amount: body.amount == null ? null : new Prisma.Decimal(body.amount),
          requestedById: me.id,
          assignedToId: body.assignedToId || null,
          teamId,
          notes: body.notes || null,
        },
        include,
      }),
    );
    await audit({ entityType: DOC, entityId: row.id, action: 'CREATED', summary: `${row.number} — ${subjectOf(row)}` }, req);
    res.status(201).json(present(row, today));
  }),
);

serviceJobOrderRoutes.get(
  '/:id',
  requireAnyOrDecider('gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    // The Aftermarket Manager or the Team Leader may hold no right to the
    // register: they are let in while the order waits on them.
    if (res.locals.deciderOnly) {
      if (!(await mayDecide(me.id, DOC, [row.id]))) throw forbidden('That Service JO is not yours to see');
    } else if (!mayOpen(me, row)) throw forbidden('That is someone else’s Service JO');
    const owner = canEditRecord(me, 'gops', 'service_job_orders', row.requestedById);
    const route = row.status === 'DRAFT' || row.status === 'REJECTED' ? await routeSlots(row) : [];
    const step = row.status === 'PENDING_APPROVAL' ? (await openSteps(DOC, [row.id])).get(row.id) : undefined;
    res.json({
      ...present(row, dayKey(new Date()), step),
      canEdit: owner && (row.status === 'DRAFT' || row.status === 'REJECTED'),
      canWithdraw: owner && row.status === 'PENDING_APPROVAL',
      canCancel: owner && ['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED'].includes(row.status),
      canAcknowledge: (owner || onIt(me, row)) && row.status !== 'DRAFT' && row.status !== 'CANCELLED',
      route: route.map((s) => ({ step: s.step, names: (s.assigned ?? []).map((p) => p.name) })),
    });
  }),
);

/** Modifying a draft or a returned order; a pending one is pulled back first. */
serviceJobOrderRoutes.patch(
  '/:id',
  requireAny('gops.service_job_orders.edit_own', 'gops.service_job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(schema.omit({ customerId: true }).partial(), req.body);
    const existing = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', existing.requestedById)) throw forbidden('Only whoever raised this Service JO can change it');
    if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
      throw badRequest('This Service JO has gone for approval — pull it back to draft first');
    }
    const { asset } = await checkBelongs(existing.customerId, {
      ...body,
      assetId: body.assetId !== undefined ? body.assetId : existing.assetId,
      contractId: body.contractId !== undefined ? body.contractId : existing.contractId,
    });
    const neededBy = body.neededBy ? asDate(body.neededBy, 'Needed by') : existing.requestedFor;
    const contractId = body.contractId !== undefined ? body.contractId || null : existing.contractId;
    const cover = coverOf(
      asset ?? (existing.asset ? { warrantyEndsAt: existing.asset.warrantyEndsAt } : null),
      contractId,
      neededBy,
      body.chargeBasis !== undefined ? body.chargeBasis : existing.chargeBasis,
    );
    const updated = await prisma.jobOrder.update({
      where: { id: existing.id },
      data: {
        ...(body.assetId !== undefined ? { assetId: body.assetId || null } : {}),
        ...(body.contractId !== undefined ? { contractId: body.contractId || null } : {}),
        ...(body.siteId !== undefined ? { siteId: body.siteId || null } : {}),
        ...(body.contactId !== undefined ? { contactId: body.contactId || null } : {}),
        ...(body.contactNumber !== undefined ? { contactNumber: body.contactNumber?.trim() || null } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.scope ? { scope: body.scope, description: body.scope } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.urgent !== undefined ? { urgent: !!body.urgent } : {}),
        requestedFor: neededBy,
        ...cover,
        ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId || null } : {}),
        ...(body.teamId !== undefined ? { teamId: body.teamId || (await teamOf(existing.requestedById))?.id || null } : {}),
        ...(body.customerPoNumber !== undefined ? { customerPoNumber: body.customerPoNumber || null } : {}),
        ...(body.amount !== undefined ? { amount: body.amount == null ? null : new Prisma.Decimal(body.amount) } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      },
      include,
    });
    const today = dayKey(new Date());
    await audit({ entityType: DOC, entityId: updated.id, action: 'UPDATED', summary: `${updated.number} updated`, before: present(existing, today), after: present(updated, today) }, req);
    res.json(present(updated, today));
  }),
);

// ── The lifecycle ───────────────────────────────────────────────────────────

/** Submitting: in the requester's name, claimed on the order as read. */
serviceJobOrderRoutes.post(
  '/:id/submit',
  requireAny('gops.service_job_orders.create', 'gops.service_job_orders.edit_own', 'gops.service_job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', row.requestedById)) throw forbidden('Only whoever raised this Service JO can submit it');
    if (row.status !== 'DRAFT' && row.status !== 'REJECTED') throw badRequest('Only a draft or a returned Service JO can be submitted');
    const before = row.status;
    const claimed = await prisma.jobOrder.updateMany({ where: { id: row.id, status: before, updatedAt: row.updatedAt }, data: { status: 'PENDING_APPROVAL' } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    try {
      await submitForApproval({
        documentType: DOC,
        documentId: row.id,
        documentNumber: row.number,
        subject: subjectOf(row),
        amount: num(row.amount),
        link: `${PATH}/${row.id}`,
        requesterId: row.requestedById,
        jobId: row.jobId,
      });
    } catch (err) {
      await prisma.jobOrder.update({ where: { id: row.id }, data: { status: before } });
      throw err;
    }
    await audit({ entityType: DOC, entityId: row.id, action: 'SUBMITTED', summary: `${row.number} submitted` }, req);
    res.json({ ok: true });
  }),
);

/** Pulled back to draft while pending — the request withdrawn in the same transaction; a decision that landed first wins. */
serviceJobOrderRoutes.post(
  '/:id/withdraw',
  requireAny('gops.service_job_orders.create', 'gops.service_job_orders.edit_own', 'gops.service_job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', row.requestedById)) throw forbidden('Only whoever raised this Service JO can pull it back');
    if (row.status !== 'PENDING_APPROVAL') throw badRequest('Only a Service JO awaiting approval can be pulled back');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.jobOrder.updateMany({ where: { id: row.id, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } });
      if (!claimed.count) throw badRequest('It was decided a moment ago — reload to see where it stands');
      await cancelOpenRequest(DOC, row.id, tx, `pulled back to draft by ${me.name}`, me.id);
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} pulled back to draft` }, req);
    res.json({ ok: true });
  }),
);

/**
 * Cancelling: a draft, a returned, a pending (its request withdrawn) or an
 * approved order (its booked visit cancelled with it). A completed one is a
 * record of what happened.
 */
serviceJobOrderRoutes.post(
  '/:id/cancel',
  requireAny('gops.service_job_orders.create', 'gops.service_job_orders.edit_own', 'gops.service_job_orders.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is cancelled') }), req.body);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', row.requestedById)) throw forbidden('Only whoever raised this Service JO can cancel it');
    if (row.status === 'COMPLETED') throw badRequest('This Service JO was completed; its record is what happened.');
    if (row.status === 'CANCELLED') throw badRequest('This Service JO is already cancelled');
    if (row.visit?.report) throw badRequest(`${row.visit.number} already has report ${row.visit.report.number} — the work was done`);

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.jobOrder.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: body.reason },
      });
      if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
      if (row.status === 'PENDING_APPROVAL') await cancelOpenRequest(DOC, row.id, tx, `cancelled by ${me.name}: ${body.reason}`, me.id);
      if (row.visit && OPEN_VISIT_STATUSES.includes(row.visit.status)) {
        await tx.serviceVisit.update({ where: { id: row.visit.id }, data: { status: 'CANCELLED', notes: `Cancelled with ${row.number}: ${body.reason}` } });
      }
    });
    if (row.assignedToId && row.assignedToId !== me.id && row.status === 'APPROVED') {
      await notify({ userId: row.assignedToId, type: 'pm.due', title: 'Service JO cancelled', body: `${row.number} — ${subjectOf(row)}: ${body.reason}`, link: `${PATH}/${row.id}` });
    }
    await audit({ entityType: DOC, entityId: row.id, action: 'CANCELLED', summary: `${row.number} cancelled — ${body.reason}${row.visit ? ` (visit ${row.visit.number} cancelled with it)` : ''}` }, req);
    res.json({ ok: true });
  }),
);

/** Deletes a CANCELLED Service JO — its raiser (or edit_all) with the delete right; never an invoiced one. Its files go with it. */
serviceJobOrderRoutes.delete(
  '/:id',
  require_('gops.service_job_orders.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', row.requestedById)) throw forbidden('Only whoever raised this Service JO can delete it');
    if (row.status !== 'CANCELLED') throw badRequest('Only a cancelled Service JO can be deleted — cancel it first');
    if (await prisma.invoice.count({ where: { jobOrderId: row.id } })) throw badRequest('This Service JO has been invoiced — it stays as that invoice’s record');
    await deleteOrRefuse(row.number, () =>
      prisma.$transaction(async (tx) => {
        await cancelOpenRequest(DOC, row.id, tx, `deleted by ${me.name}`, me.id);
        await tx.jobOrder.delete({ where: { id: row.id } });
      }),
    );
    await deleteAttachmentsOf('job_order', [row.id]);
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted cancelled Service JO ${row.number} — ${subjectOf(row)}` }, req);
    res.json({ ok: true });
  }),
);

/** The customer's signature slot on the printed order. */
serviceJobOrderRoutes.patch(
  '/:id/acknowledge',
  requireAny('gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ customerAcknowledgedBy: z.string().trim().min(2, 'Who signed for it?') }), req.body);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'gops', 'service_job_orders', row.requestedById) && !onIt(me, row)) throw forbidden('Only whoever raised the order or the engineer sent can record this');
    if (row.status === 'DRAFT' || row.status === 'CANCELLED') throw badRequest('A draft or cancelled order has nothing for the customer to acknowledge');
    const updated = await prisma.jobOrder.update({ where: { id: row.id }, data: { customerAcknowledgedBy: body.customerAcknowledgedBy, customerAcknowledgedAt: new Date() }, include });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${row.number} acknowledged by ${body.customerAcknowledgedBy}` }, req);
    res.json(present(updated, dayKey(new Date())));
  }),
);

serviceJobOrderRoutes.get(
  '/:id/pdf',
  requireAnyOrDecider('gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (res.locals.deciderOnly) {
      if (!(await mayDecide(me.id, DOC, [row.id]))) throw forbidden('That Service JO is not yours to see');
    } else if (!mayOpen(me, row)) throw forbidden('That is someone else’s Service JO');
    const currency = await companyCurrency();
    const requester = await contactOf(row.requestedById);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Equipment',
        columns: 2,
        fields: [
          { label: 'Customer', value: row.customer.name },
          { label: 'Machine', value: row.asset ? [row.asset.name, row.asset.model].filter(Boolean).join(' · ') : '—' },
          { label: 'Serial no.', value: row.asset?.serialNo ?? '—' },
          { label: 'Location', value: row.site ? [row.site.name, row.site.city].filter(Boolean).join(', ') : (row.asset?.address ?? '—') },
          { label: 'Contact', value: row.contact?.name ?? '—' },
          { label: 'Contact number', value: row.contactNumber ?? row.contact?.phone ?? '—' },
        ],
      },
      {
        kind: 'fields',
        title: 'Service details',
        columns: 2,
        fields: [
          { label: 'Service type', value: KIND_LABEL[row.kind] ?? row.kind },
          { label: 'Priority', value: row.urgent ? 'Urgent' : 'Normal' },
          { label: 'Needed by', value: formatDate(row.requestedFor) },
          { label: 'Requested by', value: row.requestedBy.name },
          { label: 'Assigned engineer', value: row.assignedTo?.name ?? 'To be assigned' },
          { label: 'Covered by', value: `${statusLabel(row.chargeBasis)}${row.contract ? ` — contract ${row.contract.number}` : row.underWarranty ? ' — under warranty' : ''}` },
          { label: 'Customer PO', value: row.customerPoNumber ?? '—' },
          { label: 'Amount (before VAT)', value: row.amount != null ? formatMoney(Number(row.amount), currency) : row.chargeBasis === 'CHARGEABLE' ? 'To be billed on completion' : '—' },
          ...(row.visit ? [{ label: 'Visit booked', value: `${row.visit.number} — ${formatDate(row.visit.dueDate)}, ${slotLabel(row.visit.startTime, row.visit.endTime)}` }] : []),
        ],
      },
      { kind: 'text', title: 'Scope of work', body: row.scope ?? row.description },
    ];
    if (row.status === 'CANCELLED' && row.cancelReason) sections.push({ kind: 'text', title: 'Cancelled', body: row.cancelReason });
    const route = await routeSlots(row);
    const cancelled = row.status === 'CANCELLED';
    const signatories: Signatory[] = [
      { role: 'Requested by', name: row.requestedBy.name, ...requester, at: row.createdAt },
      ...(route.length ? slotSignatories(route) : cancelled ? [] : [{ role: 'Approved by' }]),
      ...(row.customerAcknowledgedBy || !cancelled ? [{ role: 'Acknowledged by (customer)', name: row.customerAcknowledgedBy ?? undefined, at: row.customerAcknowledgedAt }] : []),
    ];
    const pdf = await renderDocument({ title: 'Service Job Order', documentNumber: row.number, date: row.createdAt, reference: subjectOf(row), sections, signatories });
    await audit({ entityType: DOC, entityId: row.id, action: 'EXPORTED', summary: `Printed ${row.number}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Service JO', number: row.number, author: row.requestedBy.name, date: row.createdAt })));
    res.send(pdf);
  }),
);

// ── Approval ────────────────────────────────────────────────────────────────

/**
 * The route's last signature BOOKS THE VISIT (the owner's call, 2026-10-20):
 * one ServiceVisit on the day the order is needed by, of the order's kind, on
 * its machine and contract, assigned to its engineer. The order's own status
 * is claimed first, so a settle that arrives twice books nothing twice; an
 * order pulled back and resubmitted puts its cancelled visit back on the
 * schedule rather than booking a second one (`ServiceVisit.jobOrderId` is
 * unique). A return puts the order back in the requester's hands.
 */
export async function settleServiceJobOrder(approval: { documentId: string }, outcome: ApprovalOutcome): Promise<void> {
  const jo = await prisma.jobOrder.findUnique({ where: { id: approval.documentId }, include });
  if (!jo || jo.category !== 'SERVICE' || jo.status !== 'PENDING_APPROVAL') return;

  if (outcome === 'REJECTED') {
    await prisma.jobOrder.update({ where: { id: jo.id }, data: { status: 'REJECTED' } });
    await audit({ entityType: DOC, entityId: jo.id, action: 'REJECTED', summary: `${jo.number} returned — no visit booked` });
    return;
  }

  const visit = await prisma.$transaction(async (tx) => {
    const claimed = await tx.jobOrder.updateMany({ where: { id: jo.id, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedAt: new Date() } });
    if (!claimed.count) return null;
    const facts = {
      kind: jo.kind,
      customerId: jo.customerId,
      siteId: jo.siteId,
      assetId: jo.assetId,
      contractId: jo.contractId,
      dueDate: jo.requestedFor,
      assignedToId: jo.assignedToId,
      notes: `Booked by Service JO ${jo.number}: ${jo.title}`,
    };
    if (jo.visit) {
      if (OPEN_VISIT_STATUSES.includes(jo.visit.status) || jo.visit.status === 'COMPLETED') return jo.visit;
      return tx.serviceVisit.update({ where: { id: jo.visit.id }, data: { ...facts, status: 'SCHEDULED', performedAt: null, confirmedAt: null, confirmedById: null } });
    }
    return tx.serviceVisit.create({ data: { number: await nextNumber('service_visit', tx), status: 'SCHEDULED', jobOrderId: jo.id, ...facts } });
  });
  if (!visit) return;

  await audit({ entityType: DOC, entityId: jo.id, action: 'EXECUTED', summary: `${jo.number} approved — visit ${visit.number} booked for ${isoDay(jo.requestedFor)}` });
  await audit({ entityType: 'service_visit', entityId: visit.id, action: 'CREATED', summary: `${visit.number} — ${KIND_LABEL[jo.kind]} at ${jo.customer.name}, booked by Service JO ${jo.number}` });
  if (jo.assignedToId) {
    await notify({
      userId: jo.assignedToId,
      type: 'pm.due',
      title: `Service JO ${jo.number} approved — visit ${visit.number} booked`,
      body: `${subjectOf(jo)}, needed by ${isoDay(jo.requestedFor)}${jo.urgent ? ' — URGENT' : ''}`,
      link: `/g-ops/visits?visit=${visit.id}`,
    });
  }
}

onApprovalSettled(DOC, settleServiceJobOrder);

/**
 * Pulled back after approval (the engine's reopen): the order goes back to
 * DRAFT and its booked visit is cancelled — refused once the visit has a
 * report or was completed (the work was done), or the order was invoiced.
 */
onApprovalReopened(DOC, {
  may: async (actor, id) => {
    const jo = await prisma.jobOrder.findUnique({ where: { id }, select: { status: true, category: true, requestedById: true } });
    return !!jo && jo.category === 'SERVICE' && (jo.status === 'APPROVED' || jo.status === 'COMPLETED') && canEditRecord(actor, 'gops', 'service_job_orders', jo.requestedById);
  },
  reopen: async ({ documentId, tx }) => {
    const jo = await tx.jobOrder.findUnique({ where: { id: documentId }, select: { id: true, number: true, status: true, visit: { select: { id: true, number: true, status: true, report: { select: { number: true } } } } } });
    if (!jo) throw notFound('Service JO not found');
    if (jo.status !== 'APPROVED') throw badRequest(`${jo.number} is ${statusLabel(jo.status).toLowerCase()} — only an approved Service JO goes back to draft`);
    if (jo.visit?.report) throw badRequest(`${jo.number}'s visit ${jo.visit.number} has report ${jo.visit.report.number} on it — the work was done`);
    if (jo.visit?.status === 'COMPLETED') throw badRequest(`${jo.number}'s visit ${jo.visit.number} was completed — the work was done`);
    if (await tx.invoice.count({ where: { jobOrderId: jo.id, status: { not: 'CANCELLED' } } })) throw badRequest(`${jo.number} has been invoiced — cancel the invoice first`);
    const claimed = await tx.jobOrder.updateMany({ where: { id: jo.id, status: 'APPROVED' }, data: { status: 'DRAFT', approvedAt: null } });
    if (!claimed.count) throw badRequest('It changed a moment ago — reload to see where it stands');
    if (jo.visit && OPEN_VISIT_STATUSES.includes(jo.visit.status)) {
      await tx.serviceVisit.update({ where: { id: jo.visit.id }, data: { status: 'CANCELLED', confirmedAt: null, confirmedById: null, notes: `Cancelled — ${jo.number} was pulled back to draft` } });
    }
  },
});

// ── Ctrl+K ──────────────────────────────────────────────────────────────────

registerSearch({
  kind: DOC,
  label: 'Service JOs',
  permission: ['gops.service_job_orders.view_all', 'gops.service_job_orders.view_own'],
  ownWhere: (user) => peopleWhere([user.id]),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.jobOrder.findMany({
      where: {
        category: 'SERVICE',
        AND: [
          own ?? {},
          {
            OR: [
              { number: { contains: term, mode: 'insensitive' } },
              { title: { contains: term, mode: 'insensitive' } },
              { customer: { name: { contains: term, mode: 'insensitive' } } },
              { asset: { OR: [{ name: { contains: term, mode: 'insensitive' } }, { serialNo: { contains: term, mode: 'insensitive' } }] } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, title: true, status: true, customer: { select: { name: true } }, asset: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: DOC,
      id: r.id,
      title: `${r.number} — ${r.title}`,
      subtitle: `${r.customer.name}${r.asset ? ` · ${r.asset.name}` : ''} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `${PATH}/${r.id}`,
    }));
  },
});
