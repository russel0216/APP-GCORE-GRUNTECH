import { Router } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody, listQuery, listResult, notFound, badRequest } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { globalSearch, searchProviders } from '../shared/search';
import { act, historyFor, pendingFor } from '../shared/approvals';
import { upload, saveAttachment, attachmentPath, deleteAttachment } from '../shared/attachments';
import { renderDocument, formatDate } from '../shared/pdf';
import { can } from '../permissions/resolve';

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
        .filter((p) => can(me, p.permission))
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
      rows.map((r) => ({ ...r, amount: r.amount ? Number(r.amount) : null })),
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
    res.json(await historyFor(req.params.documentType, req.params.documentId));
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

export const myWorkRoutes = Router();
myWorkRoutes.use(authenticate);

myWorkRoutes.get(
  '/',
  handler(async (req, res) => {
    const me = currentUser(req);

    const [approvals, submitted, unread, recentActivity] = await Promise.all([
      pendingFor(me.id),
      prisma.approvalRequest.findMany({
        where: { requesterId: me.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.notification.count({ where: { userId: me.id, isRead: false } }),
      prisma.auditLog.findMany({
        where: { actorId: me.id },
        orderBy: { at: 'desc' },
        take: 8,
      }),
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
      // Assigned work and today's schedule fill in as G-OPS lands in Phases 3–4.
      assignedToMe: [],
      todaysSchedule: [],
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

attachmentRoutes.get(
  '/:entityType/:entityId',
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
