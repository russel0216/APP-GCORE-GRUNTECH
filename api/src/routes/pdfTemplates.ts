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
  COST_COLUMNS,
  PAGE_FIELDS,
  companyValues,
  designSchema,
  renderDesigned,
  unknownFields,
  type DesignData,
  type DesignField,
  type ItemColumnKey,
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
import {
  SALES_ORDER_FIELDS,
  SALES_ORDER_FIELD_KEYS,
  SALES_ORDER_TEMPLATE_KEY,
  STANDARD_SALES_ORDER_DESIGN,
  salesOrderDesign,
  salesOrderSample,
  withoutCostColumns as stripCost,
} from '../shared/salesOrderTemplate';
import { printableQuotation, quotationPrintData } from './sales';
import { canSeeOrderCost, printableSalesOrder, salesOrderPrintData } from './salesOrders';

/**
 * PDF Templates — the layout a designed document prints with (see
 * `shared/pdfDesign.ts`). Two documents are laid out this way: the quotation
 * (the paper a customer receives) and the sales order (the internal booking
 * record, landscape, the one layout that may place the cost columns). Every
 * other document keeps the house style, which is code.
 *
 * Each layout is one `Setting` row. Saving checks its shape, every field it
 * names and every column it places, so a typo in a placeholder is refused
 * here rather than printing nothing on a customer's quotation — and a cost
 * column can never be saved onto a customer-facing document. Deleting the row
 * puts the standard layout back. A preview renders whatever the editor holds
 * — saved or not — against the sample, or against a real document the caller
 * may print.
 */

export const pdfTemplateRoutes = Router();
pdfTemplateRoutes.use(authenticate);

interface TemplateDoc {
  type: 'quotation' | 'sales_order';
  label: string;
  settingKey: string;
  fields: DesignField[];
  fieldKeys: Set<string>;
  /** The columns this document's line table may place. */
  columns: readonly ItemColumnKey[];
  standard: PdfDesign;
  design: () => Promise<{ design: PdfDesign; saved: boolean; unreadable: boolean }>;
  sample: (long: boolean) => DesignData;
  /** Previewing with a real document needs that document's own list access. */
  previewPermissions: string[];
  previewDenied: string;
}

const DOCS: Record<string, TemplateDoc> = {
  quotation: {
    type: 'quotation',
    label: 'Quotation',
    settingKey: QUOTATION_TEMPLATE_KEY,
    fields: QUOTATION_FIELDS,
    fieldKeys: QUOTATION_FIELD_KEYS,
    // The customer's paper: the cost columns are not offered and not accepted.
    columns: ITEM_COLUMNS.filter((k) => !COST_COLUMNS.includes(k)),
    standard: STANDARD_QUOTATION_DESIGN,
    design: quotationDesign,
    sample: quotationSample,
    previewPermissions: ['gops.quotations.view_all', 'gops.quotations.view_own'],
    previewDenied: 'Previewing a real quotation needs access to quotations',
  },
  sales_order: {
    type: 'sales_order',
    label: 'Sales Order',
    settingKey: SALES_ORDER_TEMPLATE_KEY,
    fields: SALES_ORDER_FIELDS,
    fieldKeys: SALES_ORDER_FIELD_KEYS,
    columns: ITEM_COLUMNS,
    standard: STANDARD_SALES_ORDER_DESIGN,
    design: salesOrderDesign,
    sample: salesOrderSample,
    previewPermissions: ['gops.sales_orders.view_all', 'gops.sales_orders.view_own'],
    previewDenied: 'Previewing a real sales order needs access to sales orders',
  },
};

function documentType(param: string): TemplateDoc {
  const doc = DOCS[param];
  if (!doc) throw notFound('There is no PDF template for that document');
  return doc;
}

/** A layout as the editor sent it: its shape, every field it names, every column it places. */
function checkedDesign(doc: TemplateDoc, body: unknown): PdfDesign {
  const design = parseBody(designSchema, body);
  const unknown = unknownFields(design, doc.fieldKeys);
  if (unknown.length) throw badRequest('Some boxes name fields this document does not have', unknown);
  for (const b of design.blocks) {
    if (b.type !== 'items') continue;
    const barred = b.columns.filter((c) => !doc.columns.includes(c.key));
    if (barred.length) {
      throw badRequest(
        `The ${doc.label.toLowerCase()}'s line table cannot print ${barred.map((c) => ITEM_COLUMN_LABELS[c.key].toLowerCase()).join(', ')}`,
      );
    }
  }
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
    const doc = documentType(req.params.type);
    const { design, saved, unreadable } = await doc.design();
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    // The company's own details are the editor's samples, so the page shows
    // the letterhead as it will print — an unset fax drops out there too.
    const mine = companyValues(company);
    res.json({
      type: doc.type,
      label: doc.label,
      layout: design,
      saved,
      unreadable,
      standard: doc.standard,
      fields: [...doc.fields, ...COMPANY_FIELDS.map((f) => ({ ...f, sample: mine[f.key] ?? '' })), ...PAGE_FIELDS],
      columns: doc.columns.map((key) => ({ key, label: ITEM_COLUMN_LABELS[key] })),
      sample: doc.sample(false),
      hasLogo: !!company?.logoPath && fs.existsSync(company.logoPath),
    });
  }),
);

pdfTemplateRoutes.put(
  '/:type',
  require_('admin.pdf_templates.edit_all'),
  handler(async (req, res) => {
    const doc = documentType(req.params.type);
    const design = checkedDesign(doc, req.body);
    const before = await prisma.setting.findUnique({ where: { key: doc.settingKey } });
    await prisma.setting.upsert({
      where: { key: doc.settingKey },
      create: {
        key: doc.settingKey,
        value: design as unknown as object,
        description: `The ${doc.label.toLowerCase()} PDF layout, set from Admin › PDF Templates`,
      },
      update: { value: design as unknown as object },
    });
    await audit(
      {
        entityType: 'setting',
        entityId: doc.settingKey,
        action: 'UPDATED',
        summary: `Changed the ${doc.label.toLowerCase()} PDF layout (${design.blocks.length} boxes)`,
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
    const doc = documentType(req.params.type);
    const before = await prisma.setting.findUnique({ where: { key: doc.settingKey } });
    if (before) {
      await prisma.setting.delete({ where: { key: doc.settingKey } });
      await audit(
        {
          entityType: 'setting',
          entityId: doc.settingKey,
          action: 'DELETED',
          summary: `Put the ${doc.label.toLowerCase()} PDF back to the standard layout`,
          before: before.value,
        },
        req,
      );
    }
    res.json({ layout: doc.standard, saved: false, unreadable: false });
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
    const doc = documentType(req.params.type);
    res.json({ layout: checkedDesign(doc, req.body) });
  }),
);

const previewSchema = z.object({
  layout: z.unknown(),
  /** A real document to print with the layout. */
  documentId: z.string().min(1).optional(),
  /** The quotation's older name for it, still honoured. */
  quotationId: z.string().min(1).optional(),
  /** A quotation's newest revision prints unless one is named. */
  revisionId: z.string().min(1).optional(),
  /** Without a real document: the one-page sample, or one that runs to several pages. */
  sample: z.enum(['short', 'long']).default('short'),
});

pdfTemplateRoutes.post(
  '/:type/preview',
  require_('admin.pdf_templates.view_all'),
  handler(async (req, res) => {
    const doc = documentType(req.params.type);
    const body = parseBody(previewSchema, req.body);
    let design = checkedDesign(doc, body.layout);
    const documentId = body.documentId ?? (doc.type === 'quotation' ? body.quotationId : undefined);

    let data: DesignData;
    if (documentId) {
      // A real document is that document's own business: whoever previews
      // one must be able to print it from its own page.
      const me = currentUser(req);
      if (!me.isSuperAdmin && !doc.previewPermissions.some((p) => me.permissions.has(p))) {
        throw forbidden(doc.previewDenied);
      }
      if (doc.type === 'quotation') {
        const quotation = await printableQuotation(me, documentId);
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
        const order = await printableSalesOrder(me, documentId);
        // The preview obeys the cost rule exactly as the order's own PDF does.
        const showCost = canSeeOrderCost(me, order.ownerId);
        if (!showCost) design = stripCost(design);
        data = await salesOrderPrintData(order, showCost);
        await audit(
          {
            entityType: 'sales_order',
            entityId: order.id,
            action: 'EXPORTED',
            summary: `Previewed sales order ${order.number} with a PDF template`,
          },
          req,
        );
      }
    } else {
      data = doc.sample(body.sample === 'long');
    }

    const pdf = await renderDesigned(design, data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.type.replace('_', '-')}-preview.pdf"`);
    res.send(pdf);
  }),
);
