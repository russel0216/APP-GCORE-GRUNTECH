import { Router } from 'express';
import { z } from 'zod';
import {
  Prisma,
  AssetStatus,
  ContractStatus,
  ServiceKind,
  VisitStatus,
  ReportStatus,
} from '@prisma/client';
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
import type { ResolvedUser } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { formatShortDate, renderDocument } from '../shared/pdf';
import { registerSearch } from '../shared/search';
import { registerSchedule } from './workspace';
import { nextNumber } from '../shared/numbering';
import { notify } from '../shared/notifications';
import { submitForApproval, onApprovalSettled } from '../shared/approvals';
import {
  aftermarketSettings,
  saveAftermarketSettings,
  addMonths,
  dayKey,
  daysBetween,
  expiryState,
  planSchedule,
  regenerateSchedule,
  validateSections,
  missingRequired,
  currentTemplate,
  renewalPipeline,
  sweepOverdue,
  type TemplateSection,
} from '../shared/aftermarket';

const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

function asEnum<T extends Record<string, string>>(e: T, value: string | undefined): T[keyof T] | undefined {
  return value && value in e ? (value as T[keyof T]) : undefined;
}

function asDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${label} is not a valid date`);
  return dayKey(date);
}

/** The document type a report of each kind is numbered and approved under. */
export const REPORT_DOC_TYPE: Record<string, string> = {
  COMMISSIONING: 'commissioning_report',
  PREVENTIVE_MAINTENANCE: 'pm_report',
  INSPECTION: 'inspection_report',
  CORRECTIVE: 'inspection_report',
};

export const KIND_LABEL: Record<string, string> = {
  COMMISSIONING: 'Commissioning',
  PREVENTIVE_MAINTENANCE: 'Preventive maintenance',
  INSPECTION: 'Inspection',
  CORRECTIVE: 'Corrective',
};

/** Which permission covers a report of each kind. */
export function reportPermission(kind: string, action: string): string {
  if (kind === 'COMMISSIONING') return `gops.commissioning_reports.${action}`;
  if (kind === 'PREVENTIVE_MAINTENANCE') return `gops.pm_reports.${action}`;
  return `gops.inspection_reports.${action}`;
}

// ════════════════════════════════════════════════════════════════════
//  INSTALLED BASE
// ════════════════════════════════════════════════════════════════════

export const assetRoutes = Router();
assetRoutes.use(authenticate);

const assetInclude = {
  customer: { select: { id: true, code: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  job: { select: { id: true, number: true, name: true } },
  item: { select: { id: true, code: true, name: true } },
} satisfies Prisma.InstalledAssetInclude;

type AssetRow = Prisma.InstalledAssetGetPayload<{ include: typeof assetInclude }>;

function presentAsset(row: AssetRow, warningDays: number) {
  const warranty = expiryState(row.warrantyEndsAt, warningDays);
  return {
    ...row,
    warranty: warranty.state,
    warrantyDaysRemaining: warranty.daysRemaining,
  };
}

/**
 * Which assets a register query means — one rule for the list AND its PDF
 * export, so the paper matches the screen it was printed off.
 */
function assetListWhere(q: ReturnType<typeof listQuery>, expiryWarningDays: number): Prisma.InstalledAssetWhereInput {
  const where: Prisma.InstalledAssetWhereInput = {};

  const status = asEnum(AssetStatus, q.filters.status);
  if (status) where.status = status;
  if (q.filters.customerId) where.customerId = q.filters.customerId;
  if (q.filters.siteId) where.siteId = q.filters.siteId;
  if (q.filters.jobId) where.jobId = q.filters.jobId;

  const today = dayKey(new Date());
  if (q.filters.warranty === 'EXPIRED') where.warrantyEndsAt = { lt: today };
  if (q.filters.warranty === 'EXPIRING') {
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + expiryWarningDays);
    where.warrantyEndsAt = { gte: today, lte: horizon };
  }
  if (q.filters.warranty === 'ACTIVE') {
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + expiryWarningDays);
    where.warrantyEndsAt = { gt: horizon };
  }
  // The commercially interesting set: installed, out of warranty or about to
  // be, and covered by nothing.
  if (q.filters.uncovered === 'true') {
    where.contracts = { none: { contract: { status: 'ACTIVE' } } };
  }

  if (q.search) {
    where.OR = [
      { code: { contains: q.search, mode: 'insensitive' } },
      { name: { contains: q.search, mode: 'insensitive' } },
      { serialNo: { contains: q.search, mode: 'insensitive' } },
      { model: { contains: q.search, mode: 'insensitive' } },
      { customer: { name: { contains: q.search, mode: 'insensitive' } } },
      { address: { contains: q.search, mode: 'insensitive' } },
    ];
  }
  return where;
}

assetRoutes.get(
  '/',
  require_('gops.installed_base.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const settings = await aftermarketSettings();
    const where = assetListWhere(q, settings.expiryWarningDays);

    const [rows, total] = await Promise.all([
      prisma.installedAsset.findMany({
        where,
        include: assetInclude,
        orderBy: orderBy(q, ['code', 'name', 'warrantyEndsAt', 'installedAt', 'createdAt'], {
          createdAt: 'desc',
        }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.installedAsset.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => presentAsset(r, settings.expiryWarningDays)), total, q));
  }),
);

/** The name trimmed, single-spaced and upper-cased: one equipment type per spelling. */
const typeKey = (name: string) => name.trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Remembers the equipment types the register was given, so the next
 * registration can pick rather than retype — the quotation-groups pattern.
 * Existing rows are never overwritten; the seeded common types keep their
 * order and everything typed since sorts after them, alphabetically.
 */
async function rememberEquipmentTypes(names: (string | null | undefined)[]): Promise<void> {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const key = typeKey(raw ?? '');
    if (key && !byKey.has(key)) byKey.set(key, key.slice(0, 120));
  }
  if (!byKey.size) return;
  await prisma.equipmentType.createMany({
    data: [...byKey].map(([key, name]) => ({ key, name })),
    skipDuplicates: true,
  });
}

/** What the register's Equipment type field suggests. Above `/:id`, the route-order trap. */
assetRoutes.get(
  '/types',
  require_('gops.installed_base.view_all'),
  handler(async (_req, res) => {
    const rows = await prisma.equipmentType.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } });
    res.json(rows.map((r) => r.name));
  }),
);

/**
 * The register on paper (2026-10-07, the owner's call) — the SAME query as
 * the list, through `assetListWhere`, so the paper matches the screen. The
 * CSV twin is the list's own Export; this is the one you hand to somebody.
 */
assetRoutes.get(
  '/pdf',
  require_('gops.installed_base.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const settings = await aftermarketSettings();
    const rows = await prisma.installedAsset.findMany({
      where: assetListWhere(q, settings.expiryWarningDays),
      include: assetInclude,
      orderBy: orderBy(q, ['code', 'name', 'warrantyEndsAt', 'installedAt', 'createdAt'], { createdAt: 'desc' }),
      take: 1000,
    });

    const filters = [
      q.search ? `search "${q.search}"` : null,
      q.filters.warranty ? `warranty ${q.filters.warranty.toLowerCase()}` : null,
      q.filters.uncovered === 'true' ? 'no active contract' : null,
      q.filters.status ? `status ${q.filters.status.toLowerCase()}` : null,
    ].filter(Boolean);

    const pdf = await renderDocument({
      title: 'Installed Base',
      date: new Date(),
      reference: `${rows.length} machine(s)${filters.length ? ` — ${filters.join(' · ')}` : ''}`,
      sections: [
        {
          kind: 'table',
          head: ['Code', 'Equipment', 'Customer and address', 'Location', 'Installed', 'Warranty', 'Status'],
          widths: [1, 2.3, 2.3, 1.3, 1, 1.3, 0.9],
          rows: rows.map((r) => {
            const warranty = expiryState(r.warrantyEndsAt, settings.expiryWarningDays);
            return [
              r.code,
              {
                title: r.name,
                body: [[r.manufacturer, r.model].filter(Boolean).join(' '), r.serialNo ? `S/N ${r.serialNo}` : null]
                  .filter(Boolean)
                  .join(' · ') || undefined,
              },
              { title: r.customer.name, body: r.address ?? r.site?.name ?? undefined },
              r.location ?? '',
              r.installedAt ? formatShortDate(r.installedAt) : '',
              r.warrantyEndsAt
                ? `${formatShortDate(r.warrantyEndsAt)} (${(WARRANTY_WORD[warranty.state] ?? warranty.state).toLowerCase()})`
                : 'not recorded',
              r.status.toLowerCase(),
            ];
          }),
        },
      ],
      signatories: [],
    });

    await audit(
      { entityType: 'installed_asset', entityId: 'list', action: 'EXPORTED', summary: `Exported the installed base as PDF (${rows.length} machine(s))` },
      req,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="installed-base.pdf"`);
    res.send(pdf);
  }),
);

const WARRANTY_WORD: Record<string, string> = { ACTIVE: 'in warranty', EXPIRING: 'expiring', EXPIRED: 'expired', NONE: '' };

assetRoutes.get(
  '/:id',
  require_('gops.installed_base.view_all'),
  handler(async (req, res) => {
    const settings = await aftermarketSettings();
    const row = await prisma.installedAsset.findUnique({
      where: { id: req.params.id },
      include: {
        ...assetInclude,
        contracts: {
          include: {
            contract: {
              select: {
                id: true,
                number: true,
                status: true,
                startsAt: true,
                endsAt: true,
                job: { select: { id: true, number: true, name: true } },
              },
            },
          },
        },
        reports: {
          select: {
            id: true,
            number: true,
            kind: true,
            status: true,
            performedAt: true,
            findings: true,
            performedBy: { select: { id: true, name: true } },
          },
          orderBy: { performedAt: 'desc' },
          take: 50,
        },
        visits: {
          where: { status: { in: ['SCHEDULED', 'MISSED'] } },
          select: { id: true, number: true, dueDate: true, kind: true, status: true },
          orderBy: { dueDate: 'asc' },
          take: 10,
        },
        jobOrders: {
          select: {
            id: true,
            number: true,
            kind: true,
            status: true,
            title: true,
            requestedFor: true,
            chargeBasis: true,
          },
          orderBy: { requestedFor: 'desc' },
          take: 20,
        },
      },
    });
    if (!row) throw notFound('Asset not found');

    res.json({
      ...presentAsset(row as unknown as AssetRow, settings.expiryWarningDays),
      contracts: row.contracts.map((c) => c.contract),
      reports: row.reports,
      upcomingVisits: row.visits,
      jobOrders: row.jobOrders,
    });
  }),
);

const assetSchema = z.object({
  customerId: z.string().min(1, 'Which customer?'),
  siteId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  itemId: z.string().optional().nullable(),
  name: z.string().trim().min(2, 'What is it?'),
  manufacturer: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  serialNo: z.string().optional().nullable(),
  capacity: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  installedAt: z.string().optional().nullable(),
  commissionedAt: z.string().optional().nullable(),
  warrantyEndsAt: z.string().optional().nullable(),
  warrantyMonths: z.number().int().min(0).max(240).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DECOMMISSIONED']).optional(),
  notes: z.string().optional().nullable(),
});

assetRoutes.post(
  '/',
  require_('gops.installed_base.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(assetSchema, req.body);
    const settings = await aftermarketSettings();

    const installedAt = body.installedAt ? asDate(body.installedAt, 'Installed on') : null;
    // The warranty end is usually "twelve months from commissioning" rather
    // than a date anyone wrote down, so let it be derived.
    const warrantyEndsAt = body.warrantyEndsAt
      ? asDate(body.warrantyEndsAt, 'Warranty ends')
      : installedAt
        ? addMonths(installedAt, body.warrantyMonths ?? settings.defaultWarrantyMonths)
        : null;

    // A serial number that already exists is nearly always the same machine
    // being registered twice, and a duplicated asset splits its own history.
    if (body.serialNo) {
      const clash = await prisma.installedAsset.findFirst({
        where: { serialNo: body.serialNo, status: { not: 'DECOMMISSIONED' } },
        select: { id: true, code: true, name: true },
      });
      if (clash) {
        throw badRequest(
          `Serial ${body.serialNo} is already registered as ${clash.code} — ${clash.name}. Registering it twice splits its service history.`,
        );
      }
    }

    const asset = await prisma.$transaction(async (tx) => {
      const code = await nextNumber('installed_asset', tx);
      return tx.installedAsset.create({
        data: {
          code,
          customerId: body.customerId,
          siteId: body.siteId || null,
          jobId: body.jobId || null,
          itemId: body.itemId || null,
          name: body.name,
          manufacturer: body.manufacturer || null,
          model: body.model || null,
          serialNo: body.serialNo || null,
          capacity: body.capacity || null,
          location: body.location || null,
          address: body.address || null,
          installedAt,
          commissionedAt: body.commissionedAt ? asDate(body.commissionedAt, 'Commissioned on') : null,
          warrantyEndsAt,
          status: body.status ?? 'ACTIVE',
          notes: body.notes || null,
          createdById: me.id,
        },
        include: assetInclude,
      });
    });

    await rememberEquipmentTypes([body.name]);
    await audit(
      {
        entityType: 'installed_asset',
        entityId: asset.id,
        action: 'CREATED',
        summary: `${asset.code} — ${asset.name} registered at ${asset.customer.name}`,
      },
      req,
    );
    res.status(201).json(presentAsset(asset, settings.expiryWarningDays));
  }),
);

assetRoutes.patch(
  '/:id',
  require_('gops.installed_base.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(assetSchema.partial(), req.body);
    const settings = await aftermarketSettings();
    const existing = await prisma.installedAsset.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Asset not found');

    const updated = await prisma.installedAsset.update({
      where: { id: existing.id },
      data: {
        ...(body.customerId ? { customerId: body.customerId } : {}),
        ...(body.siteId !== undefined ? { siteId: body.siteId || null } : {}),
        ...(body.jobId !== undefined ? { jobId: body.jobId || null } : {}),
        ...(body.itemId !== undefined ? { itemId: body.itemId || null } : {}),
        ...(body.name ? { name: body.name } : {}),
        ...(body.manufacturer !== undefined ? { manufacturer: body.manufacturer || null } : {}),
        ...(body.model !== undefined ? { model: body.model || null } : {}),
        ...(body.serialNo !== undefined ? { serialNo: body.serialNo || null } : {}),
        ...(body.capacity !== undefined ? { capacity: body.capacity || null } : {}),
        ...(body.location !== undefined ? { location: body.location || null } : {}),
        ...(body.address !== undefined ? { address: body.address || null } : {}),
        ...(body.installedAt !== undefined
          ? { installedAt: body.installedAt ? asDate(body.installedAt, 'Installed on') : null }
          : {}),
        ...(body.commissionedAt !== undefined
          ? { commissionedAt: body.commissionedAt ? asDate(body.commissionedAt, 'Commissioned on') : null }
          : {}),
        ...(body.warrantyEndsAt !== undefined
          ? { warrantyEndsAt: body.warrantyEndsAt ? asDate(body.warrantyEndsAt, 'Warranty ends') : null }
          : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      },
      include: assetInclude,
    });

    if (body.name) await rememberEquipmentTypes([body.name]);
    await audit(
      {
        entityType: 'installed_asset',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `${updated.code} updated`,
        before: existing,
        after: updated,
      },
      req,
    );
    res.json(presentAsset(updated, settings.expiryWarningDays));
  }),
);

/**
 * Registering everything a finished project installed, in one go.
 *
 * "A turned-over project generates a PM schedule and a signed PM report"
 * starts here: without the register there is nothing to schedule against, and
 * asking somebody to key twenty assets by hand at turnover means it never
 * happens.
 */
assetRoutes.post(
  '/from-job/:jobId',
  require_('gops.installed_base.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      z.object({
        assets: z
          .array(
            z.object({
              name: z.string().trim().min(2),
              itemId: z.string().optional().nullable(),
              manufacturer: z.string().optional().nullable(),
              model: z.string().optional().nullable(),
              serialNo: z.string().optional().nullable(),
              capacity: z.string().optional().nullable(),
              location: z.string().optional().nullable(),
            }),
          )
          .min(1, 'Nothing to register'),
        installedAt: z.string().optional(),
        warrantyMonths: z.number().int().min(0).max(240).optional(),
      }),
      req.body,
    );

    const job = await prisma.job.findUnique({
      where: { id: req.params.jobId },
      select: { id: true, number: true, customerId: true, siteId: true },
    });
    if (!job) throw notFound('Project not found');

    const settings = await aftermarketSettings();
    const installedAt = body.installedAt ? asDate(body.installedAt, 'Installed on') : dayKey(new Date());
    const warrantyEndsAt = addMonths(installedAt, body.warrantyMonths ?? settings.defaultWarrantyMonths);

    const serials = body.assets.map((a) => a.serialNo).filter(Boolean) as string[];
    if (serials.length) {
      const clashes = await prisma.installedAsset.findMany({
        where: { serialNo: { in: serials }, status: { not: 'DECOMMISSIONED' } },
        select: { code: true, serialNo: true },
      });
      if (clashes.length) {
        throw badRequest(
          `Already registered: ${clashes.map((c) => `${c.serialNo} (${c.code})`).join(', ')}`,
        );
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const a of body.assets) {
        out.push(
          await tx.installedAsset.create({
            data: {
              code: await nextNumber('installed_asset', tx),
              customerId: job.customerId,
              siteId: job.siteId,
              jobId: job.id,
              itemId: a.itemId || null,
              name: a.name,
              manufacturer: a.manufacturer || null,
              model: a.model || null,
              serialNo: a.serialNo || null,
              capacity: a.capacity || null,
              location: a.location || null,
              installedAt,
              warrantyEndsAt,
              createdById: me.id,
            },
            include: assetInclude,
          }),
        );
      }
      return out;
    });

    await audit(
      {
        entityType: 'job',
        entityId: job.id,
        action: 'UPDATED',
        summary: `${created.length} asset(s) registered from ${job.number}, warranty to ${warrantyEndsAt.toISOString().slice(0, 10)}`,
      },
      req,
    );
    res.status(201).json(created.map((a) => presentAsset(a, settings.expiryWarningDays)));
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SERVICE CONTRACTS
// ════════════════════════════════════════════════════════════════════

export const contractRoutes = Router();
contractRoutes.use(authenticate);

const contractInclude = {
  job: {
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      contractValue: true,
      customer: { select: { id: true, code: true, name: true } },
      site: { select: { id: true, name: true } },
      projectManager: { select: { id: true, name: true } },
      // Renewal starts from a copy of this costing (POST /costings/:id/duplicate).
      costing: { select: { id: true } },
    },
  },
  assets: { include: { asset: { select: { id: true, code: true, name: true, serialNo: true } } } },
} satisfies Prisma.ServiceContractInclude;

type ContractRow = Prisma.ServiceContractGetPayload<{ include: typeof contractInclude }>;

function presentContract(row: ContractRow, warningDays: number) {
  const term = expiryState(row.endsAt, warningDays);
  return {
    ...row,
    job: { ...row.job, contractValue: num(row.job.contractValue) },
    assets: row.assets.map((a) => a.asset),
    expiry: term.state,
    daysRemaining: term.daysRemaining,
  };
}

contractRoutes.get(
  '/',
  requireAny('gops.service_contracts.view_all', 'gops.service_contracts.view_own'),
  handler(async (req, res) => {
    await sweepOverdue();
    const me = currentUser(req);
    const q = listQuery(req);
    const settings = await aftermarketSettings();
    const where: Prisma.ServiceContractWhereInput = {};

    // The contract's owner is the job's project manager — coverage terms have
    // no separate owner, because the job is the commercial record.
    const jobWhere: Prisma.JobWhereInput = {};
    const onlyOwn = !me.isSuperAdmin && !me.permissions.has('gops.service_contracts.view_all');
    if (onlyOwn || q.scope === 'mine') jobWhere.projectManagerId = me.id;
    if (q.filters.customerId) jobWhere.customerId = q.filters.customerId;
    if (Object.keys(jobWhere).length) where.job = jobWhere;

    const status = asEnum(ContractStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.expiring === 'true') {
      const horizon = dayKey(new Date());
      horizon.setUTCDate(horizon.getUTCDate() + settings.expiryWarningDays);
      where.status = 'ACTIVE';
      where.endsAt = { lte: horizon };
    }
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { job: { name: { contains: q.search, mode: 'insensitive' } } },
        { job: { customer: { name: { contains: q.search, mode: 'insensitive' } } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.serviceContract.findMany({
        where,
        include: contractInclude,
        orderBy: orderBy(q, ['number', 'startsAt', 'endsAt', 'createdAt'], { endsAt: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.serviceContract.count({ where }),
    ]);

    res.json(listResult(rows.map((r) => presentContract(r, settings.expiryWarningDays)), total, q));
  }),
);

contractRoutes.get(
  '/:id',
  requireAny('gops.service_contracts.view_all', 'gops.service_contracts.view_own'),
  handler(async (req, res) => {
    const settings = await aftermarketSettings();
    const row = await prisma.serviceContract.findUnique({
      where: { id: req.params.id },
      include: {
        ...contractInclude,
        visits: {
          include: {
            assignedTo: { select: { id: true, name: true } },
            report: { select: { id: true, number: true, status: true } },
            jobOrder: { select: { id: true, number: true, status: true } },
          },
          orderBy: { dueDate: 'asc' },
        },
        renewedFrom: { select: { id: true, number: true, endsAt: true } },
        renewedTo: { select: { id: true, number: true, startsAt: true } },
      },
    });
    if (!row) throw notFound('Service contract not found');

    const completed = row.visits.filter((v) => v.status === 'COMPLETED').length;
    res.json({
      ...presentContract(row as unknown as ContractRow, settings.expiryWarningDays),
      visits: row.visits,
      renewedFrom: row.renewedFrom,
      renewedTo: row.renewedTo,
      progress: {
        planned: row.plannedVisits,
        completed,
        missed: row.visits.filter((v) => v.status === 'MISSED').length,
        remaining: row.visits.filter((v) => v.status === 'SCHEDULED').length,
      },
    });
  }),
);

const contractSchema = z.object({
  jobId: z.string().min(1, 'Which service job?'),
  startsAt: z.string().min(1, 'When does cover start?'),
  endsAt: z.string().min(1, 'When does cover end?'),
  frequencyMonths: z.number().int().min(1).max(24).optional(),
  responseTime: z.string().optional().nullable(),
  exclusions: z.string().optional().nullable(),
  coverageNotes: z.string().optional().nullable(),
  assetIds: z.array(z.string()).default([]),
  renewedFromId: z.string().optional().nullable(),
});

contractRoutes.post(
  '/',
  require_('gops.service_contracts.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(contractSchema, req.body);
    const settings = await aftermarketSettings();

    const job = await prisma.job.findUnique({
      where: { id: body.jobId },
      include: { serviceContract: { select: { id: true, number: true } } },
    });
    if (!job) throw notFound('Job not found');
    // A service contract IS a job of that type (model §4.5). Attaching coverage
    // terms to a delivery project would give it a PM schedule it has no budget
    // to service.
    if (job.type !== 'SERVICE_CONTRACT') {
      throw badRequest(
        `${job.number} is a delivery project, not a service contract. Create the job as a service contract first — that is where its costing and budget come from.`,
      );
    }
    if (job.serviceContract) {
      throw badRequest(`${job.number} already has coverage terms (${job.serviceContract.number})`);
    }

    const startsAt = asDate(body.startsAt, 'Start date');
    const endsAt = asDate(body.endsAt, 'End date');
    const frequencyMonths = body.frequencyMonths ?? settings.defaultFrequencyMonths;
    const planned = planSchedule(startsAt, endsAt, frequencyMonths);

    const contract = await prisma.$transaction(async (tx) => {
      const created = await tx.serviceContract.create({
        data: {
          number: await nextNumber('service_contract', tx),
          jobId: job.id,
          startsAt,
          endsAt,
          frequencyMonths,
          plannedVisits: planned.length,
          responseTime: body.responseTime || null,
          exclusions: body.exclusions || null,
          coverageNotes: body.coverageNotes || null,
          renewedFromId: body.renewedFromId || null,
          createdById: me.id,
          assets: { create: body.assetIds.map((assetId) => ({ assetId })) },
        },
        include: contractInclude,
      });
      return created;
    });

    await audit(
      {
        entityType: 'service_contract',
        entityId: contract.id,
        action: 'CREATED',
        summary: `${contract.number} — ${body.assetIds.length} asset(s), ${planned.length} visit(s) planned every ${frequencyMonths} month(s)`,
      },
      req,
    );
    res.status(201).json(presentContract(contract, settings.expiryWarningDays));
  }),
);

/**
 * Activating a contract writes its PM schedule.
 *
 * Kept as a separate act rather than happening on creation: a contract in
 * draft is still being negotiated, and a schedule of visits nobody has agreed
 * to would show up on engineers' work lists.
 */
contractRoutes.post(
  '/:id/activate',
  require_('gops.service_contracts.edit_all'),
  handler(async (req, res) => {
    const contract = await prisma.serviceContract.findUnique({
      where: { id: req.params.id },
      include: { assets: true },
    });
    if (!contract) throw notFound('Service contract not found');
    if (contract.status !== 'DRAFT') throw badRequest('This contract is already active');
    if (contract.assets.length === 0) {
      throw badRequest(
        'No equipment is covered by this contract. A schedule against nothing would send engineers to look at air.',
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.serviceContract.update({ where: { id: contract.id }, data: { status: 'ACTIVE' } });
      return regenerateSchedule(tx, contract.id, (t) => nextNumber('service_visit', t));
    });

    await audit(
      {
        entityType: 'service_contract',
        entityId: contract.id,
        action: 'EXECUTED',
        summary: `${contract.number} activated — ${result.created} visit(s) scheduled`,
      },
      req,
    );
    res.json({ ok: true, ...result });
  }),
);

contractRoutes.post(
  '/:id/regenerate-schedule',
  require_('gops.service_contracts.edit_all'),
  handler(async (req, res) => {
    const contract = await prisma.serviceContract.findUnique({ where: { id: req.params.id } });
    if (!contract) throw notFound('Service contract not found');

    const result = await prisma.$transaction((tx) =>
      regenerateSchedule(tx, contract.id, (t) => nextNumber('service_visit', t)),
    );

    await audit(
      {
        entityType: 'service_contract',
        entityId: contract.id,
        action: 'UPDATED',
        summary: `Schedule regenerated — ${result.created} new visit(s), ${result.kept} attended visit(s) kept`,
      },
      req,
    );
    res.json({ ok: true, ...result });
  }),
);

contractRoutes.patch(
  '/:id',
  require_('gops.service_contracts.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(contractSchema.omit({ jobId: true }).partial(), req.body);
    const contract = await prisma.serviceContract.findUnique({ where: { id: req.params.id } });
    if (!contract) throw notFound('Service contract not found');

    const startsAt = body.startsAt ? asDate(body.startsAt, 'Start date') : contract.startsAt;
    const endsAt = body.endsAt ? asDate(body.endsAt, 'End date') : contract.endsAt;
    if (endsAt <= startsAt) throw badRequest('The contract ends before it starts');

    const updated = await prisma.$transaction(async (tx) => {
      if (body.assetIds) {
        await tx.serviceContractAsset.deleteMany({ where: { contractId: contract.id } });
        await tx.serviceContractAsset.createMany({
          data: body.assetIds.map((assetId) => ({ contractId: contract.id, assetId })),
        });
      }
      return tx.serviceContract.update({
        where: { id: contract.id },
        data: {
          startsAt,
          endsAt,
          ...(body.frequencyMonths ? { frequencyMonths: body.frequencyMonths } : {}),
          ...(body.responseTime !== undefined ? { responseTime: body.responseTime || null } : {}),
          ...(body.exclusions !== undefined ? { exclusions: body.exclusions || null } : {}),
          ...(body.coverageNotes !== undefined ? { coverageNotes: body.coverageNotes || null } : {}),
        },
        include: contractInclude,
      });
    });

    const settings = await aftermarketSettings();
    res.json(presentContract(updated, settings.expiryWarningDays));
  }),
);

/** Service-contract jobs with no coverage terms yet. */
contractRoutes.get(
  '/queue/unconfigured',
  requireAny('gops.service_contracts.view_all', 'gops.service_contracts.view_own'),
  handler(async (_req, res) => {
    const jobs = await prisma.job.findMany({
      where: { type: 'SERVICE_CONTRACT', serviceContract: null, status: { not: 'CANCELLED' } },
      select: {
        id: true,
        number: true,
        name: true,
        contractValue: true,
        customer: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(jobs.map((j) => ({ ...j, contractValue: num(j.contractValue) })));
  }),
);

// ════════════════════════════════════════════════════════════════════
//  VISITS — the PM schedule
// ════════════════════════════════════════════════════════════════════

export const visitRoutes = Router();
visitRoutes.use(authenticate);

const visitInclude = {
  contract: {
    select: {
      id: true,
      number: true,
      plannedVisits: true,
      job: { select: { id: true, number: true, name: true } },
    },
  },
  customer: { select: { id: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  asset: { select: { id: true, code: true, name: true, serialNo: true } },
  assignedTo: { select: { id: true, name: true } },
  report: { select: { id: true, number: true, status: true, performedAt: true } },
  // Why a visit with no contract sequence exists: the job order that asked for it.
  jobOrder: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ServiceVisitInclude;

/**
 * Who may open the schedule. The report permissions are the historical guard;
 * `gops.visits.view_all` is the one the menu entry itself asks for, so holding
 * it and being refused the data behind the screen would be a lie.
 */
const VISIT_VIEW = [
  'gops.pm_reports.view_all',
  'gops.pm_reports.view_own',
  'gops.service_contracts.view_all',
  'gops.visits.view_all',
] as const;

/**
 * Somebody who can see visits only through `pm_reports.view_own` sees the
 * visits booked on them — the same "own" the reports list applies. Everyone
 * else on the schedule sees the whole schedule.
 */
function visitsOnlyOwn(me: ResolvedUser): boolean {
  return !(
    me.isSuperAdmin ||
    me.permissions.has('gops.pm_reports.view_all') ||
    me.permissions.has('gops.service_contracts.view_all') ||
    me.permissions.has('gops.visits.view_all')
  );
}

/** The filters the list, the calendar feed and the sales calendar share. */
function visitWhere(
  filters: Record<string, string | undefined>,
  me: ResolvedUser,
  mine: boolean,
): Prisma.ServiceVisitWhereInput {
  const where: Prisma.ServiceVisitWhereInput = {};
  if (filters.assignedToId === 'none') where.assignedToId = null;
  else if (filters.assignedToId) where.assignedToId = filters.assignedToId;
  if (mine || visitsOnlyOwn(me)) where.assignedToId = me.id;

  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.siteId) where.siteId = filters.siteId;
  if (filters.assetId) where.assetId = filters.assetId;
  const kind = asEnum(ServiceKind, filters.kind);
  if (kind) where.kind = kind;

  // `statuses=SCHEDULED,MISSED` — how the report picker asks for every visit
  // that can still be reported against, late ones included.
  const many = (filters.statuses ?? '')
    .split(',')
    .map((s) => asEnum(VisitStatus, s.trim()))
    .filter((s): s is VisitStatus => !!s);
  const one = asEnum(VisitStatus, filters.status);
  if (many.length) where.status = { in: many };
  else if (one) where.status = one;
  return where;
}

/** Derived on read, never stored: a stored flag is wrong the moment midnight passes. */
function presentVisit<T extends { status: string; dueDate: Date }>(row: T, today: Date) {
  return {
    ...row,
    daysUntilDue: daysBetween(today, row.dueDate),
    overdue: row.status === 'SCHEDULED' && row.dueDate < today,
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/*
  Route order matters here. `/calendar` has to be registered before `/:id`,
  or Express hands "calendar" to the `:id` route and the feed answers 404 —
  the same trap as `/overtime/chargeable`.
*/

/**
 * The range feed behind the month grid (and the sales calendar's service
 * series). A paginated list caps at 200 rows and is shaped for a table; a
 * calendar needs every visit in a window in one call, the reports written
 * with no visit behind them, and the people to filter by.
 *
 * It sweeps first: a calendar that shows a three-week-late visit as merely
 * scheduled is lying about the one thing it exists to show.
 */
visitRoutes.get(
  '/calendar',
  requireAny(...VISIT_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = req.query as Record<string, string | undefined>;
    if (!q.from || !q.to) throw badRequest('A calendar window needs a from and a to date');
    const from = asDate(q.from, 'From');
    const to = asDate(q.to, 'To');
    if (to < from) throw badRequest('The window ends before it starts');
    // A six-row month grid is 42 days; 62 allows a month and its padding and
    // refuses an accidental year-long pull.
    if (daysBetween(from, to) > 62) throw badRequest('A calendar window is at most 62 days');

    await sweepOverdue();
    const settings = await aftermarketSettings();
    const today = dayKey(new Date());
    const mine = q.scope === 'mine';

    const where: Prisma.ServiceVisitWhereInput = {
      ...visitWhere(q, me, mine),
      dueDate: { gte: from, lte: to },
    };

    // Reports with no visit — commissioning, a walk-in inspection — are
    // history, not schedule. They sit on the day the work was done as a
    // second series, and never turn into visits. A visit status filter asks
    // about visits, so it leaves them out; so does "unassigned".
    const canReports =
      me.isSuperAdmin ||
      [
        'gops.pm_reports',
        'gops.commissioning_reports',
        'gops.inspection_reports',
      ].some((m) => me.permissions.has(`${m}.view_all`) || me.permissions.has(`${m}.view_own`));
    const allReports =
      me.isSuperAdmin ||
      me.permissions.has('gops.pm_reports.view_all') ||
      me.permissions.has('gops.commissioning_reports.view_all') ||
      me.permissions.has('gops.inspection_reports.view_all');
    const wantReports =
      q.includeReports !== 'false' &&
      canReports &&
      !q.status &&
      !q.statuses &&
      q.assignedToId !== 'none';

    const reportWhere: Prisma.ServiceReportWhereInput = {
      visitId: null,
      performedAt: { gte: from, lte: to },
    };
    if (q.customerId) reportWhere.customerId = q.customerId;
    if (q.contractId) reportWhere.contractId = q.contractId;
    if (q.siteId) reportWhere.siteId = q.siteId;
    if (q.assetId) reportWhere.assetId = q.assetId;
    const kind = asEnum(ServiceKind, q.kind);
    if (kind) reportWhere.kind = kind;
    if (q.assignedToId && q.assignedToId !== 'none') reportWhere.performedById = q.assignedToId;
    if (mine || !allReports) reportWhere.performedById = me.id;

    const [visits, reports, engineers] = await Promise.all([
      prisma.serviceVisit.findMany({
        where,
        include: visitInclude,
        orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
        take: 1000,
      }),
      wantReports
        ? prisma.serviceReport.findMany({
            where: reportWhere,
            select: {
              id: true,
              number: true,
              kind: true,
              status: true,
              performedAt: true,
              billable: true,
              underWarranty: true,
              customer: { select: { id: true, name: true } },
              site: { select: { id: true, name: true } },
              asset: { select: { id: true, code: true, name: true } },
              contract: { select: { id: true, number: true } },
              performedBy: { select: { id: true, name: true } },
            },
            orderBy: { performedAt: 'asc' },
            take: 1000,
          })
        : Promise.resolve([]),
      // The permission-safe people list for the filter: names already on the
      // schedule, nothing more. Handing every login to anyone who can see a
      // visit would be a directory nobody decided to publish.
      prisma.serviceVisit.findMany({
        where: { assignedToId: { not: null } },
        distinct: ['assignedToId'],
        select: { assignedTo: { select: { id: true, name: true } } },
      }),
    ]);

    res.json({
      from: isoDay(from),
      to: isoDay(to),
      asOf: isoDay(today),
      visits: visits.map((v) => presentVisit(v, today)),
      reports,
      engineers: engineers
        .map((e) => e.assignedTo)
        .filter((u): u is { id: string; name: string } => !!u)
        .sort((a, b) => a.name.localeCompare(b.name)),
      missedAfterDays: settings.missedAfterDays,
    });
  }),
);

/** One visit — what every `?visit=` link (notification, contract, asset, report) opens. */
visitRoutes.get(
  '/:id',
  requireAny(...VISIT_VIEW),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.serviceVisit.findUnique({ where: { id: req.params.id }, include: visitInclude });
    if (!row) throw notFound('Visit not found');
    if (visitsOnlyOwn(me) && row.assignedToId !== me.id) {
      throw forbidden('That is someone else’s visit');
    }
    res.json(presentVisit(row, dayKey(new Date())));
  }),
);

visitRoutes.get(
  '/',
  requireAny(...VISIT_VIEW),
  handler(async (req, res) => {
    await sweepOverdue();
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.ServiceVisitWhereInput = visitWhere(q.filters, me, q.scope === 'mine');

    if (q.filters.from || q.filters.to) {
      where.dueDate = {};
      if (q.filters.from) where.dueDate.gte = asDate(q.filters.from, 'From');
      if (q.filters.to) where.dueDate.lte = asDate(q.filters.to, 'To');
    }
    if (q.filters.due === 'true') {
      where.status = 'SCHEDULED';
      where.dueDate = { lte: dayKey(new Date()) };
    }
    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { asset: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.serviceVisit.findMany({
        where,
        include: visitInclude,
        orderBy: orderBy(q, ['number', 'dueDate', 'performedAt'], { dueDate: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.serviceVisit.count({ where }),
    ]);

    const today = dayKey(new Date());
    res.json(listResult(rows.map((r) => presentVisit(r, today)), total, q));
  }),
);

const visitSchema = z.object({
  kind: z.enum(['COMMISSIONING', 'PREVENTIVE_MAINTENANCE', 'INSPECTION', 'CORRECTIVE']).default('CORRECTIVE'),
  customerId: z.string().min(1, 'Which customer?'),
  siteId: z.string().optional().nullable(),
  assetId: z.string().optional().nullable(),
  contractId: z.string().optional().nullable(),
  dueDate: z.string().min(1, 'When?'),
  assignedToId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const visitLink = (id: string) => `/g-ops/visits?visit=${id}`;

/** An unscheduled call — a breakdown does not appear on a PM schedule. */
visitRoutes.post(
  '/',
  require_('gops.pm_reports.create'),
  handler(async (req, res) => {
    const body = parseBody(visitSchema, req.body);
    const visit = await prisma.$transaction(async (tx) =>
      tx.serviceVisit.create({
        data: {
          number: await nextNumber('service_visit', tx),
          kind: body.kind,
          customerId: body.customerId,
          siteId: body.siteId || null,
          assetId: body.assetId || null,
          contractId: body.contractId || null,
          dueDate: asDate(body.dueDate, 'Due date'),
          assignedToId: body.assignedToId || null,
          notes: body.notes || null,
        },
        include: visitInclude,
      }),
    );

    if (visit.assignedToId) {
      await notify({
        userId: visit.assignedToId,
        type: 'pm.due',
        title: `${KIND_LABEL[visit.kind]} visit assigned`,
        body: `${visit.customer.name} — due ${isoDay(visit.dueDate)}`,
        link: visitLink(visit.id),
      });
    }

    await audit(
      {
        entityType: 'service_visit',
        entityId: visit.id,
        action: 'CREATED',
        summary: `${visit.number} — ${KIND_LABEL[visit.kind]} at ${visit.customer.name}`,
      },
      req,
    );
    res.status(201).json(presentVisit(visit, dayKey(new Date())));
  }),
);

/**
 * Rescheduling, assigning, cancelling. A visit is never marked COMPLETED here
 * — it completes only when its report is approved (Phase 8 rule) — and a
 * cancellation carries a written reason, appended to the visit's notes.
 */
visitRoutes.patch(
  '/:id',
  require_('gops.pm_reports.create'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        dueDate: z.string().optional(),
        assignedToId: z.string().optional().nullable(),
        status: z.enum(['SCHEDULED', 'CANCELLED']).optional(),
        notes: z.string().optional().nullable(),
        /** Required when cancelling. */
        reason: z.string().trim().optional(),
      }),
      req.body,
    );
    const visit = await prisma.serviceVisit.findUnique({ where: { id: req.params.id } });
    if (!visit) throw notFound('Visit not found');
    if (visit.status === 'COMPLETED') {
      throw badRequest('This visit has been made and reported. Its record is what happened.');
    }

    const cancelling = body.status === 'CANCELLED' && visit.status !== 'CANCELLED';
    if (cancelling && (!body.reason || body.reason.length < 3)) {
      throw badRequest('Say why the visit is cancelled — a cancelled visit with no reason is all an audit would have to go on.');
    }
    const baseNotes = body.notes !== undefined ? body.notes || null : visit.notes;
    const notes = cancelling
      ? [baseNotes, `Cancelled ${isoDay(new Date())}: ${body.reason}`].filter(Boolean).join('\n')
      : baseNotes;

    const updated = await prisma.serviceVisit.update({
      where: { id: visit.id },
      data: {
        ...(body.dueDate ? { dueDate: asDate(body.dueDate, 'Due date') } : {}),
        ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId || null } : {}),
        ...(body.status ? { status: body.status } : {}),
        notes,
      },
      include: visitInclude,
    });

    if (body.assignedToId && body.assignedToId !== visit.assignedToId) {
      await notify({
        userId: body.assignedToId,
        type: 'pm.due',
        title: `${KIND_LABEL[updated.kind]} visit assigned`,
        body: `${updated.customer.name} — due ${isoDay(updated.dueDate)}`,
        link: visitLink(updated.id),
      });
    }

    const changes = [
      body.dueDate && isoDay(visit.dueDate) !== isoDay(updated.dueDate)
        ? `due ${isoDay(visit.dueDate)} → ${isoDay(updated.dueDate)}`
        : null,
      body.assignedToId !== undefined && body.assignedToId !== visit.assignedToId
        ? `engineer ${updated.assignedTo?.name ?? 'unassigned'}`
        : null,
      body.status && body.status !== visit.status ? `status ${visit.status} → ${body.status}` : null,
    ].filter(Boolean);
    await audit(
      {
        entityType: 'service_visit',
        entityId: updated.id,
        action: cancelling ? 'CANCELLED' : 'UPDATED',
        summary: `${updated.number}${changes.length ? ` — ${changes.join(', ')}` : ' updated'}${cancelling ? ` (${body.reason})` : ''}`,
        before: visit,
        after: { ...updated, customer: undefined, contract: undefined, site: undefined, asset: undefined },
      },
      req,
    );
    res.json(presentVisit(updated, dayKey(new Date())));
  }),
);

// ════════════════════════════════════════════════════════════════════
//  REPORT TEMPLATES
// ════════════════════════════════════════════════════════════════════

export const templateRoutes = Router();
templateRoutes.use(authenticate);

templateRoutes.get(
  '/',
  requireAny(
    'gops.pm_reports.view_all',
    'gops.commissioning_reports.view_all',
    'gops.inspection_reports.view_all',
  ),
  handler(async (req, res) => {
    const kind = asEnum(ServiceKind, req.query.kind ? String(req.query.kind) : undefined);
    const all = req.query.all === 'true';
    const templates = await prisma.reportTemplate.findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(all ? {} : { isCurrent: true, isActive: true }),
      },
      include: {
        createdBy: { select: { id: true, name: true } },
        _count: { select: { reports: true } },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'desc' }],
    });
    res.json(templates);
  }),
);

templateRoutes.get(
  '/:id',
  requireAny(
    'gops.pm_reports.view_all',
    'gops.commissioning_reports.view_all',
    'gops.inspection_reports.view_all',
  ),
  handler(async (req, res) => {
    const template = await prisma.reportTemplate.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { reports: true } } },
    });
    if (!template) throw notFound('Template not found');
    res.json(template);
  }),
);

const templateSchema = z.object({
  kind: z.enum(['COMMISSIONING', 'PREVENTIVE_MAINTENANCE', 'INSPECTION', 'CORRECTIVE']),
  name: z.string().trim().min(2, 'Give the template a name'),
  description: z.string().optional().nullable(),
  sections: z.array(z.unknown()),
});

templateRoutes.post(
  '/',
  require_('gops.pm_reports.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(templateSchema, req.body);
    const sections = validateSections(body.sections);

    const key = `${body.kind.toLowerCase()}-${Date.now().toString(36)}`;
    const template = await prisma.reportTemplate.create({
      data: {
        key,
        version: 1,
        kind: body.kind,
        name: body.name,
        description: body.description || null,
        sections: sections as unknown as Prisma.InputJsonValue,
        createdById: me.id,
      },
    });

    await audit(
      {
        entityType: 'report_template',
        entityId: template.id,
        action: 'CREATED',
        summary: `Template "${template.name}" created`,
      },
      req,
    );
    res.status(201).json(template);
  }),
);

/**
 * Editing a template.
 *
 * A template that has never been used is edited in place. One that reports
 * have been written against is IMMUTABLE — the edit publishes a new version
 * under the same key, and the old version stays exactly as it was. That is
 * what lets a report from two years ago still render the way it was signed
 * (model §4.5).
 */
templateRoutes.put(
  '/:id',
  require_('gops.pm_reports.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(templateSchema.partial({ kind: true }), req.body);
    const existing = await prisma.reportTemplate.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { reports: true } } },
    });
    if (!existing) throw notFound('Template not found');

    const sections = body.sections ? validateSections(body.sections) : (existing.sections as unknown as TemplateSection[]);

    if (existing._count.reports === 0) {
      const updated = await prisma.reportTemplate.update({
        where: { id: existing.id },
        data: {
          name: body.name ?? existing.name,
          description: body.description !== undefined ? body.description || null : existing.description,
          sections: sections as unknown as Prisma.InputJsonValue,
        },
      });
      res.json({ ...updated, newVersion: false });
      return;
    }

    const published = await prisma.$transaction(async (tx) => {
      await tx.reportTemplate.update({ where: { id: existing.id }, data: { isCurrent: false } });
      return tx.reportTemplate.create({
        data: {
          key: existing.key,
          version: existing.version + 1,
          kind: existing.kind,
          name: body.name ?? existing.name,
          description: body.description !== undefined ? body.description || null : existing.description,
          sections: sections as unknown as Prisma.InputJsonValue,
          createdById: me.id,
        },
      });
    });

    await audit(
      {
        entityType: 'report_template',
        entityId: published.id,
        action: 'CREATED',
        summary: `Template "${published.name}" v${published.version} published — v${existing.version} is used by ${existing._count.reports} report(s) and is unchanged`,
      },
      req,
    );
    res.status(201).json({ ...published, newVersion: true });
  }),
);

/** Copying a template to start a new one — "duplicate and save as new". */
templateRoutes.post(
  '/:id/duplicate',
  require_('gops.pm_reports.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(z.object({ name: z.string().trim().min(2) }), req.body);
    const source = await prisma.reportTemplate.findUnique({ where: { id: req.params.id } });
    if (!source) throw notFound('Template not found');

    const copy = await prisma.reportTemplate.create({
      data: {
        key: `${source.kind.toLowerCase()}-${Date.now().toString(36)}`,
        version: 1,
        kind: source.kind,
        name: body.name,
        description: source.description,
        sections: source.sections as Prisma.InputJsonValue,
        createdById: me.id,
      },
    });
    res.status(201).json(copy);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  SERVICE REPORTS
// ════════════════════════════════════════════════════════════════════

export const serviceReportRoutes = Router();
serviceReportRoutes.use(authenticate);

const reportInclude = {
  customer: { select: { id: true, code: true, name: true } },
  site: { select: { id: true, name: true, city: true } },
  asset: {
    select: { id: true, code: true, name: true, serialNo: true, model: true, warrantyEndsAt: true },
  },
  contract: { select: { id: true, number: true, endsAt: true } },
  job: { select: { id: true, number: true, name: true } },
  visit: {
    select: {
      id: true,
      number: true,
      dueDate: true,
      sequence: true,
      jobOrder: { select: { id: true, number: true, status: true } },
    },
  },
  template: { select: { id: true, key: true, name: true, version: true, sections: true } },
  performedBy: { select: { id: true, name: true } },
} satisfies Prisma.ServiceReportInclude;

serviceReportRoutes.get(
  '/',
  requireAny(
    'gops.pm_reports.view_all',
    'gops.pm_reports.view_own',
    'gops.commissioning_reports.view_all',
    'gops.commissioning_reports.view_own',
    'gops.inspection_reports.view_all',
    'gops.inspection_reports.view_own',
  ),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where: Prisma.ServiceReportWhereInput = {};

    const kind = asEnum(ServiceKind, q.filters.kind);
    if (kind) where.kind = kind;
    const status = asEnum(ReportStatus, q.filters.status);
    if (status) where.status = status;
    if (q.filters.assetId) where.assetId = q.filters.assetId;
    if (q.filters.contractId) where.contractId = q.filters.contractId;
    if (q.filters.customerId) where.customerId = q.filters.customerId;
    if (q.filters.billable) where.billable = q.filters.billable === 'true';

    // A service engineer with only view_own sees the reports they wrote.
    const canSeeAll =
      me.isSuperAdmin ||
      me.permissions.has('gops.pm_reports.view_all') ||
      me.permissions.has('gops.commissioning_reports.view_all') ||
      me.permissions.has('gops.inspection_reports.view_all');
    if (!canSeeAll || q.scope === 'mine') where.performedById = me.id;

    if (q.search) {
      where.OR = [
        { number: { contains: q.search, mode: 'insensitive' } },
        { findings: { contains: q.search, mode: 'insensitive' } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { asset: { serialNo: { contains: q.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.serviceReport.findMany({
        where,
        include: { ...reportInclude, template: { select: { id: true, name: true, version: true } } },
        orderBy: orderBy(q, ['number', 'performedAt', 'createdAt'], { performedAt: 'desc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.serviceReport.count({ where }),
    ]);

    res.json(listResult(rows, total, q));
  }),
);

serviceReportRoutes.get(
  '/:id',
  requireAny(
    'gops.pm_reports.view_all',
    'gops.pm_reports.view_own',
    'gops.commissioning_reports.view_all',
    'gops.commissioning_reports.view_own',
    'gops.inspection_reports.view_all',
    'gops.inspection_reports.view_own',
  ),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.serviceReport.findUnique({
      where: { id: req.params.id },
      include: reportInclude,
    });
    if (!row) throw notFound('Report not found');

    if (
      row.performedById !== me.id &&
      !me.isSuperAdmin &&
      !me.permissions.has(reportPermission(row.kind, 'view_all'))
    ) {
      throw forbidden('That is someone else’s report');
    }

    // Section photos are filed as `<report id>~<section key>`, the rest under
    // the report id itself — one prefix finds all of them.
    const photos = await prisma.attachment.findMany({
      where: { entityType: 'service_report', entityId: { startsWith: row.id } },
      select: { id: true, fileName: true, caption: true, capturedAt: true, mimeType: true },
      orderBy: { uploadedAt: 'asc' },
    });

    res.json({ ...row, photos });
  }),
);

const reportSchema = z.object({
  /** Defaults to the visit's kind when written against a visit. */
  kind: z.enum(['COMMISSIONING', 'PREVENTIVE_MAINTENANCE', 'INSPECTION', 'CORRECTIVE']).optional(),
  templateId: z.string().optional(),
  visitId: z.string().optional().nullable(),
  contractId: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  /** Taken from the visit when written against one. */
  customerId: z.string().optional(),
  siteId: z.string().optional().nullable(),
  assetId: z.string().optional().nullable(),
  performedAt: z.string().optional(),
  data: z.record(z.unknown()).default({}),
  findings: z.string().optional().nullable(),
  recommendations: z.string().optional().nullable(),
  billable: z.boolean().optional(),
});

serviceReportRoutes.post(
  '/',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(reportSchema, req.body);

    /*
      Written against a visit, the report takes the visit's facts: customer,
      site, machine, contract and the job that carries the cost. The form used
      to send only the visit id, so a contract PM was saved with no contract —
      and therefore defaulted to billable. The server fills them now, whatever
      the client sends; a body that names a different customer is refused
      rather than silently overridden.
    */
    const visit = body.visitId
      ? await prisma.serviceVisit.findUnique({
          where: { id: body.visitId },
          select: {
            id: true,
            kind: true,
            status: true,
            customerId: true,
            siteId: true,
            assetId: true,
            contractId: true,
            contract: { select: { jobId: true } },
            jobOrder: { select: { jobId: true, chargeBasis: true } },
            report: { select: { number: true } },
          },
        })
      : null;
    if (body.visitId) {
      if (!visit) throw notFound('Visit not found');
      if (visit.report) throw badRequest(`This visit already has report ${visit.report.number}`);
      if (visit.status === 'CANCELLED') {
        throw badRequest('This visit was cancelled. Reinstate it on the schedule before reporting against it.');
      }
      if (body.customerId && body.customerId !== visit.customerId) {
        throw badRequest(
          'That visit is booked at a different customer — a report is written for the customer the visit is at.',
        );
      }
    }

    const kind = body.kind ?? visit?.kind;
    if (!kind) throw badRequest('What kind of report is this?');
    const customerId = body.customerId || visit?.customerId;
    if (!customerId) throw badRequest('Which customer?');
    const siteId = body.siteId || visit?.siteId || null;
    const assetId = body.assetId || visit?.assetId || null;
    const contractId = body.contractId || visit?.contractId || null;
    const jobId = body.jobId || visit?.contract?.jobId || visit?.jobOrder?.jobId || null;

    if (!me.isSuperAdmin && !me.permissions.has(reportPermission(kind, 'create'))) {
      throw forbidden(`You need "${reportPermission(kind, 'create')}" to write this report`);
    }

    const template = body.templateId
      ? await prisma.reportTemplate.findUnique({ where: { id: body.templateId } })
      : await currentTemplate(kind);
    if (!template) {
      throw badRequest(
        `No ${KIND_LABEL[kind].toLowerCase()} template exists yet. Set one up in Report Templates first — the form is data, not code.`,
      );
    }

    // Warranty is decided from the asset at the time the work was done, not
    // from whoever ticks the box: "was it covered" is a fact, not an opinion.
    let underWarranty = false;
    const performedAt = body.performedAt ? asDate(body.performedAt, 'Performed on') : dayKey(new Date());
    if (assetId) {
      const asset = await prisma.installedAsset.findUnique({ where: { id: assetId } });
      if (!asset) throw notFound('Asset not found');
      underWarranty = !!asset.warrantyEndsAt && asset.warrantyEndsAt >= performedAt;
    }

    // A visit a job order scheduled was already decided on: the service
    // manager approved its charge basis. Anything else follows the facts — a
    // visit inside a contract or a warranty is covered work, and the rest
    // defaults to billable, because forgetting to charge is the expensive
    // mistake.
    const billable =
      body.billable ??
      (visit?.jobOrder ? visit.jobOrder.chargeBasis === 'CHARGEABLE' : !(underWarranty || !!contractId));

    const report = await prisma.$transaction(async (tx) => {
      const number = await nextNumber(REPORT_DOC_TYPE[kind], tx);
      return tx.serviceReport.create({
        data: {
          number,
          kind,
          visitId: visit?.id ?? null,
          contractId,
          jobId,
          customerId,
          siteId,
          assetId,
          templateId: template.id,
          performedAt,
          performedById: me.id,
          data: body.data as Prisma.InputJsonValue,
          findings: body.findings || null,
          recommendations: body.recommendations || null,
          billable,
          underWarranty,
        },
        include: reportInclude,
      });
    });

    await audit(
      {
        entityType: 'service_report',
        entityId: report.id,
        action: 'CREATED',
        summary: `${report.number} — ${KIND_LABEL[report.kind]} at ${report.customer.name}`,
      },
      req,
    );
    res.status(201).json(report);
  }),
);

serviceReportRoutes.patch(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(
      reportSchema.omit({ kind: true, customerId: true }).partial().extend({
        customerSignedBy: z.string().optional().nullable(),
      }),
      req.body,
    );
    const report = await prisma.serviceReport.findUnique({ where: { id: req.params.id } });
    if (!report) throw notFound('Report not found');
    // A RETURNED report is corrected and sent again, like every other
    // document. It used to be frozen, which left its visit holding a dead
    // report forever: a visit takes exactly one report, so nothing else could
    // ever be written against it and the visit could never complete.
    if (report.status !== 'DRAFT' && report.status !== 'REJECTED') {
      throw badRequest('This report has been submitted. Its content is what was signed.');
    }
    if (report.performedById !== me.id && !me.isSuperAdmin && !me.permissions.has(reportPermission(report.kind, 'edit_all'))) {
      throw forbidden('That is someone else’s report');
    }

    const updated = await prisma.serviceReport.update({
      where: { id: report.id },
      data: {
        ...(body.data !== undefined ? { data: body.data as Prisma.InputJsonValue } : {}),
        ...(body.findings !== undefined ? { findings: body.findings || null } : {}),
        ...(body.recommendations !== undefined ? { recommendations: body.recommendations || null } : {}),
        ...(body.billable !== undefined ? { billable: body.billable } : {}),
        ...(body.assetId !== undefined ? { assetId: body.assetId || null } : {}),
        ...(body.performedAt ? { performedAt: asDate(body.performedAt, 'Performed on') } : {}),
        ...(body.customerSignedBy !== undefined
          ? {
              customerSignedBy: body.customerSignedBy || null,
              customerSignedAt: body.customerSignedBy ? new Date() : null,
            }
          : {}),
      },
      include: reportInclude,
    });
    res.json(updated);
  }),
);

serviceReportRoutes.post(
  '/:id/submit',
  handler(async (req, res) => {
    const me = currentUser(req);
    const report = await prisma.serviceReport.findUnique({
      where: { id: req.params.id },
      include: { template: true, customer: true, asset: true },
    });
    if (!report) throw notFound('Report not found');
    if (report.status !== 'DRAFT' && report.status !== 'REJECTED') {
      throw badRequest('This report has already been submitted');
    }
    if (report.performedById !== me.id && !me.isSuperAdmin) {
      throw forbidden('That is someone else’s report');
    }

    // Checked here rather than on every keystroke: a report is written on site,
    // often on bad signal, and a form that refuses to save half-finished work
    // gets filled in afterwards from memory instead.
    const sections = report.template.sections as unknown as TemplateSection[];
    const missing = missingRequired(sections, report.data as Record<string, unknown>);
    if (missing.length) {
      throw badRequest(
        `${missing.length} required field${missing.length === 1 ? '' : 's'} not filled in: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? '…' : ''}`,
      );
    }
    if (!report.customerSignedBy) {
      throw badRequest(
        'Nobody has signed for this on site. A service report the customer has not acknowledged is an assertion, not a record.',
      );
    }

    await prisma.serviceReport.update({
      where: { id: report.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await submitForApproval({
      documentType: REPORT_DOC_TYPE[report.kind],
      documentId: report.id,
      documentNumber: report.number,
      subject: `${KIND_LABEL[report.kind]} — ${report.customer.name}${report.asset ? ` — ${report.asset.name}` : ''}`,
      link: `/g-ops/service-reports/${report.id}`,
      requesterId: me.id,
    });

    res.json({ ok: true });
  }),
);

/**
 * An approved report closes its visit.
 *
 * Registered once per document type because they are three separate document
 * types in the approval engine, with three separate workflows — a
 * commissioning report is signed off by different people than a routine PM.
 */
function onReportSettled(documentType: string) {
  onApprovalSettled(documentType, async (approval, outcome) => {
    const report = await prisma.serviceReport.findUnique({
      where: { id: approval.documentId },
      include: { visit: true, customer: true, asset: true },
    });
    if (!report) return;

    if (outcome !== 'APPROVED') {
      await prisma.serviceReport.update({ where: { id: report.id }, data: { status: 'REJECTED' } });
      await audit({
        entityType: 'service_report',
        entityId: report.id,
        action: 'REJECTED',
        summary: `${report.number} returned — the visit stays open`,
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.serviceReport.update({
        where: { id: report.id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });
      // The visit is only complete once its report has been approved. Marking
      // it done when the engineer left site would count a visit nobody has
      // checked.
      if (report.visitId) {
        await tx.serviceVisit.update({
          where: { id: report.visitId },
          data: { status: 'COMPLETED', performedAt: report.performedAt },
        });
      }
      // The job order that scheduled this visit is complete on the same
      // evidence — the approved report — and on the date the work was done.
      // Only an APPROVED order moves: a cancelled one stays cancelled.
      if (report.visit?.jobOrderId) {
        await tx.jobOrder.updateMany({
          where: { id: report.visit.jobOrderId, status: 'APPROVED' },
          data: { status: 'COMPLETED', completedAt: report.performedAt },
        });
      }
      // A commissioning report is the moment a warranty starts running.
      if (report.kind === 'COMMISSIONING' && report.assetId && report.asset && !report.asset.commissionedAt) {
        const settings = await aftermarketSettings();
        await tx.installedAsset.update({
          where: { id: report.assetId },
          data: {
            commissionedAt: report.performedAt,
            warrantyEndsAt:
              report.asset.warrantyEndsAt ??
              addMonths(report.performedAt, settings.defaultWarrantyMonths),
          },
        });
      }
    });

    await audit({
      entityType: 'service_report',
      entityId: report.id,
      action: 'APPROVED',
      summary: report.visitId
        ? `${report.number} approved — visit closed`
        : `${report.number} approved`,
    });
    if (report.visit?.jobOrderId) {
      await audit({
        entityType: 'job_order',
        entityId: report.visit.jobOrderId,
        action: 'COMPLETED',
        summary: `Completed by ${report.number}, performed ${isoDay(report.performedAt)}`,
      });
    }
  });
}

onReportSettled('commissioning_report');
onReportSettled('pm_report');
onReportSettled('inspection_report');

// ════════════════════════════════════════════════════════════════════
//  AFTERMARKET DASHBOARD, RENEWALS AND SETTINGS
// ════════════════════════════════════════════════════════════════════

export const aftermarketRoutes = Router();
aftermarketRoutes.use(authenticate);

aftermarketRoutes.get(
  '/dashboard',
  requireAny('gops.service_contracts.view_all', 'gops.installed_base.view_all'),
  handler(async (_req, res) => {
    await sweepOverdue();
    const settings = await aftermarketSettings();
    const today = dayKey(new Date());
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + settings.expiryWarningDays);
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));

    const [
      assets,
      inWarranty,
      warrantyExpiring,
      uncovered,
      activeContracts,
      contractsExpiring,
      visitsDue,
      visitsThisMonth,
      visitsMissed,
      reportsPending,
    ] = await Promise.all([
      prisma.installedAsset.count({ where: { status: 'ACTIVE' } }),
      prisma.installedAsset.count({ where: { status: 'ACTIVE', warrantyEndsAt: { gte: today } } }),
      prisma.installedAsset.count({
        where: { status: 'ACTIVE', warrantyEndsAt: { gte: today, lte: horizon } },
      }),
      prisma.installedAsset.count({
        where: { status: 'ACTIVE', contracts: { none: { contract: { status: 'ACTIVE' } } } },
      }),
      prisma.serviceContract.count({ where: { status: 'ACTIVE' } }),
      prisma.serviceContract.count({ where: { status: 'ACTIVE', endsAt: { lte: horizon } } }),
      prisma.serviceVisit.count({ where: { status: 'SCHEDULED', dueDate: { lte: today } } }),
      prisma.serviceVisit.count({
        where: { status: 'SCHEDULED', dueDate: { gt: today, lte: monthEnd } },
      }),
      prisma.serviceVisit.count({ where: { status: 'MISSED' } }),
      prisma.serviceReport.count({ where: { status: 'PENDING_APPROVAL' } }),
    ]);

    res.json({
      asOf: today,
      installedBase: {
        total: assets,
        inWarranty,
        warrantyExpiring,
        outOfWarranty: assets - inWarranty,
        uncovered,
      },
      contracts: { active: activeContracts, expiring: contractsExpiring },
      visits: { overdue: visitsDue, thisMonth: visitsThisMonth, missed: visitsMissed },
      reportsPending,
      warningDays: settings.expiryWarningDays,
    });
  }),
);

/** What is about to run out, and is therefore worth a phone call. */
aftermarketRoutes.get(
  '/renewals',
  requireAny('gops.service_contracts.view_all', 'gops.installed_base.view_all'),
  handler(async (req, res) => {
    const settings = await aftermarketSettings();
    const withinDays = Math.min(
      730,
      Math.max(1, Number(req.query.withinDays ?? settings.expiryWarningDays)),
    );
    const rows = await renewalPipeline(withinDays);
    res.json({
      withinDays,
      rows,
      contractValue: rows
        .filter((r) => r.kind === 'CONTRACT')
        .reduce((s, r) => s + (r.value ?? 0), 0),
      counts: {
        contracts: rows.filter((r) => r.kind === 'CONTRACT').length,
        warranties: rows.filter((r) => r.kind === 'WARRANTY').length,
        alreadyLapsed: rows.filter((r) => r.daysRemaining < 0).length,
      },
    });
  }),
);

aftermarketRoutes.get(
  '/settings',
  requireAny('gops.service_contracts.view_all', 'gops.installed_base.view_all'),
  handler(async (_req, res) => {
    res.json(await aftermarketSettings());
  }),
);

aftermarketRoutes.put(
  '/settings',
  require_('gops.service_contracts.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        expiryWarningDays: z.number().int().min(1).max(365).optional(),
        defaultWarrantyMonths: z.number().int().min(0).max(240).optional(),
        defaultFrequencyMonths: z.number().int().min(1).max(24).optional(),
        missedAfterDays: z.number().int().min(0).max(180).optional(),
      }),
      req.body,
    );
    const saved = await saveAftermarketSettings(body);
    await audit(
      {
        entityType: 'setting',
        entityId: 'aftermarket.rules',
        action: 'UPDATED',
        summary: 'Updated aftermarket rules',
      },
      req,
    );
    res.json(saved);
  }),
);

// ════════════════════════════════════════════════════════════════════
//  CTRL+K AND MY WORK
// ════════════════════════════════════════════════════════════════════
//
// Registered from this module, as every other module does, so search never
// has to know what a visit is. Numbers and names only in every select.

registerSearch({
  kind: 'installed_asset',
  label: 'Installed base',
  permission: 'gops.installed_base.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.installedAsset.findMany({
      where: {
        OR: [
          { code: { contains: term, mode: 'insensitive' } },
          { name: { contains: term, mode: 'insensitive' } },
          { serialNo: { contains: term, mode: 'insensitive' } },
          { model: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, name: true, serialNo: true, customer: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: 'installed_asset',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.serialNo ? `S/N ${r.serialNo}` : null, r.customer.name].filter(Boolean).join(' · '),
      link: `/g-ops/installed-base/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'service_contract',
  label: 'Service contracts',
  permission: ['gops.service_contracts.view_all', 'gops.service_contracts.view_own'],
  // The contract's owner is its job's project manager — the list's own rule.
  ownWhere: (user) => ({ job: { projectManagerId: user.id } }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.serviceContract.findMany({
      where: {
        ...(own ?? {}),
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { job: { name: { contains: term, mode: 'insensitive' } } },
          { job: { customer: { name: { contains: term, mode: 'insensitive' } } } },
        ],
      },
      take: limit,
      orderBy: { endsAt: 'desc' },
      select: { id: true, number: true, status: true, job: { select: { name: true, customer: { select: { name: true } } } } },
    });
    return rows.map((r) => ({
      kind: 'service_contract',
      id: r.id,
      title: `${r.number} — ${r.job.name}`,
      subtitle: `${r.job.customer.name} · ${r.status.toLowerCase()}`,
      link: `/g-ops/service-contracts/${r.id}`,
    }));
  },
});

/** One provider per report permission: a PM report is not an inspection. */
function registerReportSearch(module: string, label: string, kinds: ServiceKind[]) {
  // One kind for all three, so Ctrl+K shows a single "Service reports" group;
  // what differs is only the permission that admits each provider.
  registerSearch({
    kind: 'service_report',
    label,
    permission: [`gops.${module}.view_all`, `gops.${module}.view_own`],
    ownWhere: (user) => ({ performedById: user.id }),
    search: async (term, _user, limit, own) => {
      const rows = await prisma.serviceReport.findMany({
        where: {
          ...(own ?? {}),
          kind: { in: kinds },
          OR: [
            { number: { contains: term, mode: 'insensitive' } },
            { customer: { name: { contains: term, mode: 'insensitive' } } },
            { asset: { serialNo: { contains: term, mode: 'insensitive' } } },
          ],
        },
        take: limit,
        orderBy: { performedAt: 'desc' },
        select: {
          id: true,
          number: true,
          kind: true,
          status: true,
          customer: { select: { name: true } },
          asset: { select: { name: true } },
        },
      });
      return rows.map((r) => ({
        kind: 'service_report',
        id: r.id,
        title: `${r.number} — ${r.customer.name}`,
        subtitle: [KIND_LABEL[r.kind], r.asset?.name, r.status.toLowerCase().replace(/_/g, ' ')].filter(Boolean).join(' · '),
        link: `/g-ops/service-reports/${r.id}`,
      }));
    },
  });
}

registerReportSearch('commissioning_reports', 'Commissioning reports', ['COMMISSIONING']);
registerReportSearch('pm_reports', 'PM reports', ['PREVENTIVE_MAINTENANCE']);
registerReportSearch('inspection_reports', 'Inspection reports', ['INSPECTION', 'CORRECTIVE']);

registerSearch({
  kind: 'service_visit',
  label: 'Service visits',
  permission: 'gops.visits.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.serviceVisit.findMany({
      where: {
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } },
          { asset: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { dueDate: 'desc' },
      select: { id: true, number: true, kind: true, status: true, dueDate: true, customer: { select: { name: true } } },
    });
    return rows.map((r) => ({
      kind: 'service_visit',
      id: r.id,
      title: `${r.number} — ${r.customer.name}`,
      subtitle: `${KIND_LABEL[r.kind]} · due ${isoDay(r.dueDate)} · ${r.status.toLowerCase()}`,
      link: visitLink(r.id),
    }));
  },
});

/**
 * Today's schedule: the visits booked on me that fall inside the window My
 * Work asks for. A visit's due date is a calendar day stored as UTC midnight,
 * so the database is asked for a padded range and the window is applied here
 * on the timestamp — comparing a DATE column against a timestamp would
 * truncate the window's edges and shift the day for anyone east of UTC.
 */
registerSchedule(async (user, window) => {
  const pad = 86_400_000;
  const rows = await prisma.serviceVisit.findMany({
    where: {
      assignedToId: user.id,
      status: 'SCHEDULED',
      dueDate: { gte: new Date(window.from.getTime() - pad), lte: new Date(window.to.getTime() + pad) },
    },
    orderBy: { dueDate: 'asc' },
    select: {
      id: true,
      number: true,
      kind: true,
      dueDate: true,
      customer: { select: { name: true } },
      site: { select: { name: true } },
      asset: { select: { name: true } },
    },
  });
  return rows
    .filter((v) => v.dueDate >= window.from && v.dueDate < window.to)
    .map((v) => ({
      kind: 'visit',
      id: v.id,
      title: `${KIND_LABEL[v.kind]} — ${v.customer.name}`,
      startsAt: v.dueDate,
      endsAt: new Date(v.dueDate.getTime() + pad),
      link: visitLink(v.id),
      meetLink: null,
      sub: [v.number, v.asset?.name ?? v.site?.name].filter(Boolean).join(' · '),
    }));
});
