import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody, badRequest, notFound, forbidden } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import {
  COMPANY_FIELDS,
  ITEM_COLUMNS,
  ITEM_COLUMN_LABELS,
  PAGE_FIELDS,
  companyValues,
  designSchema,
  renderDesigned,
  unknownFields,
  type DesignData,
  type PdfDesign,
} from '../shared/pdfDesign';
import {
  QUOTATION_FIELDS,
  QUOTATION_FIELD_KEYS,
  QUOTATION_TEMPLATE_KEY,
  STANDARD_QUOTATION_DESIGN,
  quotationDesign,
  quotationSample,
} from '../shared/quotationTemplate';
import { printableQuotation, quotationPrintData } from './sales';

/**
 * PDF Templates — the layout a designed document prints with (see
 * `shared/pdfDesign.ts`). The quotation is the one document laid out this
 * way; every other document keeps the house style, which is code.
 *
 * The layout is one `Setting` row. Saving checks its shape and every field it
 * names, so a typo in a placeholder is refused here rather than printing
 * nothing on a customer's quotation. Deleting the row puts the standard
 * layout back. A preview renders whatever the editor holds — saved or not —
 * against the sample, or against a real quotation the caller may print.
 */

export const pdfTemplateRoutes = Router();
pdfTemplateRoutes.use(authenticate);

function documentType(param: string): 'quotation' {
  if (param !== 'quotation') throw notFound('There is no PDF template for that document');
  return param;
}

/** A layout as the editor sent it: its shape, then every field it names. */
function checkedDesign(body: unknown): PdfDesign {
  const design = parseBody(designSchema, body);
  const unknown = unknownFields(design, QUOTATION_FIELD_KEYS);
  if (unknown.length) throw badRequest('Some boxes name fields this document does not have', unknown);
  return design;
}

// The company logo, for the editor's page. Above /:type, which would take "logo" for a document.
pdfTemplateRoutes.get(
  '/logo',
  require_('admin.pdf_templates.view_all'),
  handler(async (_req, res) => {
    const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { logoPath: true } });
    if (!company?.logoPath || !fs.existsSync(company.logoPath)) throw notFound('No logo is set in Company Settings');
    res.sendFile(path.resolve(company.logoPath));
  }),
);

pdfTemplateRoutes.get(
  '/:type',
  require_('admin.pdf_templates.view_all'),
  handler(async (req, res) => {
    documentType(req.params.type);
    const { design, saved, unreadable } = await quotationDesign();
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    // The company's own details are the editor's samples, so the page shows
    // the letterhead as it will print — an unset fax drops out there too.
    const mine = companyValues(company);
    res.json({
      type: 'quotation',
      label: 'Quotation',
      layout: design,
      saved,
      unreadable,
      standard: STANDARD_QUOTATION_DESIGN,
      fields: [...QUOTATION_FIELDS, ...COMPANY_FIELDS.map((f) => ({ ...f, sample: mine[f.key] ?? '' })), ...PAGE_FIELDS],
      columns: ITEM_COLUMNS.map((key) => ({ key, label: ITEM_COLUMN_LABELS[key] })),
      sample: quotationSample(false),
      hasLogo: !!company?.logoPath && fs.existsSync(company.logoPath),
    });
  }),
);

pdfTemplateRoutes.put(
  '/:type',
  require_('admin.pdf_templates.edit_all'),
  handler(async (req, res) => {
    documentType(req.params.type);
    const design = checkedDesign(req.body);
    const before = await prisma.setting.findUnique({ where: { key: QUOTATION_TEMPLATE_KEY } });
    await prisma.setting.upsert({
      where: { key: QUOTATION_TEMPLATE_KEY },
      create: {
        key: QUOTATION_TEMPLATE_KEY,
        value: design as unknown as object,
        description: 'The quotation PDF layout, set from Admin › PDF Templates',
      },
      update: { value: design as unknown as object },
    });
    await audit(
      {
        entityType: 'setting',
        entityId: QUOTATION_TEMPLATE_KEY,
        action: 'UPDATED',
        summary: `Changed the quotation PDF layout (${design.blocks.length} boxes)`,
        before: before?.value ?? null,
        after: design,
      },
      req,
    );
    res.json({ layout: design, saved: true, unreadable: false });
  }),
);

pdfTemplateRoutes.delete(
  '/:type',
  require_('admin.pdf_templates.edit_all'),
  handler(async (req, res) => {
    documentType(req.params.type);
    const before = await prisma.setting.findUnique({ where: { key: QUOTATION_TEMPLATE_KEY } });
    if (before) {
      await prisma.setting.delete({ where: { key: QUOTATION_TEMPLATE_KEY } });
      await audit(
        {
          entityType: 'setting',
          entityId: QUOTATION_TEMPLATE_KEY,
          action: 'DELETED',
          summary: 'Put the quotation PDF back to the standard layout',
          before: before.value,
        },
        req,
      );
    }
    res.json({ layout: STANDARD_QUOTATION_DESIGN, saved: false, unreadable: false });
  }),
);

// Import: a layout exported from another G-CORE — the laptop's, to put on the
// live server — read with the rules a save uses (its shape, every field it
// names) and handed back with whatever an older file leaves out filled in, so
// the editor can show it before anything is saved. Nothing is stored here.
pdfTemplateRoutes.post(
  '/:type/check',
  require_('admin.pdf_templates.edit_all'),
  handler(async (req, res) => {
    documentType(req.params.type);
    res.json({ layout: checkedDesign(req.body) });
  }),
);

const previewSchema = z.object({
  layout: z.unknown(),
  /** A real quotation to print with the layout; its newest revision unless one is named. */
  quotationId: z.string().min(1).optional(),
  revisionId: z.string().min(1).optional(),
  /** Without a quotation: the one-page sample, or one that runs to three pages. */
  sample: z.enum(['short', 'long']).default('short'),
});

pdfTemplateRoutes.post(
  '/:type/preview',
  require_('admin.pdf_templates.view_all'),
  handler(async (req, res) => {
    documentType(req.params.type);
    const body = parseBody(previewSchema, req.body);
    const design = checkedDesign(body.layout);

    let data: DesignData;
    if (body.quotationId) {
      // A real quotation is the quotation's own business: whoever previews
      // one must be able to print it from the quotation page.
      const me = currentUser(req);
      if (!me.isSuperAdmin && !me.permissions.has('gops.quotations.view_all') && !me.permissions.has('gops.quotations.view_own')) {
        throw forbidden('Previewing a real quotation needs access to quotations');
      }
      const quotation = await printableQuotation(me, body.quotationId);
      const revision = body.revisionId ? quotation.revisions.find((r) => r.id === body.revisionId) : quotation.revisions[0];
      if (!revision) throw notFound('Revision not found');
      data = await quotationPrintData(quotation, revision);
      await audit(
        {
          entityType: 'quotation',
          entityId: quotation.id,
          action: 'EXPORTED',
          summary: `Previewed ${quotation.number} R${revision.revision} with a PDF template`,
        },
        req,
      );
    } else {
      data = quotationSample(body.sample === 'long');
    }

    const pdf = await renderDesigned(design, data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="quotation-preview.pdf"');
    res.send(pdf);
  }),
);
