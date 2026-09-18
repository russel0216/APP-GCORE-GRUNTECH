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
} from '../http/kit';
import { authenticate, require_ } from '../auth/middleware';
import { audit } from '../shared/audit';
import { DOCUMENT_TYPES, previewNumber } from '../shared/numbering';
import { upload, saveAttachment, attachmentPath } from '../shared/attachments';
import { currentUser } from '../auth/middleware';

// ════════════════════════════════════════════════════════════════════
//  COMPANY SETTINGS  — drives every PDF header
// ════════════════════════════════════════════════════════════════════

export const companyRoutes = Router();
companyRoutes.use(authenticate);

companyRoutes.get(
  '/',
  require_('admin.company.view_all'),
  handler(async (_req, res) => {
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    if (!company) throw notFound('Company settings have not been seeded');
    res.json({ ...company, vatRate: Number(company.vatRate), ewtRate: Number(company.ewtRate) });
  }),
);

const companySchema = z.object({
  name: z.string().min(2, 'Company name is required'),
  legalName: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional(),
  tin: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  website: z.string().optional().nullable(),
  currency: z.string().min(3).max(3).optional(),
  vatRate: z.number().min(0).max(1).optional(),
  ewtRate: z.number().min(0).max(1).optional(),
  numberPrefix: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Z0-9]+$/, 'Use capital letters and numbers only')
    .optional(),
});

companyRoutes.put(
  '/',
  require_('admin.company.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(companySchema, req.body);
    const before = await prisma.company.findUnique({ where: { id: 'company' } });

    const data: Prisma.CompanyUpdateInput = {
      ...body,
      email: body.email || null,
      vatRate: body.vatRate !== undefined ? new Prisma.Decimal(body.vatRate) : undefined,
      ewtRate: body.ewtRate !== undefined ? new Prisma.Decimal(body.ewtRate) : undefined,
    };

    const company = await prisma.company.update({ where: { id: 'company' }, data });
    await audit(
      {
        entityType: 'company',
        entityId: 'company',
        action: 'UPDATED',
        summary: 'Updated company settings',
        before,
        after: company,
      },
      req,
    );
    res.json({ ...company, vatRate: Number(company.vatRate), ewtRate: Number(company.ewtRate) });
  }),
);

/** The logo used by every PDF header. */
companyRoutes.post(
  '/logo',
  require_('admin.company.edit_all'),
  upload.single('file'),
  handler(async (req, res) => {
    if (!req.file) throw badRequest('Choose an image file');
    if (!req.file.mimetype.startsWith('image/')) throw badRequest('The logo must be an image');

    const company = await prisma.company.update({
      where: { id: 'company' },
      data: { logoPath: attachmentPath(req.file.filename) },
    });
    await saveAttachment({
      entityType: 'company',
      entityId: 'company',
      file: req.file,
      uploadedById: currentUser(req).id,
      caption: 'Company logo',
    });
    await audit(
      { entityType: 'company', entityId: 'company', action: 'UPDATED', summary: 'Updated company logo' },
      req,
    );
    res.json({ logoPath: company.logoPath });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  DOCUMENT NUMBERING
// ════════════════════════════════════════════════════════════════════

export const numberingRoutes = Router();
numberingRoutes.use(authenticate);

numberingRoutes.get(
  '/',
  require_('admin.numbering.view_all'),
  handler(async (_req, res) => {
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    const prefix = company?.numberPrefix ?? 'GT';
    const currentYear = String(new Date().getFullYear());

    const sequences = await prisma.numberSequence.findMany({
      orderBy: [{ documentType: 'asc' }, { periodKey: 'desc' }],
    });

    // One row per document type — the template row plus this period's counter.
    const rows = DOCUMENT_TYPES.map((dt) => {
      const template =
        sequences.find((s) => s.documentType === dt.type && s.periodKey === '') ??
        sequences.find((s) => s.documentType === dt.type);
      const active =
        sequences.find((s) => s.documentType === dt.type && s.periodKey === currentYear) ?? template;
      if (!template) return null;
      return {
        id: template.id,
        documentType: dt.type,
        label: template.label,
        pattern: template.pattern,
        typeCode: template.typeCode,
        period: template.period,
        padding: template.padding,
        lastNumber: active?.lastNumber ?? 0,
        preview: previewNumber(
          {
            pattern: template.pattern,
            typeCode: template.typeCode,
            padding: template.padding,
            lastNumber: active?.lastNumber ?? 0,
          },
          prefix,
        ),
      };
    }).filter(Boolean);

    res.json({ prefix, rows });
  }),
);

const numberingSchema = z.object({
  pattern: z.string().min(3).includes('{SEQ}', { message: 'The pattern must contain {SEQ}' }),
  typeCode: z.string().min(1).max(8),
  padding: z.number().int().min(1).max(10),
  period: z.enum(['YEAR', 'NONE']),
});

numberingRoutes.put(
  '/:documentType',
  require_('admin.numbering.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(numberingSchema, req.body);
    const existing = await prisma.numberSequence.findMany({
      where: { documentType: req.params.documentType },
    });
    if (!existing.length) throw notFound('Unknown document type');

    // Update every period row so the change applies to this year's counter too,
    // without resetting anyone's sequence.
    await prisma.numberSequence.updateMany({
      where: { documentType: req.params.documentType },
      data: body,
    });

    await audit(
      {
        entityType: 'number_sequence',
        entityId: req.params.documentType,
        action: 'UPDATED',
        summary: `Numbering for ${req.params.documentType} set to ${body.pattern}`,
      },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  APPROVAL WORKFLOWS
// ════════════════════════════════════════════════════════════════════

export const workflowRoutes = Router();
workflowRoutes.use(authenticate);

workflowRoutes.get(
  '/',
  require_('admin.workflows.view_all'),
  handler(async (_req, res) => {
    const workflows = await prisma.approvalWorkflow.findMany({
      include: {
        steps: {
          orderBy: { sequence: 'asc' },
          include: {
            role: { select: { id: true, name: true } },
            user: { select: { id: true, name: true } },
          },
        },
        _count: { select: { requests: true } },
      },
      orderBy: [{ documentType: 'asc' }, { createdAt: 'asc' }],
    });
    // How many active people would actually receive each step.
    //
    // A workflow routed to a role nobody holds looks perfectly fine on screen
    // and then silently strands every document that hits it. Counting here
    // means the editor can warn before that happens rather than after.
    const roleCounts = new Map<string, number>();
    for (const row of await prisma.userRole.groupBy({
      by: ['roleId'],
      where: { user: { isActive: true } },
      _count: { userId: true },
    })) {
      roleCounts.set(row.roleId, row._count.userId);
    }
    const hrRole = await prisma.role.findUnique({ where: { key: 'hr' } });
    const hrCount = hrRole ? (roleCounts.get(hrRole.id) ?? 0) : 0;

    res.json(
      workflows.map((w) => ({
        ...w,
        minAmount: w.minAmount ? Number(w.minAmount) : null,
        maxAmount: w.maxAmount ? Number(w.maxAmount) : null,
        requestCount: w._count.requests,
        steps: w.steps.map((s) => ({
          ...s,
          // null = depends on the requester, so it cannot be counted up front.
          approverCount:
            s.approverType === 'ROLE'
              ? (s.roleId ? (roleCounts.get(s.roleId) ?? 0) : 0)
              : s.approverType === 'USER'
                ? (s.userId ? 1 : 0)
                : s.approverType === 'HR'
                  ? hrCount
                  : null,
        })),
      })),
    );
  }),
);

workflowRoutes.get(
  '/document-types',
  require_('admin.workflows.view_all'),
  handler(async (_req, res) => {
    res.json(DOCUMENT_TYPES);
  }),
);

const stepSchema = z.object({
  sequence: z.number().int().min(1),
  name: z.string().min(2),
  approverType: z.enum(['ROLE', 'USER', 'SUPERVISOR', 'HR']),
  roleId: z.string().optional().nullable(),
  userId: z.string().optional().nullable(),
});

const workflowSchema = z.object({
  documentType: z.string().min(2),
  name: z.string().min(2),
  isActive: z.boolean().default(true),
  minAmount: z.number().nonnegative().optional().nullable(),
  maxAmount: z.number().nonnegative().optional().nullable(),
  steps: z.array(stepSchema).min(1, 'A workflow needs at least one step'),
});

function validateSteps(steps: z.infer<typeof stepSchema>[]) {
  const seen = new Set<number>();
  for (const step of steps) {
    if (seen.has(step.sequence)) throw badRequest(`Duplicate step number ${step.sequence}`);
    seen.add(step.sequence);
    if (step.approverType === 'ROLE' && !step.roleId) {
      throw badRequest(`Step "${step.name}" routes to a role but no role is chosen`);
    }
    if (step.approverType === 'USER' && !step.userId) {
      throw badRequest(`Step "${step.name}" routes to a person but no person is chosen`);
    }
  }
}

workflowRoutes.post(
  '/',
  require_('admin.workflows.create'),
  handler(async (req, res) => {
    const body = parseBody(workflowSchema, req.body);
    validateSteps(body.steps);

    const workflow = await prisma.approvalWorkflow.create({
      data: {
        documentType: body.documentType,
        name: body.name,
        isActive: body.isActive,
        minAmount: body.minAmount != null ? new Prisma.Decimal(body.minAmount) : null,
        maxAmount: body.maxAmount != null ? new Prisma.Decimal(body.maxAmount) : null,
        steps: {
          create: body.steps.map((s) => ({
            sequence: s.sequence,
            name: s.name,
            approverType: s.approverType,
            roleId: s.approverType === 'ROLE' ? s.roleId : null,
            userId: s.approverType === 'USER' ? s.userId : null,
          })),
        },
      },
      include: { steps: true },
    });

    await audit(
      {
        entityType: 'approval_workflow',
        entityId: workflow.id,
        action: 'CREATED',
        summary: `Created workflow "${workflow.name}" for ${workflow.documentType}`,
      },
      req,
    );
    res.status(201).json(workflow);
  }),
);

workflowRoutes.put(
  '/:id',
  require_('admin.workflows.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(workflowSchema, req.body);
    validateSteps(body.steps);

    const existing = await prisma.approvalWorkflow.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Workflow not found');

    const workflow = await prisma.$transaction(async (tx) => {
      // Steps are replaced wholesale. In-flight requests keep their recorded
      // ApprovalActions (those are history and must survive), but they point at
      // a workflow whose shape changed — the engine handles a missing step by
      // refusing to act rather than by guessing.
      await tx.approvalStep.deleteMany({ where: { workflowId: req.params.id } });
      return tx.approvalWorkflow.update({
        where: { id: req.params.id },
        data: {
          documentType: body.documentType,
          name: body.name,
          isActive: body.isActive,
          minAmount: body.minAmount != null ? new Prisma.Decimal(body.minAmount) : null,
          maxAmount: body.maxAmount != null ? new Prisma.Decimal(body.maxAmount) : null,
          steps: {
            create: body.steps.map((s) => ({
              sequence: s.sequence,
              name: s.name,
              approverType: s.approverType,
              roleId: s.approverType === 'ROLE' ? s.roleId : null,
              userId: s.approverType === 'USER' ? s.userId : null,
            })),
          },
        },
        include: { steps: true },
      });
    });

    await audit(
      {
        entityType: 'approval_workflow',
        entityId: workflow.id,
        action: 'UPDATED',
        summary: `Updated workflow "${workflow.name}"`,
      },
      req,
    );
    res.json(workflow);
  }),
);

workflowRoutes.delete(
  '/:id',
  require_('admin.workflows.delete'),
  handler(async (req, res) => {
    const pending = await prisma.approvalRequest.count({
      where: { workflowId: req.params.id, status: 'PENDING' },
    });
    if (pending > 0) {
      throw badRequest(`${pending} request(s) are still in flight on this workflow`);
    }
    await prisma.approvalWorkflow.delete({ where: { id: req.params.id } });
    await audit(
      { entityType: 'approval_workflow', entityId: req.params.id, action: 'DELETED' },
      req,
    );
    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  AUDIT LOG
// ════════════════════════════════════════════════════════════════════

export const auditRoutes = Router();
auditRoutes.use(authenticate);

auditRoutes.get(
  '/',
  require_('admin.audit.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.AuditLogWhereInput = {};

    if (q.search) {
      where.OR = [
        { summary: { contains: q.search, mode: 'insensitive' } },
        { entityId: { contains: q.search, mode: 'insensitive' } },
        { actorName: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.filters.entityType) where.entityType = q.filters.entityType;
    if (q.filters.action) where.action = q.filters.action;
    if (q.filters.actorId) where.actorId = q.filters.actorId;
    if (q.filters.from || q.filters.to) {
      where.at = {};
      if (q.filters.from) where.at.gte = new Date(q.filters.from);
      if (q.filters.to) where.at.lte = new Date(`${q.filters.to}T23:59:59`);
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: orderBy(q, ['at', 'entityType', 'action'], { at: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json(listResult(rows, total, q));
  }),
);

/** The lifecycle of one record — powers the Activity tab on every workspace. */
auditRoutes.get(
  '/:entityType/:entityId',
  handler(async (req, res) => {
    const rows = await prisma.auditLog.findMany({
      where: { entityType: req.params.entityType, entityId: req.params.entityId },
      orderBy: { at: 'asc' },
    });
    res.json(rows);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SYSTEM SETTINGS  (keyed configuration)
// ════════════════════════════════════════════════════════════════════

export const settingRoutes = Router();
settingRoutes.use(authenticate);

settingRoutes.get(
  '/',
  require_('admin.settings.view_all'),
  handler(async (_req, res) => {
    res.json(await prisma.setting.findMany({ orderBy: { key: 'asc' } }));
  }),
);

settingRoutes.put(
  '/:key',
  require_('admin.settings.edit_all'),
  handler(async (req, res) => {
    const { value, description } = parseBody(
      z.object({ value: z.unknown(), description: z.string().optional() }),
      req.body,
    );
    const setting = await prisma.setting.upsert({
      where: { key: req.params.key },
      create: {
        key: req.params.key,
        value: value as Prisma.InputJsonValue,
        description: description ?? null,
      },
      update: { value: value as Prisma.InputJsonValue, description },
    });
    await audit(
      {
        entityType: 'setting',
        entityId: req.params.key,
        action: 'UPDATED',
        summary: `Changed setting ${req.params.key}`,
        after: value,
      },
      req,
    );
    res.json(setting);
  }),
);
