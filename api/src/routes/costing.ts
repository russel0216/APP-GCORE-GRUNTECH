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
} from '../http/kit';
import { authenticate, require_, requireAny, currentUser } from '../auth/middleware';
import { canEditRecord } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { renderDocument, formatMoney, formatDate, type PdfSection } from '../shared/pdf';

/**
 * Costing (model §5.3).
 *
 * Not a calculator. This is where the contract amount comes from, and the same
 * record carries the scope of work whose sections become the Schedule of
 * Values — the backbone that progress reporting, progress billing and the
 * S-curve are all measured against in Phase 4.
 */

export const costingRoutes = Router();
costingRoutes.use(authenticate);

const d = (v: number | string | null | undefined) =>
  v === null || v === undefined ? new Prisma.Decimal(0) : new Prisma.Decimal(v);

function num(v: Prisma.Decimal | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Recomputes totals from the lines and rewrites the stored figures. */
async function recalc(costingId: string, tx: Prisma.TransactionClient = prisma) {
  const costing = await tx.costing.findUnique({
    where: { id: costingId },
    include: { lines: true },
  });
  if (!costing) return null;

  const totalCost = costing.lines.reduce((sum, l) => sum + Number(l.amount), 0);
  const markup = totalCost * Number(costing.markupPct);
  const contractValue = totalCost + markup - Number(costing.discountAmount);

  return tx.costing.update({
    where: { id: costingId },
    data: {
      totalCost: d(totalCost),
      contractValue: d(Math.max(0, contractValue)),
    },
  });
}

/** Shapes a costing for the API: Decimals to numbers, plus derived figures. */
function present(costing: Record<string, unknown>) {
  const lines = (costing.lines ?? []) as Record<string, unknown>[];
  const sections = (costing.scopeSections ?? []) as Record<string, unknown>[];

  const totalCost = num(costing.totalCost as Prisma.Decimal);
  const contractValue = num(costing.contractValue as Prisma.Decimal);
  const grossProfit = contractValue - totalCost;

  return {
    ...costing,
    markupPct: num(costing.markupPct as Prisma.Decimal),
    discountAmount: num(costing.discountAmount as Prisma.Decimal),
    totalCost,
    contractValue,
    grossProfit,
    // Margin is profit over the contract value, not over cost — the two differ
    // and only one of them is what the business calls margin (model §5.3).
    grossMarginPct: contractValue > 0 ? grossProfit / contractValue : 0,
    lines: lines.map((l) => ({
      ...l,
      quantity: num(l.quantity as Prisma.Decimal),
      unitCost: num(l.unitCost as Prisma.Decimal),
      amount: num(l.amount as Prisma.Decimal),
    })),
    scopeSections: sections.map((s) => ({ ...s, value: num(s.value as Prisma.Decimal) })),
    scopeTotal: sections.reduce((sum, s) => sum + num(s.value as Prisma.Decimal), 0),
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

costingRoutes.get(
  '/',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.CostingWhereInput = {};

    // Someone with only view_own never sees another person's costing, whatever
    // the scope switch says.
    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.costing.view_all');
    if (onlyOwn || q.scope === 'mine') where.ownerId = me.id;

    if (q.search) {
      where.OR = [
        { title: { contains: q.search, mode: 'insensitive' } },
        { number: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    if (q.filters.status) where.status = q.filters.status as Prisma.EnumCostingStatusFilter['equals'];
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    // Service Costing is this same screen, narrowed to the costings that back a
    // service contract. A service costing is not a different kind of record —
    // it is a costing whose job happens to be a contract (model §4.5) — so it
    // would be a mistake to give it a second table to drift out of step with.
    if (q.filters.jobType) {
      where.jobs = { some: { type: q.filters.jobType as Prisma.EnumJobTypeFilter['equals'] } };
    }

    const [rows, total] = await Promise.all([
      prisma.costing.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          _count: { select: { lines: true, scopeSections: true } },
        },
        orderBy: orderBy(q, ['number', 'title', 'contractValue', 'createdAt'], { createdAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.costing.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({
          ...present(r as unknown as Record<string, unknown>),
          lineCount: r._count.lines,
          sectionCount: r._count.scopeSections,
        })),
        total,
        q,
      ),
    );
  }),
);

costingRoutes.get(
  '/lookup',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.costing.view_all');
    const where: Prisma.CostingWhereInput = onlyOwn ? { ownerId: me.id } : {};

    // `?status=FINAL` (or a comma list) lets a picker leave DRAFT costings out —
    // a project is built on a final costing, and a picker that offers drafts
    // offers budgets that are still moving. `?q=` narrows by number, title or
    // customer, the same three fields the list searches.
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const statuses = status
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is 'DRAFT' | 'FINAL' => s === 'DRAFT' || s === 'FINAL');
    if (statuses.length === 1) where.status = statuses[0];
    else if (statuses.length > 1) where.status = { in: statuses };

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { number: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const rows = await prisma.costing.findMany({
      where,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        contractValue: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rows.map((r) => ({ ...r, contractValue: num(r.contractValue) })));
  }),
);

// ── Read one ─────────────────────────────────────────────────────────────────

async function loadFull(id: string) {
  return prisma.costing.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, code: true } },
      site: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      lead: { select: { id: true, number: true, companyName: true, status: true } },
      lines: {
        orderBy: { sortOrder: 'asc' },
        include: {
          costCategory: { select: { id: true, code: true, name: true, sortOrder: true } },
          item: { select: { id: true, code: true, name: true } },
        },
      },
      scopeSections: {
        orderBy: { sortOrder: 'asc' },
        include: { tasks: { orderBy: { sortOrder: 'asc' } } },
      },
      quotationRevisions: {
        select: {
          id: true,
          revision: true,
          status: true,
          quotation: { select: { id: true, number: true, subject: true } },
        },
      },
      // Where the costing went: the jobs built on it. Rendered as the "next
      // step" on the page, so a costing that already became a project says so
      // instead of offering to create a second one.
      jobs: {
        select: { id: true, number: true, name: true, status: true, type: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
}

costingRoutes.get(
  '/:id',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await loadFull(req.params.id);
    if (!costing) throw notFound('Costing not found');

    if (
      !me.isSuperAdmin &&
      !me.permissions.has('gops.costing.view_all') &&
      costing.ownerId !== me.id
    ) {
      throw forbidden('This costing belongs to someone else');
    }

    res.json({
      ...present(costing as unknown as Record<string, unknown>),
      canEdit: canEditRecord(me, 'gops', 'costing', costing.ownerId),
    });
  }),
);

// ── Create / update ──────────────────────────────────────────────────────────

/**
 * The lead stages a new costing advances from. Anything at or past COSTING is
 * left alone — re-costing a lead in NEGOTIATION is normal and must not reset
 * where the salesperson has got to.
 */
const LEAD_STAGES_BEFORE_COSTING = new Set(['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT']);

const costingSchema = z.object({
  title: z.string().trim().min(2, 'Give the costing a title'),
  customerId: z.string().optional().nullable(),
  siteId: z.string().optional().nullable(),
  /** The lead this costing answers. Set on creation from "Start costing". */
  leadId: z.string().optional().nullable(),
  markupPct: z.number().min(0).max(5).optional(),
  discountAmount: z.number().min(0).optional(),
  durationDays: z.number().int().min(0).optional().nullable(),
  notes: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'FINAL']).optional(),
});

costingRoutes.post(
  '/',
  require_('gops.costing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(costingSchema, req.body);

    const { costing, leadMoved } = await prisma.$transaction(async (tx) => {
      // "Start costing" from a lead. The costing takes the lead's customer and
      // site unless the body names its own, and the lead advances to COSTING —
      // but only from the stages before it. A lead already in NEGOTIATION, or
      // WON, must not be dragged backwards because somebody re-costed it.
      let lead: { id: string; number: string; customerId: string | null; siteId: string | null; status: string } | null =
        null;
      if (body.leadId) {
        lead = await tx.lead.findUnique({
          where: { id: body.leadId },
          select: { id: true, number: true, customerId: true, siteId: true, status: true },
        });
        if (!lead) throw notFound('Lead not found');
      }

      const number = await nextNumber('costing', tx);
      const created = await tx.costing.create({
        data: {
          number,
          title: body.title,
          customerId: body.customerId || lead?.customerId || null,
          siteId: body.siteId || (body.customerId ? null : lead?.siteId) || null,
          leadId: lead?.id ?? null,
          ownerId: me.id,
          markupPct: d(body.markupPct ?? 0),
          discountAmount: d(body.discountAmount ?? 0),
          durationDays: body.durationDays ?? null,
          notes: body.notes || null,
          terms: body.terms || null,
        },
      });

      let moved = false;
      if (lead && LEAD_STAGES_BEFORE_COSTING.has(lead.status)) {
        await tx.lead.update({ where: { id: lead.id }, data: { status: 'COSTING' } });
        moved = true;
      }
      return { costing: created, leadMoved: moved ? lead : null };
    });

    await audit(
      {
        entityType: 'costing',
        entityId: costing.id,
        action: 'CREATED',
        summary: `Created costing ${costing.number} — ${costing.title}${
          costing.leadId ? ` (from lead)` : ''
        }`,
      },
      req,
    );
    if (leadMoved) {
      await audit(
        {
          entityType: 'lead',
          entityId: leadMoved.id,
          action: 'UPDATED',
          summary: `Lead ${leadMoved.number} moved to COSTING — costing ${costing.number} started`,
        },
        req,
      );
    }
    res.status(201).json(present(costing as unknown as Record<string, unknown>));
  }),
);

/** Loads a costing and refuses unless this user may edit it. */
async function forEdit(req: Parameters<typeof currentUser>[0], id: string) {
  const me = currentUser(req);
  const costing = await prisma.costing.findUnique({ where: { id } });
  if (!costing) throw notFound('Costing not found');
  if (!canEditRecord(me, 'gops', 'costing', costing.ownerId)) {
    throw forbidden('Only the author can edit this costing');
  }
  // A FINAL costing is a commercial record — an approved quotation and, later,
  // a project budget are derived from it. Reopen it deliberately.
  if (costing.status === 'FINAL') {
    throw badRequest('This costing is final. Set it back to draft before changing it.');
  }
  return costing;
}

costingRoutes.patch(
  '/:id',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(costingSchema.partial(), req.body);

    const before = await prisma.costing.findUnique({ where: { id: req.params.id } });
    if (!before) throw notFound('Costing not found');
    if (!canEditRecord(me, 'gops', 'costing', before.ownerId)) {
      throw forbidden('Only the author can edit this costing');
    }
    // Status is the one field that may change on a FINAL costing — that is how
    // it gets reopened.
    if (before.status === 'FINAL' && Object.keys(body).some((k) => k !== 'status')) {
      throw badRequest('This costing is final. Set it back to draft before changing it.');
    }

    const data: Prisma.CostingUpdateInput = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.terms !== undefined) data.terms = body.terms || null;
    if (body.durationDays !== undefined) data.durationDays = body.durationDays ?? null;
    if (body.markupPct !== undefined) data.markupPct = d(body.markupPct);
    if (body.discountAmount !== undefined) data.discountAmount = d(body.discountAmount);
    if (body.status !== undefined) data.status = body.status;
    if (body.customerId !== undefined) {
      data.customer = body.customerId ? { connect: { id: body.customerId } } : { disconnect: true };
    }
    if (body.siteId !== undefined) {
      data.site = body.siteId ? { connect: { id: body.siteId } } : { disconnect: true };
    }
    // Re-linking a costing to a lead is a correction, not a handoff: the lead's
    // stage only moves when a costing is STARTED from it (POST).
    if (body.leadId !== undefined) {
      data.lead = body.leadId ? { connect: { id: body.leadId } } : { disconnect: true };
    }

    await prisma.costing.update({ where: { id: req.params.id }, data });
    await recalc(req.params.id);

    const costing = await loadFull(req.params.id);
    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: body.status === 'FINAL' ? 'COMPLETED' : 'UPDATED',
        summary:
          body.status === 'FINAL'
            ? `Marked costing ${before.number} final — contract value ${formatMoney(num(costing!.contractValue))}`
            : `Updated costing ${before.number}`,
      },
      req,
    );

    res.json(present(costing as unknown as Record<string, unknown>));
  }),
);

costingRoutes.delete(
  '/:id',
  require_('gops.costing.delete'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await prisma.costing.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quotationRevisions: true } } },
    });
    if (!costing) throw notFound('Costing not found');
    if (!canEditRecord(me, 'gops', 'costing', costing.ownerId)) {
      throw forbidden('Only the author can delete this costing');
    }
    if (costing._count.quotationRevisions > 0) {
      throw badRequest(
        `${costing._count.quotationRevisions} quotation revision(s) are built on this costing`,
      );
    }

    await prisma.costing.delete({ where: { id: req.params.id } });
    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: 'DELETED',
        summary: `Deleted costing ${costing.number}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ── Duplicate ────────────────────────────────────────────────────────────────

/**
 * A fresh DRAFT copy of a costing: header, cost lines, scope sections and
 * their tasks, under a new number and owned by whoever asked.
 *
 * This is how a service contract is renewed (model §4.5): the old contract's
 * costing is copied at last year's prices, repriced, and a new contract is
 * built on the copy. The prices are copied deliberately and the page says so —
 * a renewal that silently kept them would be a price freeze nobody decided on.
 *
 * What is NOT copied: the lead link (a copy answers no lead), the quotation
 * revisions and jobs built on the original (they are the original's history),
 * and the status (a copy is always a draft — its numbers are about to change).
 */
costingRoutes.post(
  '/:id/duplicate',
  require_('gops.costing.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({ title: z.string().trim().min(2).optional() }),
      req.body ?? {},
    );

    const source = await prisma.costing.findUnique({
      where: { id: req.params.id },
      include: {
        lines: { orderBy: { sortOrder: 'asc' } },
        scopeSections: {
          orderBy: { sortOrder: 'asc' },
          include: { tasks: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!source) throw notFound('Costing not found');
    // Copying is reading: someone who may only see their own costings may only
    // copy their own.
    if (
      !me.isSuperAdmin &&
      !me.permissions.has('gops.costing.view_all') &&
      source.ownerId !== me.id
    ) {
      throw forbidden('This costing belongs to someone else');
    }

    const copyId = await prisma.$transaction(async (tx) => {
      const number = await nextNumber('costing', tx);
      const copy = await tx.costing.create({
        data: {
          number,
          title: body.title ?? source.title,
          status: 'DRAFT',
          customerId: source.customerId,
          siteId: source.siteId,
          ownerId: me.id,
          markupPct: source.markupPct,
          discountAmount: source.discountAmount,
          durationDays: source.durationDays,
          notes: source.notes,
          terms: source.terms,
          lines: {
            create: source.lines.map((l) => ({
              costCategoryId: l.costCategoryId,
              itemId: l.itemId,
              description: l.description,
              quantity: l.quantity,
              unit: l.unit,
              unitCost: l.unitCost,
              amount: l.amount,
              sortOrder: l.sortOrder,
            })),
          },
          scopeSections: {
            create: source.scopeSections.map((s) => ({
              kind: s.kind,
              name: s.name,
              description: s.description,
              durationDays: s.durationDays,
              value: s.value,
              sortOrder: s.sortOrder,
              tasks: {
                create: s.tasks.map((t) => ({
                  name: t.name,
                  durationDays: t.durationDays,
                  sortOrder: t.sortOrder,
                })),
              },
            })),
          },
        },
      });
      // Totals are recomputed from the copied lines rather than copied, so the
      // copy can never carry a figure its own lines do not add up to.
      await recalc(copy.id, tx);
      return copy.id;
    });

    const copy = await loadFull(copyId);
    await audit(
      {
        entityType: 'costing',
        entityId: copyId,
        action: 'CREATED',
        summary: `Duplicated costing ${source.number} as ${copy!.number} — ${copy!.title}`,
      },
      req,
    );
    res.status(201).json({
      ...present(copy as unknown as Record<string, unknown>),
      canEdit: true,
      duplicatedFrom: { id: source.id, number: source.number },
    });
  }),
);

// ── Cost lines ───────────────────────────────────────────────────────────────

const lineSchema = z.object({
  costCategoryId: z.string().min(1, 'Choose a cost category'),
  itemId: z.string().optional().nullable(),
  description: z.string().trim().min(1, 'Describe the line'),
  quantity: z.number().min(0),
  unit: z.string().trim().min(1).default('pcs'),
  unitCost: z.number().min(0),
  sortOrder: z.number().int().optional(),
});

costingRoutes.post(
  '/:id/lines',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const body = parseBody(lineSchema, req.body);

    const line = await prisma.costingLine.create({
      data: {
        costingId: req.params.id,
        costCategoryId: body.costCategoryId,
        itemId: body.itemId || null,
        description: body.description,
        quantity: d(body.quantity),
        unit: body.unit,
        unitCost: d(body.unitCost),
        amount: d(body.quantity * body.unitCost),
        sortOrder: body.sortOrder ?? 0,
      },
    });
    await recalc(req.params.id);

    res.status(201).json(line);
  }),
);

costingRoutes.patch(
  '/:id/lines/:lineId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const body = parseBody(lineSchema.partial(), req.body);

    const existing = await prisma.costingLine.findFirst({
      where: { id: req.params.lineId, costingId: req.params.id },
    });
    if (!existing) throw notFound('Cost line not found');

    const quantity = body.quantity ?? Number(existing.quantity);
    const unitCost = body.unitCost ?? Number(existing.unitCost);

    const line = await prisma.costingLine.update({
      where: { id: req.params.lineId },
      data: {
        ...(body.costCategoryId !== undefined ? { costCategoryId: body.costCategoryId } : {}),
        ...(body.itemId !== undefined ? { itemId: body.itemId || null } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.unit !== undefined ? { unit: body.unit } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        quantity: d(quantity),
        unitCost: d(unitCost),
        amount: d(quantity * unitCost),
      },
    });
    await recalc(req.params.id);

    res.json(line);
  }),
);

costingRoutes.delete(
  '/:id/lines/:lineId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const existing = await prisma.costingLine.findFirst({
      where: { id: req.params.lineId, costingId: req.params.id },
    });
    if (!existing) throw notFound('Cost line not found');

    await prisma.costingLine.delete({ where: { id: req.params.lineId } });
    await recalc(req.params.id);
    res.json({ ok: true });
  }),
);

// ── Scope of work / Schedule of Values ───────────────────────────────────────

const sectionSchema = z.object({
  kind: z.enum(['MAIN_WORK', 'TESTING_COMMISSIONING', 'TURNOVER', 'OTHER']).default('MAIN_WORK'),
  name: z.string().trim().min(2, 'Name the scope section'),
  description: z.string().optional().nullable(),
  durationDays: z.number().int().min(0).default(0),
  value: z.number().min(0).default(0),
  sortOrder: z.number().int().optional(),
});

costingRoutes.post(
  '/:id/sections',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const body = parseBody(sectionSchema, req.body);

    const section = await prisma.scopeSection.create({
      data: {
        costingId: req.params.id,
        kind: body.kind,
        name: body.name,
        description: body.description || null,
        durationDays: body.durationDays,
        value: d(body.value),
        sortOrder: body.sortOrder ?? 0,
      },
      include: { tasks: true },
    });
    res.status(201).json({ ...section, value: num(section.value) });
  }),
);

costingRoutes.patch(
  '/:id/sections/:sectionId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const body = parseBody(sectionSchema.partial(), req.body);

    const existing = await prisma.scopeSection.findFirst({
      where: { id: req.params.sectionId, costingId: req.params.id },
    });
    if (!existing) throw notFound('Scope section not found');

    const section = await prisma.scopeSection.update({
      where: { id: req.params.sectionId },
      data: {
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.durationDays !== undefined ? { durationDays: body.durationDays } : {}),
        ...(body.value !== undefined ? { value: d(body.value) } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
      include: { tasks: { orderBy: { sortOrder: 'asc' } } },
    });
    res.json({ ...section, value: num(section.value) });
  }),
);

costingRoutes.delete(
  '/:id/sections/:sectionId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const existing = await prisma.scopeSection.findFirst({
      where: { id: req.params.sectionId, costingId: req.params.id },
    });
    if (!existing) throw notFound('Scope section not found');
    await prisma.scopeSection.delete({ where: { id: req.params.sectionId } });
    res.json({ ok: true });
  }),
);

/**
 * Spreads the contract value across the scope sections in proportion to what
 * is already there, or evenly when nothing has been set.
 *
 * The Schedule of Values has to add up to the contract value or progress
 * billing cannot be right, and asking someone to reconcile it by hand after
 * every markup change is how it silently stops adding up.
 */
costingRoutes.post(
  '/:id/sections/distribute',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    const costing = await forEdit(req, req.params.id);
    const sections = await prisma.scopeSection.findMany({
      where: { costingId: req.params.id },
      orderBy: { sortOrder: 'asc' },
    });
    if (!sections.length) throw badRequest('Add at least one scope section first');

    const contractValue = num(costing.contractValue);
    const currentTotal = sections.reduce((s, x) => s + num(x.value), 0);

    // Round to centavos and put any rounding remainder on the last section, so
    // the sum matches the contract value exactly rather than being a centavo out.
    const raw = sections.map((s) =>
      currentTotal > 0 ? (num(s.value) / currentTotal) * contractValue : contractValue / sections.length,
    );
    const rounded = raw.map((v) => Math.round(v * 100) / 100);
    const drift = Math.round((contractValue - rounded.reduce((a, b) => a + b, 0)) * 100) / 100;
    rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * 100) / 100;

    await prisma.$transaction(
      sections.map((s, i) =>
        prisma.scopeSection.update({ where: { id: s.id }, data: { value: d(rounded[i]) } }),
      ),
    );

    await audit(
      {
        entityType: 'costing',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Distributed ${formatMoney(contractValue)} across ${sections.length} scope section(s)`,
      },
      req,
    );

    const full = await loadFull(req.params.id);
    res.json(present(full as unknown as Record<string, unknown>));
  }),
);

// ── Scope tasks ──────────────────────────────────────────────────────────────

costingRoutes.post(
  '/:id/sections/:sectionId/tasks',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1),
        durationDays: z.number().int().min(0).default(0),
        sortOrder: z.number().int().optional(),
      }),
      req.body,
    );
    const section = await prisma.scopeSection.findFirst({
      where: { id: req.params.sectionId, costingId: req.params.id },
    });
    if (!section) throw notFound('Scope section not found');

    res.status(201).json(
      await prisma.scopeTask.create({
        data: {
          scopeSectionId: req.params.sectionId,
          name: body.name,
          durationDays: body.durationDays,
          sortOrder: body.sortOrder ?? 0,
        },
      }),
    );
  }),
);

costingRoutes.delete(
  '/:id/sections/:sectionId/tasks/:taskId',
  require_('gops.costing.edit_own'),
  handler(async (req, res) => {
    await forEdit(req, req.params.id);
    const task = await prisma.scopeTask.findFirst({
      where: { id: req.params.taskId, scopeSectionId: req.params.sectionId },
    });
    if (!task) throw notFound('Task not found');
    await prisma.scopeTask.delete({ where: { id: req.params.taskId } });
    res.json({ ok: true });
  }),
);

// ── PDF ──────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  MAIN_WORK: 'Main work',
  TESTING_COMMISSIONING: 'Testing & commissioning',
  TURNOVER: 'Turnover',
  OTHER: 'Other',
};

costingRoutes.get(
  '/:id/pdf',
  requireAny('gops.costing.view_all', 'gops.costing.view_own'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const costing = await loadFull(req.params.id);
    if (!costing) throw notFound('Costing not found');
    if (
      !me.isSuperAdmin &&
      !me.permissions.has('gops.costing.view_all') &&
      costing.ownerId !== me.id
    ) {
      throw forbidden('This costing belongs to someone else');
    }

    const view = present(costing as unknown as Record<string, unknown>);
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const currency = company?.currency ?? 'PHP';

    // Cost lines grouped by the five buckets, with a subtotal each.
    const byCategory = new Map<string, { name: string; sortOrder: number; rows: string[][]; total: number }>();
    for (const line of costing.lines) {
      const key = line.costCategory.id;
      const bucket = byCategory.get(key) ?? {
        name: line.costCategory.name,
        sortOrder: line.costCategory.sortOrder,
        rows: [],
        total: 0,
      };
      bucket.rows.push([
        line.description,
        String(Number(line.quantity)),
        line.unit,
        formatMoney(Number(line.unitCost), currency),
        formatMoney(Number(line.amount), currency),
      ]);
      bucket.total += Number(line.amount);
      byCategory.set(key, bucket);
    }

    const sections: PdfSection[] = [
      {
        kind: 'fields',
        title: 'Costing',
        columns: 3,
        fields: [
          { label: 'Customer', value: costing.customer?.name ?? '—' },
          { label: 'Site', value: costing.site?.name ?? '—' },
          { label: 'Prepared by', value: costing.owner.name },
          { label: 'Status', value: costing.status },
          { label: 'Duration', value: costing.durationDays ? `${costing.durationDays} days` : '—' },
          { label: 'Date', value: formatDate(costing.createdAt) },
        ],
      },
    ];

    for (const bucket of [...byCategory.values()].sort((a, b) => a.sortOrder - b.sortOrder)) {
      sections.push({
        kind: 'table',
        title: bucket.name,
        head: ['Description', 'Qty', 'Unit', 'Unit cost', 'Amount'],
        widths: [46, 9, 10, 17, 18],
        align: ['left', 'right', 'left', 'right', 'right'],
        rows: [...bucket.rows, ['', '', '', 'Subtotal', formatMoney(bucket.total, currency)]],
      });
    }

    sections.push({
      kind: 'table',
      title: 'How the contract amount is reached',
      head: ['', 'Amount'],
      widths: [70, 30],
      align: ['left', 'right'],
      rows: [
        ['Total estimated cost', formatMoney(view.totalCost, currency)],
        [`Markup (${(view.markupPct * 100).toFixed(2)}%)`, formatMoney(view.totalCost * view.markupPct, currency)],
        ['Less discount', formatMoney(-view.discountAmount, currency)],
        ['CONTRACT AMOUNT', formatMoney(view.contractValue, currency)],
        ['Gross profit', formatMoney(view.grossProfit, currency)],
        ['Gross margin', `${(view.grossMarginPct * 100).toFixed(2)}%`],
      ],
    });

    if (costing.scopeSections.length) {
      sections.push({
        kind: 'table',
        title: 'Scope of work — schedule of values',
        head: ['#', 'Scope', 'Type', 'Duration', 'Value'],
        widths: [6, 44, 20, 12, 18],
        align: ['right', 'left', 'left', 'right', 'right'],
        rows: [
          ...costing.scopeSections.map((s, i) => [
            String(i + 1),
            s.tasks.length ? `${s.name}\n   ${s.tasks.map((t) => `· ${t.name}`).join('\n   ')}` : s.name,
            KIND_LABELS[s.kind] ?? s.kind,
            `${s.durationDays} d`,
            formatMoney(Number(s.value), currency),
          ]),
          ['', 'TOTAL', '', '', formatMoney(view.scopeTotal, currency)],
        ],
      });
    }

    if (costing.terms) sections.push({ kind: 'text', title: 'Terms', body: costing.terms });
    if (costing.notes) sections.push({ kind: 'text', title: 'Notes', body: costing.notes });

    const pdf = await renderDocument({
      title: 'Costing Sheet',
      documentNumber: costing.number,
      date: costing.createdAt,
      reference: `${costing.title}${costing.customer ? ` — ${costing.customer.name}` : ''}`,
      sections,
      signatories: [
        { role: 'Prepared by', name: costing.owner.name, at: costing.createdAt },
        { role: 'Checked by' },
        { role: 'Approved by' },
      ],
    });

    await audit(
      { entityType: 'costing', entityId: costing.id, action: 'EXPORTED', summary: 'Printed costing sheet' },
      req,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${costing.number}.pdf"`);
    res.send(pdf);
  }),
);
