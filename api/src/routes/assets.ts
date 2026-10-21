import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, conflict, forbidden, idsFilter, deleteOrRefuse } from '../http/kit';
import { deleteAttachmentsOf, registerAttachmentGuard } from '../shared/attachments';
import { authenticate, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { requireView, requireEdit, ownOnly, assertCanView, assertCanEdit, viewScope } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { renderDocument, formatDate, formatShortDate, formatMoney, companyCurrency, statusLabel, type Signatory } from '../shared/pdf';
import { contactOf } from '../shared/approvals';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { registerSearch } from '../shared/search';
import { manilaDate } from '../shared/day';
import { LIST_CAP, listReference, sendListPdf, choice } from '../shared/listPaper';
import { assetState, leavingEmployees, type AssetState } from '../shared/assets';

/**
 * G-HR › Records › Asset Management (2026-10-21, the owner's Asset
 * Management tab, beside the Plantilla): the company's TAGGED property —
 * vehicles, laptops, tools, kits — and who holds each. An asset is one unit
 * with a G-CORE tag (`company_asset`, GT-AST-2026-0001); its issuances are
 * the history, at most one open. An open issuance is an ADMIN item on its
 * holder's clearance (`scanAccountabilities`), cleared only by the return.
 * RETURN_PENDING is derived: an issued asset whose holder is leaving.
 *
 * `ghr.assets` (SHARED_KEPT): own is the assets one added AND the ones issued
 * to one; Edit issues, takes back and retires; the cost is Edit All's.
 */

export const assetRoutes = Router();
assetRoutes.use(authenticate);

const DOC = 'company_asset';
const PATH = '/g-hr/assets';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (key: string) => new Date(`${key}T00:00:00Z`);

const personSelect = {
  id: true,
  userId: true,
  employeeNo: true,
  firstName: true,
  lastName: true,
  position: true,
  isActive: true,
  industry: { select: { code: true } },
} satisfies Prisma.EmployeeSelect;

const openIssuance = {
  where: { returnedOn: null },
  take: 1,
  include: { employee: { select: personSelect }, issuedBy: { select: { id: true, name: true } } },
} satisfies Prisma.CompanyAsset$issuancesArgs;

const include = {
  assetType: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  issuances: openIssuance,
} satisfies Prisma.CompanyAssetInclude;

type Row = Prisma.CompanyAssetGetPayload<{ include: typeof include }>;
type Person = Prisma.EmployeeGetPayload<{ select: typeof personSelect }>;

const nameOf = (p: Pick<Person, 'firstName' | 'lastName'>) => `${p.firstName} ${p.lastName}`.trim();
const detailsOf = (r: Pick<Row, 'serialNo' | 'plateNo'>) => [r.serialNo ? `SN: ${r.serialNo}` : null, r.plateNo ? `Plate: ${r.plateNo}` : null].filter(Boolean).join(' | ');

/** Whose: one added it, or it is issued to them now. */
function isMine(me: ResolvedUser, r: Row): boolean {
  return r.createdById === me.id || r.issuances[0]?.employee.userId === me.id;
}

const seesCost = (me: ResolvedUser) => can(me, 'ghr.assets.edit_all');

async function present(me: ResolvedUser, rows: Row[]) {
  const leaving = await leavingEmployees(rows.map((r) => r.issuances[0]?.employee.id).filter((x): x is string => !!x));
  const cost = seesCost(me);
  return rows.map((r) => {
    const open = r.issuances[0] ?? null;
    const away = open ? leaving.get(open.employee.id) : undefined;
    const state = assetState(r.status, open ? { leaving: !!away } : null);
    const { issuances: _i, cost: rawCost, ...rest } = r;
    return {
      ...rest,
      cost: cost && rawCost != null ? Number(rawCost) : null,
      state,
      details: detailsOf(r),
      holder: open
        ? {
            issuanceId: open.id,
            employeeId: open.employee.id,
            name: nameOf(open.employee),
            employeeNo: open.employee.employeeNo,
            title: open.employee.position,
            team: open.employee.industry?.code ?? null,
            issuedOn: open.issuedOn,
            conditionOut: open.conditionOut,
            remarks: open.remarks,
            issuedBy: open.issuedBy,
          }
        : null,
      // The PDF's red remark: a holder leaving owes the asset back before their clearance closes.
      returnNotice: state === 'RETURN_PENDING' && away ? `Leaving${away.since ? ` — last day ${formatDate(away.since)}` : ''}. Return required before the exit clearance.` : null,
      canEdit: canEditRecord(me, 'ghr', 'assets', r.createdById),
    };
  });
}

async function load(id: string): Promise<Row> {
  const row = await prisma.companyAsset.findUnique({ where: { id }, include });
  if (!row) throw notFound('Asset not found');
  return row;
}

const STATES = ['AVAILABLE', 'ISSUED', 'RETURN_PENDING', 'UNDER_REPAIR', 'RETIRED'] as const;

/** Who is leaving, as a where on an employee: a live clearance or a separation date. */
const LEAVING: Prisma.EmployeeWhereInput = { OR: [{ dateSeparated: { not: null } }, { clearances: { some: { status: { not: 'CANCELLED' } } } }] };

/** One rule for the rows, the cards and the paper. */
function listWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>): { base: Prisma.CompanyAssetWhereInput; where: Prisma.CompanyAssetWhereInput } {
  const and: Prisma.CompanyAssetWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    const t = { contains: q.search, mode: 'insensitive' as const };
    and.push({
      OR: [
        { tag: t },
        { brandModel: t },
        { serialNo: t },
        { plateNo: t },
        { description: t },
        { assetType: { name: t } },
        { issuances: { some: { returnedOn: null, employee: { OR: [{ firstName: t }, { lastName: t }, { employeeNo: t }] } } } },
      ],
    });
  }
  if (q.scope === 'mine') and.push({ OR: [{ createdById: me.id }, { issuances: { some: { returnedOn: null, employee: { userId: me.id } } } }] });
  const base = ownOnly<Prisma.CompanyAssetWhereInput>(me, 'ghr', 'assets', and.length ? { AND: and } : {}, (owners) => ({
    OR: [{ createdById: { in: owners } }, { issuances: { some: { returnedOn: null, employee: { userId: { in: owners } } } } }],
  }));
  const where: Prisma.CompanyAssetWhereInput = { ...base };
  const extra: Prisma.CompanyAssetWhereInput[] = [];
  const state = choice(q.filters.status, STATES, 'Status');
  if (state === 'RETURN_PENDING') extra.push({ status: 'ISSUED', issuances: { some: { returnedOn: null, employee: LEAVING } } });
  else if (state === 'ISSUED') extra.push({ status: 'ISSUED', issuances: { some: { returnedOn: null, employee: { NOT: LEAVING } } } });
  else if (state) extra.push({ status: state });
  // The PDF's two views — every asset, or what is out — as a filter (rule 9: no tab strip).
  const view = choice(q.filters.view, ['issued', 'all'] as const, 'View');
  if (view === 'issued') extra.push({ status: 'ISSUED' });
  if (q.filters.retired !== 'true' && state !== 'RETIRED') extra.push({ status: { not: 'RETIRED' } });
  if (q.filters.assetTypeId) extra.push({ assetTypeId: q.filters.assetTypeId });
  if (q.filters.employeeId) extra.push({ issuances: { some: { returnedOn: null, employeeId: q.filters.employeeId } } });
  if (q.filters.teamId === 'none') extra.push({ status: 'ISSUED', issuances: { some: { returnedOn: null, employee: { industryId: null } } } });
  else if (q.filters.teamId) extra.push({ issuances: { some: { returnedOn: null, employee: { industryId: q.filters.teamId } } } });
  if (extra.length) where.AND = [...(where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : []), ...extra];
  return { base, where };
}

const SORTS = ['tag', 'brandModel', 'status', 'createdAt', 'updatedAt'];

assetRoutes.get(
  '/',
  requireView('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = listWhere(me, q);
    const live: Prisma.CompanyAssetWhereInput = { ...base, status: { not: 'RETIRED' } };
    const [rows, total, all, issued, available, pending] = await Promise.all([
      prisma.companyAsset.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.companyAsset.count({ where }),
      prisma.companyAsset.count({ where: live }),
      prisma.companyAsset.count({ where: { ...base, status: 'ISSUED' } }),
      prisma.companyAsset.count({ where: { ...base, status: 'AVAILABLE' } }),
      prisma.companyAsset.count({ where: { ...base, status: 'ISSUED', issuances: { some: { returnedOn: null, employee: LEAVING } } } }),
    ]);
    res.json({ ...listResult(await present(me, rows), total, q), summary: { total: all, issued, available, returnPending: pending } });
  }),
);

/** The register on paper — the list's own query, or the rows ticked. Above /:id. */
assetRoutes.get(
  '/pdf',
  requireView('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = listWhere(me, q);
    const f = q.filters;
    const [rows, count, type] = await Promise.all([
      prisma.companyAsset.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), take: LIST_CAP }),
      prisma.companyAsset.count({ where }),
      f.assetTypeId ? prisma.assetType.findUnique({ where: { id: f.assetTypeId }, select: { name: true } }) : null,
    ]);
    const shown = await present(me, rows);
    const reference = listReference(count, rows.length, ['asset', 'assets'], [
      q.search ? `search "${q.search}"` : null,
      f.status ? `status ${statusLabel(f.status)}` : null,
      f.view === 'issued' ? 'issued assets' : null,
      type ? `type ${type.name}` : null,
      f.retired === 'true' ? 'retired included' : null,
      q.scope === 'mine' ? 'mine' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Company Assets',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Tag', 'Asset type', 'Brand & model', 'Details', 'Date issued', 'Issued to', 'Status', 'Remarks'],
          rows: shown.map((r) => [
            r.tag,
            r.assetType.name,
            r.brandModel,
            r.details || '—',
            r.holder ? formatShortDate(r.holder.issuedOn) : '—',
            r.holder ? { title: r.holder.name, body: [r.holder.team, r.holder.title].filter(Boolean).join(' · ') } : '—',
            statusLabel(r.state),
            r.returnNotice ?? r.holder?.remarks ?? r.notes ?? '',
          ]),
        },
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the asset register as PDF (${listReference(count, rows.length, ['asset', 'assets'], [])})` }, req);
    sendListPdf(res, pdf, 'company-assets.pdf');
  }),
);

/** What an employee holds and has returned — their record's Assets tab, and My Records. Above /:id. */
assetRoutes.get(
  '/employee/:employeeId',
  handler(async (req, res) => {
    const me = currentUser(req);
    const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId }, select: { id: true, userId: true } });
    if (!employee) throw notFound('Employee not found');
    const own = employee.userId === me.id;
    if (!own && viewScope(me, 'ghr', 'assets') !== 'all') throw notFound('Employee not found');
    const rows = await prisma.assetIssuance.findMany({
      where: { employeeId: employee.id },
      orderBy: [{ returnedOn: { sort: 'asc', nulls: 'first' } }, { issuedOn: 'desc' }],
      include: { asset: { select: { id: true, tag: true, brandModel: true, serialNo: true, plateNo: true, assetType: { select: { name: true } } } }, receivedBy: { select: { name: true } } },
    });
    res.json({
      rows: rows.map((r) => ({ ...r, asset: { ...r.asset, details: detailsOf(r.asset) } })),
      holding: rows.filter((r) => !r.returnedOn).length,
    });
  }),
);

// ── Add and modify ──────────────────────────────────────────────────────────

const schema = z.object({
  assetTypeId: z.string().min(1, 'Which type of asset?'),
  brandModel: z.string().trim().min(2, 'Name the brand and model').max(200),
  serialNo: z.string().trim().max(100).optional().nullable(),
  plateNo: z.string().trim().max(40).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  purchaseDate: z.string().regex(DAY, 'Use a date').optional().nullable(),
  cost: z.number().nonnegative().max(1e12).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

async function checkType(id: string | undefined) {
  if (!id) return;
  const t = await prisma.assetType.findUnique({ where: { id }, select: { isActive: true } });
  if (!t) throw badRequest('That asset type does not exist');
  if (!t.isActive) throw badRequest('That asset type is no longer offered');
}

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

assetRoutes.post(
  '/',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'ghr.assets.create')) throw forbidden('You may not add an asset');
    const body = parseBody(schema, req.body);
    await checkType(body.assetTypeId);
    if (body.cost != null && !seesCost(me)) throw forbidden('The cost is kept by whoever may edit every asset');
    const row = await prisma.$transaction(async (tx) => {
      const tag = await nextNumber('company_asset', tx);
      return tx.companyAsset.create({
        data: {
          tag,
          assetTypeId: body.assetTypeId,
          brandModel: body.brandModel,
          serialNo: blank(body.serialNo),
          plateNo: blank(body.plateNo),
          description: blank(body.description),
          purchaseDate: body.purchaseDate ? dayOf(body.purchaseDate) : null,
          cost: body.cost ?? null,
          notes: blank(body.notes),
          createdById: me.id,
        },
        include,
      });
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CREATED', summary: `Added ${row.assetType.name.toLowerCase()} ${row.tag} — ${row.brandModel}` }, req);
    res.status(201).json((await present(me, [row]))[0]);
  }),
);

assetRoutes.get(
  '/:id',
  requireView('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    try {
      assertCanView(me, 'ghr', 'assets', isMine(me, row), row.createdById);
    } catch {
      throw notFound('Asset not found');
    }
    const history = await prisma.assetIssuance.findMany({
      where: { assetId: row.id },
      orderBy: { issuedOn: 'desc' },
      include: { employee: { select: personSelect }, issuedBy: { select: { name: true } }, receivedBy: { select: { name: true } } },
    });
    const [shown] = await present(me, [row]);
    const mayEdit = shown.canEdit;
    res.json({
      ...shown,
      seesCost: seesCost(me),
      currency: await companyCurrency(),
      history: history.map((h) => ({
        id: h.id,
        employeeId: h.employee.id,
        name: nameOf(h.employee),
        employeeNo: h.employee.employeeNo,
        team: h.employee.industry?.code ?? null,
        issuedOn: h.issuedOn,
        issuedBy: h.issuedBy.name,
        conditionOut: h.conditionOut,
        remarks: h.remarks,
        returnedOn: h.returnedOn,
        receivedBy: h.receivedBy?.name ?? null,
        conditionBack: h.conditionBack,
        returnNote: h.returnNote,
      })),
      canIssue: mayEdit && row.status === 'AVAILABLE',
      canReturn: mayEdit && row.status === 'ISSUED',
      canRepair: mayEdit && (row.status === 'AVAILABLE' || row.status === 'UNDER_REPAIR'),
      canRetire: mayEdit && (row.status === 'AVAILABLE' || row.status === 'UNDER_REPAIR'),
      canRestore: mayEdit && row.status === 'RETIRED',
      canDelete: mayEdit && can(me, 'ghr.assets.edit_all') && history.length === 0,
    });
  }),
);

assetRoutes.patch(
  '/:id',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(schema.partial(), req.body);
    const existing = await load(req.params.id);
    assertCanEdit(me, 'ghr', 'assets', existing.createdById === me.id, existing.createdById);
    await checkType(body.assetTypeId);
    if (body.cost !== undefined && !seesCost(me)) throw forbidden('The cost is kept by whoever may edit every asset');
    const updated = await prisma.companyAsset.update({
      where: { id: existing.id },
      data: {
        ...(body.assetTypeId ? { assetTypeId: body.assetTypeId } : {}),
        ...(body.brandModel ? { brandModel: body.brandModel } : {}),
        ...(body.serialNo !== undefined ? { serialNo: blank(body.serialNo) } : {}),
        ...(body.plateNo !== undefined ? { plateNo: blank(body.plateNo) } : {}),
        ...(body.description !== undefined ? { description: blank(body.description) } : {}),
        ...(body.purchaseDate !== undefined ? { purchaseDate: body.purchaseDate ? dayOf(body.purchaseDate) : null } : {}),
        ...(body.cost !== undefined ? { cost: body.cost } : {}),
        ...(body.notes !== undefined ? { notes: blank(body.notes) } : {}),
      },
      include,
    });
    const { cost: _b, ...before } = existing;
    const { cost: _a, ...after } = updated;
    await audit({ entityType: DOC, entityId: updated.id, action: 'UPDATED', summary: `Modified asset ${updated.tag}`, before, after }, req);
    res.json((await present(me, [updated]))[0]);
  }),
);

// ── Issue, take back, repair, retire ────────────────────────────────────────

/** The asset as its editor holds it — or a 404 for whoever may not change it. */
async function forEdit(req: Parameters<Parameters<typeof handler>[0]>[0]) {
  const me = currentUser(req);
  const row = await load(req.params.id);
  try {
    assertCanEdit(me, 'ghr', 'assets', row.createdById === me.id, row.createdById);
  } catch {
    throw notFound('Asset not found');
  }
  return { me, row };
}

const today = () => manilaDate(new Date()).toISOString().slice(0, 10);

assetRoutes.post(
  '/:id/issue',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const { me, row } = await forEdit(req);
    const body = parseBody(
      z.object({
        employeeId: z.string().min(1, 'Issue it to whom?'),
        issuedOn: z.string().regex(DAY).optional(),
        conditionOut: z.string().trim().max(200).optional().nullable(),
        remarks: z.string().trim().max(2000).optional().nullable(),
      }),
      req.body,
    );
    const on = body.issuedOn ?? today();
    if (on > today()) throw badRequest('An asset is issued on a day that has come');
    const employee = await prisma.employee.findUnique({ where: { id: body.employeeId }, select: personSelect });
    if (!employee) throw badRequest('That employee is not on the register');
    if (!employee.isActive) throw badRequest(`${nameOf(employee)} is no longer active`);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.companyAsset.updateMany({ where: { id: row.id, status: 'AVAILABLE' }, data: { status: 'ISSUED' } });
      if (!claimed.count) throw conflict(row.status === 'ISSUED' ? 'It is issued already — take it back first' : `Only an available asset is issued — this one is ${statusLabel(row.status).toLowerCase()}`);
      await tx.assetIssuance.create({
        data: { assetId: row.id, employeeId: employee.id, issuedOn: dayOf(on), issuedById: me.id, conditionOut: blank(body.conditionOut), remarks: blank(body.remarks) },
      });
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `Issued ${row.tag} (${row.brandModel}) to ${nameOf(employee)}` }, req);
    res.json((await present(me, [await load(row.id)]))[0]);
  }),
);

assetRoutes.post(
  '/:id/return',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const { me, row } = await forEdit(req);
    const body = parseBody(
      z.object({
        returnedOn: z.string().regex(DAY).optional(),
        conditionBack: z.string().trim().max(200).optional().nullable(),
        returnNote: z.string().trim().max(2000).optional().nullable(),
        toRepair: z.boolean().optional(),
      }),
      req.body,
    );
    const open = row.issuances[0];
    if (!open || row.status !== 'ISSUED') throw conflict('It is not issued to anybody');
    const on = body.returnedOn ?? today();
    if (on > today()) throw badRequest('It is returned on a day that has come');
    if (on < open.issuedOn.toISOString().slice(0, 10)) throw badRequest('It cannot come back before it was issued');
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.assetIssuance.updateMany({
        where: { id: open.id, returnedOn: null },
        data: { returnedOn: dayOf(on), receivedById: me.id, conditionBack: blank(body.conditionBack), returnNote: blank(body.returnNote) },
      });
      if (!claimed.count) throw conflict('It was taken back a moment ago — reload it');
      await tx.companyAsset.update({ where: { id: row.id }, data: { status: body.toRepair ? 'UNDER_REPAIR' : 'AVAILABLE' } });
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `Took back ${row.tag} from ${nameOf(open.employee)}${body.toRepair ? ' — to repair' : ''}` }, req);
    res.json((await present(me, [await load(row.id)]))[0]);
  }),
);

/** Off to repair, or back from it. */
assetRoutes.post(
  '/:id/repair',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const { me, row } = await forEdit(req);
    const back = req.body?.back === true;
    const claimed = await prisma.companyAsset.updateMany({ where: { id: row.id, status: back ? 'UNDER_REPAIR' : 'AVAILABLE' }, data: { status: back ? 'AVAILABLE' : 'UNDER_REPAIR' } });
    if (!claimed.count) throw conflict(back ? 'It is not under repair' : 'Only an available asset is sent to repair');
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: back ? `${row.tag} back from repair` : `${row.tag} sent to repair` }, req);
    res.json((await present(me, [await load(row.id)]))[0]);
  }),
);

/** Retired, it is kept on file and never offered; `{ restore: true }` brings it back. */
assetRoutes.post(
  '/:id/retire',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const { me, row } = await forEdit(req);
    const restore = req.body?.restore === true;
    if (restore) {
      const claimed = await prisma.companyAsset.updateMany({ where: { id: row.id, status: 'RETIRED' }, data: { status: 'AVAILABLE', retiredAt: null, retiredReason: null } });
      if (!claimed.count) throw conflict('It is not retired');
      await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `Restored ${row.tag}` }, req);
    } else {
      const { reason } = parseBody(z.object({ reason: z.string().trim().min(3, 'Say why it is retired') }), req.body);
      const claimed = await prisma.companyAsset.updateMany({
        where: { id: row.id, status: { in: ['AVAILABLE', 'UNDER_REPAIR'] } },
        data: { status: 'RETIRED', retiredAt: new Date(), retiredReason: reason },
      });
      if (!claimed.count) throw conflict(row.status === 'ISSUED' ? 'Take it back before retiring it' : 'It is retired already');
      await audit({ entityType: DOC, entityId: row.id, action: 'CANCELLED', summary: `Retired ${row.tag} — ${reason}` }, req);
    }
    res.json((await present(me, [await load(row.id)]))[0]);
  }),
);

/** Only an asset never issued is deleted (its history is a record); Edit All. */
assetRoutes.delete(
  '/:id',
  requireEdit('ghr', 'assets'),
  handler(async (req, res) => {
    const { me, row } = await forEdit(req);
    if (!can(me, 'ghr.assets.edit_all')) throw forbidden('Deleting an asset is for whoever may edit every asset');
    const issued = await prisma.assetIssuance.count({ where: { assetId: row.id } });
    if (issued) throw badRequest(`${row.tag} has been issued ${issued === 1 ? 'once' : `${issued} times`} — retire it instead, so its history stays`);
    await deleteOrRefuse(`Asset ${row.tag}`, () => prisma.companyAsset.delete({ where: { id: row.id } }));
    await deleteAttachmentsOf(DOC, [row.id]);
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted asset ${row.tag} — ${row.brandModel}` }, req);
    res.json({ ok: true });
  }),
);

// ── The Asset Issuance Slip ─────────────────────────────────────────────────

/**
 * One hand-over on paper, for the wet signature: the asset, to whom and when,
 * its condition, then — once back — the return. Signed by the people who
 * acted: Issued by (dated), Received by the employee (signed by hand), and
 * on return Received back by, dated; "Pending" until it is.
 */
assetRoutes.get(
  '/:id/issuances/:issuanceId/pdf',
  requireView('ghr', 'assets'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    try {
      assertCanView(me, 'ghr', 'assets', isMine(me, row), row.createdById);
    } catch {
      throw notFound('Asset not found');
    }
    const h = await prisma.assetIssuance.findFirst({
      where: { id: req.params.issuanceId, assetId: row.id },
      include: { employee: { select: personSelect }, issuedBy: { select: { id: true, name: true } }, receivedBy: { select: { id: true, name: true } } },
    });
    if (!h) throw notFound('That issuance is not on this asset');
    const currency = await companyCurrency();
    const signatories: Signatory[] = [
      { role: 'Issued by', name: h.issuedBy.name, ...(await contactOf(h.issuedBy.id)), at: h.createdAt },
      { role: 'Received by', name: nameOf(h.employee), at: h.issuedOn },
      h.receivedBy ? { role: 'Returned — received by', name: h.receivedBy.name, ...(await contactOf(h.receivedBy.id)), at: h.returnedOn ?? undefined } : { role: 'Returned — received by' },
    ];
    const pdf = await renderDocument({
      title: 'Asset Issuance Slip',
      documentNumber: row.tag,
      date: h.issuedOn,
      reference: `${row.assetType.name} · ${row.brandModel}`,
      sections: [
        {
          kind: 'fields',
          columns: 2,
          fields: [
            { label: 'Asset tag', value: row.tag },
            { label: 'Asset type', value: row.assetType.name },
            { label: 'Brand & model', value: row.brandModel },
            { label: 'Serial / plate', value: detailsOf(row) || '—' },
            ...(row.cost != null && seesCost(me) ? [{ label: 'Cost', value: formatMoney(Number(row.cost), currency) }] : []),
            { label: 'Issued to', value: `${nameOf(h.employee)}${h.employee.employeeNo ? ` (${h.employee.employeeNo})` : ''}` },
            { label: 'Team / title', value: [h.employee.industry?.code, h.employee.position].filter(Boolean).join(' · ') || '—' },
            { label: 'Date issued', value: formatDate(h.issuedOn) },
            { label: 'Condition out', value: h.conditionOut ?? '—' },
          ],
        },
        ...(h.remarks ? [{ kind: 'text' as const, title: 'Remarks', body: h.remarks }] : []),
        {
          kind: 'text',
          title: 'Return',
          body: h.returnedOn
            ? `Returned on ${formatDate(h.returnedOn)}${h.conditionBack ? ` — condition: ${h.conditionBack}` : ''}.${h.returnNote ? ` ${h.returnNote}` : ''}`
            : 'Not yet returned. The holder answers for this asset until it is received back, and it is returned before their exit clearance closes.',
        },
      ],
      signatories,
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'EXPORTED', summary: `Printed the issuance slip of ${row.tag} to ${nameOf(h.employee)}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Asset Issuance Slip', number: row.tag, author: h.issuedBy.name, date: h.issuedOn })));
    res.send(pdf);
  }),
);

// ── Files and Ctrl+K ────────────────────────────────────────────────────────

/** The OR, a vehicle's OR/CR, photos: read as the asset is, added or removed by whoever may change it. */
registerAttachmentGuard(
  DOC,
  async (user, id) => {
    const row = await prisma.companyAsset.findUnique({ where: { id }, include });
    if (!row) return false;
    try {
      assertCanView(user, 'ghr', 'assets', isMine(user, row), row.createdById);
      return true;
    } catch {
      return false;
    }
  },
  {
    write: async (user, id) => {
      const row = await prisma.companyAsset.findUnique({ where: { id }, select: { createdById: true } });
      return !!row && canEditRecord(user, 'ghr', 'assets', row.createdById);
    },
  },
);

registerSearch({
  kind: DOC,
  label: 'Company assets',
  permission: ['ghr.assets.view_all', 'ghr.assets.view_team', 'ghr.assets.view_own'],
  ownWhere: (user) => ({ OR: [{ createdById: user.id }, { issuances: { some: { returnedOn: null, employee: { userId: user.id } } } }] }),
  search: async (term, _user, limit, own) => {
    const t = { contains: term, mode: 'insensitive' as const };
    const rows = await prisma.companyAsset.findMany({
      where: { AND: [own ?? {}, { OR: [{ tag: t }, { brandModel: t }, { serialNo: t }, { plateNo: t }] }] },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include,
    });
    return rows.map((r) => ({
      kind: DOC,
      id: r.id,
      title: `${r.tag} — ${r.brandModel}`,
      subtitle: `${r.assetType.name}${r.issuances[0] ? ` · issued to ${nameOf(r.issuances[0].employee)}` : ` · ${statusLabel(r.status)}`}`,
      link: `${PATH}/${r.id}`,
    }));
  },
});

export type { AssetState };
