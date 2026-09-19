import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { notFound } from '../http/kit';

/**
 * Document numbering (model §7).
 *
 * Patterns are data, not code: `{PREFIX}-{TYPE}-{YYYY}-{SEQ}` produces
 * GT-QT-2026-0001. The company prefix comes from Company.numberPrefix so a
 * second company could never collide with Gruntech's numbers.
 *
 * Every document type in the whole system is registered up front — including
 * types whose modules ship in later phases — so numbering is configured once
 * and never becomes an afterthought bolted onto each new module.
 */
export const DOCUMENT_TYPES: { type: string; code: string; label: string }[] = [
  // Master record codes. Not documents, but they benefit from the same
  // configurable, collision-free machinery — and an operator can always
  // override the suggestion with their own scheme.
  { type: 'customer', code: 'CUST', label: 'Customer code' },
  { type: 'supplier', code: 'SUPP', label: 'Supplier code' },
  { type: 'employee', code: 'EMP', label: 'Employee number' },
  { type: 'item', code: 'ITM', label: 'Item code' },

  { type: 'lead', code: 'LEAD', label: 'Lead' },
  { type: 'quotation', code: 'QT', label: 'Quotation' },
  { type: 'costing', code: 'COST', label: 'Costing' },
  { type: 'project', code: 'PRJ', label: 'Project' },
  { type: 'budget_request', code: 'BR', label: 'Budget Request' },
  { type: 'purchase_request', code: 'PR', label: 'Purchase Request' },
  { type: 'canvass', code: 'RFQ', label: 'Canvass / RFQ' },
  { type: 'purchase_order', code: 'PO', label: 'Purchase Order' },
  { type: 'receiving', code: 'RR', label: 'Receiving Report' },
  { type: 'stock_issue', code: 'SI', label: 'Stock Issuance' },
  { type: 'borrow_slip', code: 'BS', label: 'Borrow Slip' },
  { type: 'progress_report', code: 'PGR', label: 'Progress Report' },
  { type: 'progress_billing', code: 'PB', label: 'Progress Billing' },
  { type: 'invoice', code: 'INV', label: 'Invoice' },
  { type: 'supplier_bill', code: 'BILL', label: 'Supplier Bill' },
  { type: 'payment', code: 'RCPT', label: 'Payment Receipt' },
  { type: 'disbursement', code: 'DV', label: 'Disbursement Voucher' },
  { type: 'expense', code: 'EXP', label: 'Expense Claim' },
  { type: 'service_contract', code: 'SC', label: 'Service Contract' },
  { type: 'commissioning_report', code: 'CR', label: 'Commissioning Report' },
  { type: 'pm_report', code: 'PM', label: 'Preventive Maintenance Report' },
  { type: 'inspection_report', code: 'SR', label: 'Service Inspection Report' },
  { type: 'leave_request', code: 'LV', label: 'Leave Request' },
  { type: 'overtime_request', code: 'OT', label: 'Overtime Request' },
];

function periodKeyFor(period: 'YEAR' | 'NONE', at: Date): string {
  return period === 'YEAR' ? String(at.getFullYear()) : '';
}

/**
 * Reserves the next number for a document type.
 *
 * Runs inside a transaction and uses an atomic increment, so two users
 * creating a quotation at the same moment cannot be handed the same number.
 * Call this from inside the caller's own transaction where one exists.
 */
export async function nextNumber(
  documentType: string,
  tx: Prisma.TransactionClient = prisma,
  at: Date = new Date(),
): Promise<string> {
  const template = await tx.numberSequence.findFirst({ where: { documentType } });
  if (!template) throw notFound(`No numbering configured for "${documentType}"`);

  const periodKey = periodKeyFor(template.period, at);

  // Upsert-then-increment: the unique key is (documentType, periodKey), so the
  // first document of a new year creates that year's row and everyone after
  // increments it.
  const seq = await tx.numberSequence.upsert({
    where: { documentType_periodKey: { documentType, periodKey } },
    create: {
      documentType,
      label: template.label,
      pattern: template.pattern,
      typeCode: template.typeCode,
      period: template.period,
      periodKey,
      padding: template.padding,
      lastNumber: 1,
    },
    update: { lastNumber: { increment: 1 } },
  });

  const company = await tx.company.findUnique({ where: { id: 'company' } });
  const prefix = company?.numberPrefix ?? 'GT';

  return seq.pattern
    .replace('{PREFIX}', prefix)
    .replace('{TYPE}', seq.typeCode)
    .replace('{YYYY}', String(at.getFullYear()))
    .replace('{YY}', String(at.getFullYear()).slice(-2))
    .replace('{MM}', String(at.getMonth() + 1).padStart(2, '0'))
    .replace('{SEQ}', String(seq.lastNumber).padStart(seq.padding, '0'));
}

/** Renders what the next number would look like, without consuming it. */
export function previewNumber(
  opts: { pattern: string; typeCode: string; padding: number; lastNumber: number },
  prefix: string,
  at: Date = new Date(),
): string {
  return opts.pattern
    .replace('{PREFIX}', prefix)
    .replace('{TYPE}', opts.typeCode)
    .replace('{YYYY}', String(at.getFullYear()))
    .replace('{YY}', String(at.getFullYear()).slice(-2))
    .replace('{MM}', String(at.getMonth() + 1).padStart(2, '0'))
    .replace('{SEQ}', String(opts.lastNumber + 1).padStart(opts.padding, '0'));
}
