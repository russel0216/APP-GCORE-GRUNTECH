import { Router } from 'express';
import { placeOnShelf } from '../shared/catalogue';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, badRequest, notFound } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import {
  runImport,
  templateFor,
  decodeCsv,
  required,
  optional,
  decimal,
  bool,
  date,
  oneOf,
  type ImportSpec,
  type ImportActor,
} from '../shared/csv';
import { employeesImport } from './imports/employees';
import { scoroQuotesImport } from './imports/scoroQuotes';
import { scoroInvoicesImport } from './imports/scoroInvoices';
import { odooInventoryImport, odooAssetsImport } from './imports/odoo';
import { odooPicturesImport, PICTURE_UPLOAD_MB } from './imports/odooPictures';
import { courseImport } from './academy';
import { makePartner, safeHttpUrl, type ResourceKind } from '../shared/partners';

/**
 * CSV import for the master records.
 *
 * Upload once to see what would happen, upload again with commit=true to apply.
 * Nothing is written if any row fails validation — see `runImport`.
 */

export const importRoutes = Router();
importRoutes.use(authenticate);

// Held in memory: these are operator-sized spreadsheets, not bulk data loads,
// and nothing should linger on disk after a dry run the user abandons.
const IMPORT_UPLOAD_MB = 8;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_UPLOAD_MB * 1024 * 1024 },
});
/** Imports fed by a whole Odoo export: its pictures, its products and its assets. */
const LARGE_IMPORTS = new Set(['odoo_pictures', 'odoo_inventory', 'odoo_assets']);
// Odoo's pictures ride in the CSV as base64 (2026-10-25): a batch of a few
// hundred products is tens of MB, so that one import takes the larger ceiling.
const pictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PICTURE_UPLOAD_MB * 1024 * 1024 },
});

// ── Specs ────────────────────────────────────────────────────────────────────

/**
 * Resolves a Sub-industry cell — the name, any case — against the active
 * list; blank is none (the owner's call, 2026-10-08: typed in by hand,
 * later). The error names every sub-industry, because the person fixing the
 * spreadsheet should not have to open the app to learn them.
 */
async function resolveSubIndustry(row: Record<string, string>): Promise<string | null> {
  const v = optional(row, 'Sub-industry') ?? optional(row, 'Sub Industry');
  if (!v) return null;
  const found = await prisma.subIndustry.findFirst({
    where: { isActive: true, name: { equals: v, mode: 'insensitive' } },
  });
  if (!found) {
    const all = await prisma.subIndustry.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    throw new Error(`Sub-industry "${v}" must be one of: ${all.map((s) => s.name).join(', ')}`);
  }
  return found.id;
}

export const customerSpec: ImportSpec<Prisma.CustomerCreateInput> = {
  entity: 'customers',
  label: 'Customers',
  columns: [
    { header: 'Name', required: true, example: 'Sample Hospital Inc.' },
    { header: 'Code', example: '', hint: 'Leave blank to auto-generate' },
    { header: 'Legal Name', example: 'Sample Hospital Incorporated' },
    { header: 'TIN', example: '000-123-456-000' },
    {
      header: 'Sub-industry',
      example: 'Healthcare',
      hint: 'One of the sub-industries under Admin › Categories (Healthcare, Pharmaceutical, Government, Food and Beverage, Mining…) — or blank',
    },
    { header: 'Payment Terms', example: '30 days' },
    { header: 'Credit Limit', example: '500000' },
    {
      header: 'Address',
      example: 'Carmen, Cagayan de Oro',
      hint: 'The address a quotation prints; blank takes the site’s address and city, and never clears one on file',
    },
    { header: 'Phone', example: '+63 88 123 4567' },
    { header: 'Email', example: 'purchasing@samplehospital.ph' },
    { header: 'Website', example: 'www.samplehospital.ph' },
    { header: 'Active', example: 'Yes' },
    { header: 'Contact Name', example: 'Maria Santos', hint: 'Creates one primary contact' },
    { header: 'Contact Position', example: 'Purchasing Officer' },
    { header: 'Contact Email', example: 'maria@samplehospital.ph' },
    { header: 'Contact Mobile', example: '+63 917 000 0000' },
    { header: 'Site Name', example: 'Main Plant', hint: 'Creates one site' },
    { header: 'Site Address', example: 'Carmen, Cagayan de Oro' },
    { header: 'Site City', example: 'Cagayan de Oro' },
    { header: 'Notes', example: '' },
  ],
  existing: async (row) => {
    const code = row['Code'];
    if (code) {
      const byCode = await prisma.customer.findUnique({ where: { code } });
      if (byCode) return byCode.id;
    }
    // Name is the practical duplicate key when no code is supplied — importing
    // the same spreadsheet twice should update, not create a second "Sample
    // Hospital Inc.".
    const byName = await prisma.customer.findFirst({
      where: { name: { equals: row['Name'], mode: 'insensitive' } },
    });
    return byName?.id ?? null;
  },
  build: async (row) => ({
    code: row['Code'] || '',
    name: required(row, 'Name'),
    legalName: optional(row, 'Legal Name'),
    tin: optional(row, 'TIN'),
    ...(await resolveSubIndustry(row).then((id) => (id ? { subIndustry: { connect: { id } } } : {}))),
    paymentTerms: optional(row, 'Payment Terms'),
    creditLimit: decimal(row, 'Credit Limit'),
    phone: optional(row, 'Phone'),
    email: optional(row, 'Email'),
    website: optional(row, 'Website'),
    // The customer's own address (2026-10-11): the file's Address, else its
    // site's address and city; a blank leaves an address on file as it is.
    ...((): { address?: string } => {
      const address = optional(row, 'Address') ?? ([optional(row, 'Site Address'), optional(row, 'Site City')].filter(Boolean).join(', ') || null);
      return address ? { address } : {};
    })(),
    notes: optional(row, 'Notes'),
    isActive: bool(row, 'Active'),
    // Carried through to the writer below.
    contacts: row['Contact Name']
      ? {
          create: [
            {
              name: row['Contact Name'],
              position: optional(row, 'Contact Position'),
              email: optional(row, 'Contact Email'),
              mobile: optional(row, 'Contact Mobile'),
              isPrimary: true,
            },
          ],
        }
      : undefined,
    sites: row['Site Name']
      ? {
          create: [
            {
              name: row['Site Name'],
              address: optional(row, 'Site Address'),
              city: optional(row, 'Site City'),
            },
          ],
        }
      : undefined,
  }),
};

const supplierSpec: ImportSpec<Prisma.SupplierCreateInput> = {
  entity: 'suppliers',
  label: 'Suppliers',
  columns: [
    { header: 'Name', required: true, example: 'Metro Steel Supply' },
    { header: 'Code', example: '' },
    { header: 'Legal Name', example: 'Metro Steel Supply Corp.' },
    { header: 'TIN', example: '000-987-654-000' },
    { header: 'Category', example: 'Steel & fabrication' },
    { header: 'Payment Terms', example: '30 days' },
    { header: 'Address', example: '12 Industrial Ave.' },
    { header: 'City', example: 'Cagayan de Oro' },
    { header: 'Phone', example: '+63 88 765 4321' },
    { header: 'Email', example: 'sales@metrosteel.ph' },
    { header: 'Website', example: '' },
    { header: 'Active', example: 'Yes' },
    { header: 'Contact Name', example: 'Jun Reyes' },
    { header: 'Contact Position', example: 'Account Manager' },
    { header: 'Contact Email', example: 'jun@metrosteel.ph' },
    { header: 'Contact Mobile', example: '+63 918 000 0000' },
    { header: 'Notes', example: '' },
  ],
  existing: async (row) => {
    if (row['Code']) {
      const byCode = await prisma.supplier.findUnique({ where: { code: row['Code'] } });
      if (byCode) return byCode.id;
    }
    const byName = await prisma.supplier.findFirst({
      where: { name: { equals: row['Name'], mode: 'insensitive' } },
    });
    return byName?.id ?? null;
  },
  build: async (row) => ({
    code: row['Code'] || '',
    name: required(row, 'Name'),
    legalName: optional(row, 'Legal Name'),
    tin: optional(row, 'TIN'),
    category: optional(row, 'Category'),
    paymentTerms: optional(row, 'Payment Terms'),
    address: optional(row, 'Address'),
    city: optional(row, 'City'),
    phone: optional(row, 'Phone'),
    email: optional(row, 'Email'),
    website: optional(row, 'Website'),
    notes: optional(row, 'Notes'),
    isActive: bool(row, 'Active'),
    contacts: row['Contact Name']
      ? {
          create: [
            {
              name: row['Contact Name'],
              position: optional(row, 'Contact Position'),
              email: optional(row, 'Contact Email'),
              mobile: optional(row, 'Contact Mobile'),
              isPrimary: true,
            },
          ],
        }
      : undefined,
  }),
};

// ── Partners ─────────────────────────────────────────────────────────────────
// One row per principal: the supplier core fields plus up to four links,
// one per resource kind. Files cannot come through a CSV; those are added on
// the partner page. Exported so verify-partners.ts drives the real spec.

export interface PartnerImportRecord {
  name: string;
  brand: string | null;
  category: string | null;
  website: string | null;
  contactName: string | null;
  isActive: boolean;
  links: { kind: ResourceKind; url: string }[];
}

const PARTNER_LINK_COLUMNS: { header: string; aliases?: string[]; kind: ResourceKind; title: string }[] = [
  { header: 'Catalogue URL', kind: 'CATALOGUE', title: 'Online catalogue' },
  { header: 'Price List URL', kind: 'PRICE_LIST', title: 'Price list' },
  // "Software" since 2026-10-08; a file written against the old template's
  // "Sizing App URL" header still imports.
  { header: 'Software URL', aliases: ['Sizing App URL'], kind: 'SIZING_APP', title: 'Software' },
  // One of the partner's other sites (2026-10-08): a support portal, an
  // e-shop, downloads. More go on the partner's page, under Links.
  { header: 'Other Site URL', kind: 'LINK', title: 'Other site' },
];

export const partnerSpec: ImportSpec<PartnerImportRecord> = {
  entity: 'partners',
  label: 'Partners',
  columns: [
    { header: 'Name', required: true, example: 'Atlas Copco (Philippines) Inc.' },
    { header: 'Brand', example: 'Atlas Copco', hint: 'Trading name when it differs' },
    { header: 'Category', example: 'Compressors', hint: 'What they supply' },
    { header: 'Website', example: 'https://www.atlascopco.com' },
    { header: 'Catalogue URL', example: '', hint: 'http(s) link to the online catalogue' },
    { header: 'Price List URL', example: '', hint: 'http(s) link to the published price list' },
    { header: 'Software URL', example: '', hint: 'http(s) link to the partner\'s selection or sizing software' },
    { header: 'Other Site URL', example: '', hint: 'http(s) link to another of the partner\'s sites — support portal, e-shop, downloads' },
    { header: 'Contact Name', example: 'Jun Reyes', hint: 'Creates one primary contact on a new partner' },
    { header: 'Active', example: 'Yes' },
  ],
  existing: async (row) => {
    // Name OR brand, either case: a price-list spreadsheet says "Atlas Copco",
    // the registered supplier row says "Atlas Copco (Philippines) Inc.".
    const found = await prisma.supplier.findFirst({
      where: {
        OR: [
          { name: { equals: row['Name'], mode: 'insensitive' } },
          ...(row['Brand'] ? [{ brand: { equals: row['Brand'], mode: 'insensitive' as const } }] : []),
        ],
      },
    });
    return found?.id ?? null;
  },
  build: async (row) => {
    const links: { kind: ResourceKind; url: string }[] = [];
    for (const col of PARTNER_LINK_COLUMNS) {
      const v = row[col.header] || (col.aliases ?? []).map((a) => row[a]).find(Boolean);
      if (!v) continue;
      try {
        links.push({ kind: col.kind, url: safeHttpUrl(v) });
      } catch {
        throw new Error(`${col.header} "${v}" must start with http:// or https://`);
      }
    }
    return {
      name: required(row, 'Name'),
      brand: optional(row, 'Brand'),
      category: optional(row, 'Category'),
      website: optional(row, 'Website'),
      contactName: optional(row, 'Contact Name'),
      isActive: bool(row, 'Active'),
      links,
    };
  },
};

export async function partnerWrite(
  records: { record: PartnerImportRecord; existingId: string | null }[],
): Promise<void> {
  for (const { record, existingId } of records) {
    await prisma.$transaction(async (tx) => {
      const supplier = existingId
        ? await tx.supplier.update({
            where: { id: existingId },
            data: {
              isPartner: true,
              name: record.name,
              brand: record.brand,
              category: record.category ?? undefined,
              website: record.website ?? undefined,
              isActive: record.isActive,
            },
          })
        : await makePartner(
            {
              name: record.name,
              brand: record.brand,
              category: record.category,
              website: record.website,
              contact: record.contactName ? { name: record.contactName } : null,
            },
            null,
            tx,
          );
      if (!existingId && !record.isActive) {
        await tx.supplier.update({ where: { id: supplier.id }, data: { isActive: false } });
      }

      // One resource per link column, keyed by kind + title, so a re-import
      // updates the link rather than adding a second "Online catalogue".
      for (const link of record.links) {
        const col = PARTNER_LINK_COLUMNS.find((c) => c.kind === link.kind)!;
        const existing = await tx.partnerResource.findFirst({
          where: { supplierId: supplier.id, kind: link.kind, title: col.title },
        });
        if (existing) {
          await tx.partnerResource.update({ where: { id: existing.id }, data: { url: link.url, isActive: true } });
        } else {
          await tx.partnerResource.create({
            data: { supplierId: supplier.id, kind: link.kind, title: col.title, url: link.url },
          });
        }
      }
    });
  }
}


const ITEM_TYPES = ['MATERIAL', 'EQUIPMENT', 'CONSUMABLE', 'SERVICE', 'TOOL'] as const;

export const itemSpec: ImportSpec<Prisma.ItemCreateInput> = {
  entity: 'items',
  label: 'Items',
  columns: [
    { header: 'Code', required: true, example: 'PIP-SS-050' },
    { header: 'Name', required: true, example: 'Stainless pipe 1/2"' },
    { header: 'Part Number', example: 'SS304-050' },
    { header: 'Brand', example: 'Pentair', hint: 'The manufacturer / OEM' },
    { header: 'Description', example: 'SS304 seamless pipe, 1/2 inch' },
    { header: 'Type', example: 'MATERIAL', hint: 'MATERIAL, EQUIPMENT, CONSUMABLE, SERVICE or TOOL' },
    { header: 'Category', example: 'Piping', hint: 'Must match an item category name' },
    {
      header: 'Cost Category',
      example: 'Materials',
      hint: 'Materials, Equipment, Labor, Subcontractor or Indirect Cost',
    },
    { header: 'Unit', example: 'pcs' },
    { header: 'Standard Cost', example: '450' },
    { header: 'List Price', example: '', hint: "The partner's published price — a price, not a cost" },
    { header: 'List Currency', example: '', hint: 'Three-letter code; blank means the company currency' },
    { header: 'List Price As Of', example: '', hint: 'YYYY-MM-DD' },
    { header: 'Stocked', example: 'Yes' },
    { header: 'Min Stock', example: '10' },
    { header: 'Reorder Level', example: '20' },
    { header: 'Preferred Supplier', example: '', hint: 'Must match a supplier name or a partner brand' },
    { header: 'Active', example: 'Yes' },
    { header: 'Notes', example: '' },
  ],
  existing: async (row) => {
    const found = await prisma.item.findUnique({ where: { code: row['Code'] } });
    return found?.id ?? null;
  },
  build: async (row) => {
    let categoryId: string | null = null;
    if (row['Category']) {
      const cat = await prisma.itemCategory.findFirst({
        where: { name: { equals: row['Category'], mode: 'insensitive' } },
      });
      if (!cat) throw new Error(`Item category "${row['Category']}" does not exist`);
      categoryId = cat.id;
    }

    let costCategoryId: string | null = null;
    if (row['Cost Category']) {
      const cc = await prisma.costCategory.findFirst({
        where: { name: { equals: row['Cost Category'], mode: 'insensitive' } },
      });
      if (!cc) throw new Error(`Cost category "${row['Cost Category']}" does not exist`);
      costCategoryId = cc.id;
    }

    let supplierId: string | null = null;
    if (row['Preferred Supplier']) {
      // Name OR brand, so a partner's price-list spreadsheet can say "Atlas
      // Copco" rather than the registered name. Two rows matching (a principal
      // and its local distributor both branded the same) is refused rather
      // than picked silently.
      const matches = await prisma.supplier.findMany({
        where: {
          OR: [
            { name: { equals: row['Preferred Supplier'], mode: 'insensitive' } },
            { brand: { equals: row['Preferred Supplier'], mode: 'insensitive' } },
          ],
        },
        select: { id: true, code: true, name: true },
        take: 3,
      });
      if (matches.length === 0) throw new Error(`Supplier "${row['Preferred Supplier']}" does not exist`);
      if (matches.length > 1) {
        throw new Error(
          `Supplier "${row['Preferred Supplier']}" matches more than one record (${matches
            .map((m) => `${m.code} ${m.name}`)
            .join('; ')}) — use the registered name`,
        );
      }
      supplierId = matches[0].id;
    }

    const std = decimal(row, 'Standard Cost');
    const list = decimal(row, 'List Price');
    const listCurrency = optional(row, 'List Currency');
    if (listCurrency && !/^[A-Za-z]{3}$/.test(listCurrency)) {
      throw new Error(`List Currency "${listCurrency}" should be a three-letter code such as USD`);
    }
    const listAsOf = date(row, 'List Price As Of');
    const min = decimal(row, 'Min Stock');
    const reorder = decimal(row, 'Reorder Level');

    return {
      code: required(row, 'Code'),
      name: required(row, 'Name'),
      partNumber: optional(row, 'Part Number'),
      brand: optional(row, 'Brand'),
      description: optional(row, 'Description'),
      itemType: oneOf(row, 'Type', ITEM_TYPES, 'MATERIAL'),
      category: categoryId ? { connect: { id: categoryId } } : undefined,
      costCategory: costCategoryId ? { connect: { id: costCategoryId } } : undefined,
      preferredSupplier: supplierId ? { connect: { id: supplierId } } : undefined,
      unit: row['Unit'] || 'pcs',
      standardCost: std != null ? new Prisma.Decimal(std) : null,
      listPrice: list != null ? new Prisma.Decimal(list) : null,
      listPriceCurrency: listCurrency ? listCurrency.toUpperCase() : null,
      listPriceAsOf: listAsOf,
      isStocked: bool(row, 'Stocked'),
      minStock: min != null ? new Prisma.Decimal(min) : null,
      reorderLevel: reorder != null ? new Prisma.Decimal(reorder) : null,
      isActive: bool(row, 'Active'),
      notes: optional(row, 'Notes'),
    };
  },
};

// ── Wiring ───────────────────────────────────────────────────────────────────

export interface Registered {
  spec: ImportSpec<never>;
  permission: string;
  /**
   * `actor` is who pressed Import, for a writer that files audit rows of its
   * own (the SCORO quotes); `options` is the person's answer to what the dry
   * run's `extra` asked (the SCORO quotes' groups), sent with the commit.
   */
  write: (
    records: { record: never; existingId: string | null }[],
    actor?: ImportActor,
    options?: Record<string, unknown>,
  ) => Promise<void>;
}

/**
 * The customer writer — exported, with the spec, so verify-masters.ts drives
 * exactly what the route runs rather than a copy that can drift from it.
 */
export async function customerWrite(
  records: { record: Prisma.CustomerCreateInput; existingId: string | null }[],
): Promise<void> {
  for (const { record, existingId } of records) {
    await prisma.$transaction(async (tx) => {
      if (existingId) {
        // Nested creates would duplicate the contact and site on every
        // re-import, so an update touches the customer's own fields only.
        const { contacts, sites, code, ...fields } = record;
        void contacts;
        void sites;
        void code;
        await tx.customer.update({ where: { id: existingId }, data: fields });
      } else {
        await tx.customer.create({
          data: { ...record, code: record.code || (await nextNumber('customer', tx)) },
        });
      }
    });
  }
}

/** The item writer — exported for the same reason as customerWrite. */
export async function itemWrite(
  records: { record: Prisma.ItemCreateInput; existingId: string | null }[],
): Promise<void> {
  for (const { record, existingId } of records) {
    if (existingId) {
      const { code, ...fields } = record;
      void code;
      await prisma.item.update({ where: { id: existingId }, data: fields });
    } else {
      const made = await prisma.item.create({ data: record });
      await placeOnShelf(prisma, [made.id]);
    }
  }
}

const REGISTRY: Record<string, Registered> = {
  customers: {
    spec: customerSpec as ImportSpec<never>,
    permission: 'gops.customers.create',
    write: customerWrite as unknown as Registered['write'],
  },
  suppliers: {
    spec: supplierSpec as ImportSpec<never>,
    permission: 'gchain.suppliers.create',
    write: async (records) => {
      for (const { record, existingId } of records as unknown as {
        record: Prisma.SupplierCreateInput;
        existingId: string | null;
      }[]) {
        await prisma.$transaction(async (tx) => {
          if (existingId) {
            const { contacts, code, ...fields } = record;
            void contacts;
            void code;
            await tx.supplier.update({ where: { id: existingId }, data: fields });
          } else {
            await tx.supplier.create({
              data: { ...record, code: record.code || (await nextNumber('supplier', tx)) },
            });
          }
        });
      }
    },
  },
  employees: employeesImport,
  partners: {
    spec: partnerSpec as ImportSpec<never>,
    permission: 'gops.partners.create',
    write: partnerWrite as unknown as Registered['write'],
  },
  items: {
    spec: itemSpec as ImportSpec<never>,
    permission: 'gchain.items.create',
    write: itemWrite as unknown as Registered['write'],
  },
  courses: courseImport,
  // SCORO's own quotes export, as it comes (2026-10-11): a real quotation per row.
  scoro_quotes: scoroQuotesImport,
  // SCORO's invoices export (2026-10-17): a real sales order per invoice, on its quotation.
  scoro_invoices: scoroInvoicesImport,
  // Odoo's product export, as it comes (2026-10-25): the products and their
  // opening stock, and — from the same file — the assets and tools for G-HR.
  odoo_inventory: odooInventoryImport,
  odoo_assets: odooAssetsImport,
  // Odoo's product pictures (2026-10-25), base64 in the CSV, onto the items and assets.
  odoo_pictures: odooPicturesImport,
};

importRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json(
      Object.entries(REGISTRY).map(([key, r]) => ({
        entity: key,
        label: r.spec.label,
        permission: r.permission,
        columns: r.spec.columns,
      })),
    );
  }),
);

importRoutes.get(
  '/:entity/template',
  handler(async (req, res) => {
    const entry = REGISTRY[req.params.entity];
    if (!entry) throw notFound('Unknown import type');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gcore-${req.params.entity}-template.csv"`,
    );
    // BOM so Excel opens it as UTF-8 rather than mangling accented names.
    res.send(`﻿${templateFor(entry.spec)}`);
  }),
);

importRoutes.post(
  '/:entity',
  (req, res, next) => {
    // Odoo's own exports are big (2026-10-25: the owner's product export ran
    // past 8 MB and read "Something went wrong"); they take the pictures'
    // ceiling, and a file past any ceiling is said in words.
    const large = LARGE_IMPORTS.has(req.params.entity);
    (large ? pictureUpload : upload).single('file')(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        const mb = large ? PICTURE_UPLOAD_MB : IMPORT_UPLOAD_MB;
        next(badRequest(`That file is larger than ${mb} MB — split it into smaller files${large ? ' (a few hundred products each), or export it without the picture column' : ''} and import them one after another`));
        return;
      }
      next(err);
    });
  },
  handler(async (req, res) => {
    const entry = REGISTRY[req.params.entity];
    if (!entry) throw notFound('Unknown import type');

    const me = currentUser(req);
    const { can } = await import('../permissions/resolve');
    if (!can(me, entry.permission)) {
      throw badRequest(`You need "${entry.permission}" to import ${entry.spec.label.toLowerCase()}`);
    }

    if (!req.file) throw badRequest('Choose a CSV file');
    const commit = req.query.commit === 'true' || req.body?.commit === 'true';
    // The answers to what the dry run asked (`extra`), as JSON beside the file.
    let options: Record<string, unknown> | undefined;
    if (typeof req.body?.options === 'string' && req.body.options.trim()) {
      try {
        const parsed: unknown = JSON.parse(req.body.options);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) options = parsed as Record<string, unknown>;
      } catch {
        throw badRequest('The import options are not readable');
      }
    }

    // Decoded from whatever the file was written in (SCORO's export is
    // UTF-16), never read as UTF-8 and hoped for.
    const report = await runImport(
      decodeCsv(req.file.buffer),
      entry.spec,
      commit,
      (records) => entry.write(records, { id: me.id, name: me.name }, options),
    );

    if (report.committed) {
      await audit(
        {
          entityType: entry.spec.entity,
          entityId: 'import',
          action: 'CREATED',
          summary: `Imported ${entry.spec.label}: ${report.created} created, ${report.updated} updated`,
        },
        req,
      );
    }

    res.json(report);
  }),
);
