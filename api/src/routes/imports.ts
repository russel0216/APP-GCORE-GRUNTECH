import { Router } from 'express';
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
  required,
  optional,
  decimal,
  bool,
  oneOf,
  type ImportSpec,
} from '../shared/csv';
import { employeesImport } from './imports/employees';

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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// ── Specs ────────────────────────────────────────────────────────────────────

const customerSpec: ImportSpec<Prisma.CustomerCreateInput> = {
  entity: 'customers',
  label: 'Customers',
  columns: [
    { header: 'Name', required: true, example: 'Sample Hospital Inc.' },
    { header: 'Code', example: '', hint: 'Leave blank to auto-generate' },
    { header: 'Legal Name', example: 'Sample Hospital Incorporated' },
    { header: 'TIN', example: '000-123-456-000' },
    { header: 'Industry', example: 'Healthcare' },
    { header: 'Payment Terms', example: '30 days' },
    { header: 'Credit Limit', example: '500000' },
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
    paymentTerms: optional(row, 'Payment Terms'),
    creditLimit: decimal(row, 'Credit Limit'),
    phone: optional(row, 'Phone'),
    email: optional(row, 'Email'),
    website: optional(row, 'Website'),
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

const ITEM_TYPES = ['MATERIAL', 'EQUIPMENT', 'CONSUMABLE', 'SERVICE', 'TOOL'] as const;

const itemSpec: ImportSpec<Prisma.ItemCreateInput> = {
  entity: 'items',
  label: 'Items',
  columns: [
    { header: 'Code', required: true, example: 'PIP-SS-050' },
    { header: 'Name', required: true, example: 'Stainless pipe 1/2"' },
    { header: 'Part Number', example: 'SS304-050' },
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
    { header: 'Stocked', example: 'Yes' },
    { header: 'Min Stock', example: '10' },
    { header: 'Reorder Level', example: '20' },
    { header: 'Preferred Supplier', example: '', hint: 'Must match a supplier name' },
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
      const sup = await prisma.supplier.findFirst({
        where: { name: { equals: row['Preferred Supplier'], mode: 'insensitive' } },
      });
      if (!sup) throw new Error(`Supplier "${row['Preferred Supplier']}" does not exist`);
      supplierId = sup.id;
    }

    const std = decimal(row, 'Standard Cost');
    const min = decimal(row, 'Min Stock');
    const reorder = decimal(row, 'Reorder Level');

    return {
      code: required(row, 'Code'),
      name: required(row, 'Name'),
      partNumber: optional(row, 'Part Number'),
      description: optional(row, 'Description'),
      itemType: oneOf(row, 'Type', ITEM_TYPES, 'MATERIAL'),
      category: categoryId ? { connect: { id: categoryId } } : undefined,
      costCategory: costCategoryId ? { connect: { id: costCategoryId } } : undefined,
      preferredSupplier: supplierId ? { connect: { id: supplierId } } : undefined,
      unit: row['Unit'] || 'pcs',
      standardCost: std != null ? new Prisma.Decimal(std) : null,
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
  write: (records: { record: never; existingId: string | null }[]) => Promise<void>;
}

const REGISTRY: Record<string, Registered> = {
  customers: {
    spec: customerSpec as ImportSpec<never>,
    permission: 'gops.customers.create',
    write: async (records) => {
      for (const { record, existingId } of records as unknown as {
        record: Prisma.CustomerCreateInput;
        existingId: string | null;
      }[]) {
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
    },
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
  items: {
    spec: itemSpec as ImportSpec<never>,
    permission: 'gchain.items.create',
    write: async (records) => {
      for (const { record, existingId } of records as unknown as {
        record: Prisma.ItemCreateInput;
        existingId: string | null;
      }[]) {
        if (existingId) {
          const { code, ...fields } = record;
          void code;
          await prisma.item.update({ where: { id: existingId }, data: fields });
        } else {
          await prisma.item.create({ data: record });
        }
      }
    },
  },
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
  upload.single('file'),
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

    const report = await runImport(
      req.file.buffer.toString('utf8'),
      entry.spec,
      commit,
      entry.write,
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
