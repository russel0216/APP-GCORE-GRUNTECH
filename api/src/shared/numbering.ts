import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, notFound } from '../http/kit';

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
 *
 * A counter has a PERIOD (one row per year, per month, or forever) and a
 * SCOPE: GLOBAL shares that row across the company, OWNER gives each author
 * their own. The quotation is the live example — the business already numbers
 * quotations `<employee><yy><mm><seq>`, so each salesperson's run restarts
 * monthly and never collides with a colleague's because the pattern carries
 * `{EMP}`. An OWNER counter without `{EMP}` in its pattern is refused for
 * exactly that reason: two people would be issued the same number.
 *
 * The template row is always the one with periodKey ''. Counter rows are
 * created from it on first use, keyed `2026`, `2026-09` or `2026-09@007`.
 */
export type Period = 'YEAR' | 'MONTH' | 'NONE';
export type Scope = 'GLOBAL' | 'OWNER';

export interface NumberContext {
  /** When the document is dated; defaults to now. Never a positional Date. */
  at?: Date;
  /** The author's user id — resolved to their employee number for `{EMP}`. */
  ownerId?: string;
  /** An employee number already in hand; saves the lookup and wins over ownerId. */
  employeeNo?: string | null;
}

export interface DocumentTypeDef {
  type: string;
  code: string;
  label: string;
  /** What the seed creates when no template row exists yet. The stock default is
   *  `{PREFIX}-{TYPE}-{YYYY}-{SEQ}`, padding 4, YEAR, GLOBAL. */
  defaults?: { pattern: string; padding: number; period: Period; scope: Scope };
}

export const DOCUMENT_TYPES: DocumentTypeDef[] = [
  // Master record codes. Not documents, but they benefit from the same
  // configurable, collision-free machinery — and an operator can always
  // override the suggestion with their own scheme.
  { type: 'customer', code: 'CUST', label: 'Customer code' },
  { type: 'supplier', code: 'SUPP', label: 'Supplier code' },
  { type: 'employee', code: 'EMP', label: 'Employee number' },
  { type: 'item', code: 'ITM', label: 'Item code' },
  { type: 'position', code: 'POS', label: 'Position code' },

  { type: 'lead', code: 'LEAD', label: 'Lead' },
  // The house scheme: author's employee digits, year, month, running number.
  // The count runs through the YEAR and restarts each January, as it did in
  // SCORO — `0012609059` is employee 001's 59th quotation of 2026, issued in
  // September. The month is printed, never counted.
  {
    type: 'quotation',
    code: 'QT',
    label: 'Quotation',
    defaults: { pattern: '{EMP}{YY}{MM}{SEQ}', padding: 3, period: 'YEAR', scope: 'OWNER' },
  },
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
  { type: 'cash_advance', code: 'CA', label: 'Cash Advance' },
  { type: 'installed_asset', code: 'AST', label: 'Installed Asset' },
  { type: 'service_contract', code: 'SC', label: 'Service Contract' },
  { type: 'service_visit', code: 'SV', label: 'Service Visit' },
  { type: 'job_order', code: 'JO', label: 'Job Order' },
  { type: 'commissioning_report', code: 'CR', label: 'Commissioning Report' },
  { type: 'pm_report', code: 'PM', label: 'Preventive Maintenance Report' },
  { type: 'inspection_report', code: 'SR', label: 'Service Inspection Report' },
  { type: 'leave_request', code: 'LV', label: 'Leave Request' },
  { type: 'overtime_request', code: 'OT', label: 'Overtime Request' },
  { type: 'clearance', code: 'CLR', label: 'Employee Clearance' },
  { type: 'meeting', code: 'MTG', label: 'Meeting' },
  { type: 'evaluation', code: 'EVAL', label: 'Employee Evaluation' },
  { type: 'training_session', code: 'TS', label: 'Training Session' },
  { type: 'training_certification', code: 'TC', label: 'Training Certification' },
];

/** `2026` for a yearly counter, `2026-09` for a monthly one, '' for a flat one. */
export function periodKeyFor(period: Period, at: Date): string {
  const yyyy = String(at.getFullYear());
  if (period === 'YEAR') return yyyy;
  if (period === 'MONTH') return `${yyyy}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  return '';
}

/** The period key, with the author's token appended for an OWNER counter. */
export function scopedPeriodKey(period: Period, scope: Scope, at: Date, emp: string): string {
  return periodKeyFor(period, at) + (scope === 'OWNER' ? `@${emp}` : '');
}

/**
 * The `{EMP}` token: the last run of digits in the employee number, padded to
 * three. `GT-EMP-2026-0007` → `007`, `12` → `012`, `1234` → `1234`. An author
 * with no employee record — an admin login, an import — is `000`.
 */
export function employeeToken(employeeNo: string | null | undefined): string {
  const digits = employeeNo?.match(/(\d+)(?!.*\d)/)?.[1];
  // Leading zeros are the OLD padding (GT-EMP-2026-0007 is employee 7), so
  // they go before the three-digit padding is applied; a number wider than
  // three digits is kept whole rather than truncated.
  return String(Number(digits ?? '0')).padStart(3, '0');
}

/**
 * The employee number behind a login. The Employee record wins over the
 * cosmetic `User.employeeNo`, because the Employee is the person.
 */
export async function employeeNoFor(
  userId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const employee = await tx.employee.findUnique({ where: { userId }, select: { employeeNo: true } });
  if (employee?.employeeNo) return employee.employeeNo;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { employeeNo: true } });
  return user?.employeeNo ?? null;
}

/** The one token chain. Everything that renders a number goes through here. */
export function renderPattern(
  pattern: string,
  v: { prefix: string; typeCode: string; seq: number; padding: number; at: Date; emp: string },
): string {
  const yyyy = String(v.at.getFullYear());
  const tokens: Record<string, string> = {
    PREFIX: v.prefix,
    TYPE: v.typeCode,
    YYYY: yyyy,
    YY: yyyy.slice(-2),
    MM: String(v.at.getMonth() + 1).padStart(2, '0'),
    EMP: v.emp,
    SEQ: String(v.seq).padStart(v.padding, '0'),
  };
  return pattern.replace(/\{(PREFIX|TYPE|YYYY|YY|MM|EMP|SEQ)\}/g, (_, token: string) => tokens[token]);
}

/**
 * The template row for a document type, and what its next number needs.
 *
 * The template is the periodKey '' row. An unfiltered findFirst used to be
 * able to return one of the year rows instead — same pattern, but a counter's
 * lastNumber and periodKey, which is not what a template is for.
 */
async function templateFor(
  documentType: string,
  tx: Prisma.TransactionClient,
  ctx: NumberContext,
  opts: { resolveAuthor?: boolean } = {},
) {
  const template =
    (await tx.numberSequence.findFirst({ where: { documentType, periodKey: '' } })) ??
    (await tx.numberSequence.findFirst({ where: { documentType } }));
  if (!template) throw notFound(`No numbering configured for "${documentType}"`);

  const period = template.period as Period;
  const scope = template.scope as Scope;
  const usesEmp = template.pattern.includes('{EMP}');
  if (scope === 'OWNER' && !usesEmp) {
    throw badRequest(
      'A per-employee counter needs {EMP} in the pattern, or two people will be issued the same number',
    );
  }

  // The lookup is only paid for when the number needs it — or when a preview
  // wants to tell the author whether they are linked to an employee at all.
  let employeeNo: string | null = null;
  if (scope === 'OWNER' || usesEmp || opts.resolveAuthor) {
    employeeNo = ctx.employeeNo ?? (ctx.ownerId ? await employeeNoFor(ctx.ownerId, tx) : null);
  }
  const emp = scope === 'OWNER' || usesEmp ? employeeToken(employeeNo) : '000';

  return { template, period, scope, emp, employeeNo };
}

async function prefixFor(tx: Prisma.TransactionClient): Promise<string> {
  const company = await tx.company.findUnique({ where: { id: 'company' } });
  return company?.numberPrefix ?? 'GT';
}

/**
 * Reserves the next number for a document type.
 *
 * Runs inside a transaction and uses an atomic increment, so two users
 * creating a quotation at the same moment cannot be handed the same number.
 * Call this from inside the caller's own transaction where one exists, so a
 * rollback does not burn a number.
 */
export async function nextNumber(
  documentType: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: NumberContext = {},
): Promise<string> {
  const at = ctx.at ?? new Date();
  const { template, period, scope, emp } = await templateFor(documentType, tx, ctx);

  // Decided before anything is written: the key names the row the increment
  // lands on, and an OWNER key carries the author.
  const periodKey = scopedPeriodKey(period, scope, at, emp);

  // Upsert-then-increment: the unique key is (documentType, periodKey), so the
  // first document of a new period creates that period's row and everyone
  // after increments it. Kept flat — no nested writes — so Prisma emits a
  // native INSERT … ON CONFLICT rather than a read-then-write.
  const seq = await tx.numberSequence.upsert({
    where: { documentType_periodKey: { documentType, periodKey } },
    create: {
      documentType,
      label: template.label,
      pattern: template.pattern,
      typeCode: template.typeCode,
      period: template.period,
      scope: template.scope,
      periodKey,
      padding: template.padding,
      lastNumber: 1,
    },
    update: { lastNumber: { increment: 1 } },
  });

  return renderPattern(seq.pattern, {
    prefix: await prefixFor(tx),
    typeCode: seq.typeCode,
    seq: seq.lastNumber,
    padding: seq.padding,
    at,
    emp,
  });
}

/** Renders what the next number would look like, without consuming it. */
export function previewNumber(
  opts: { pattern: string; typeCode: string; padding: number; lastNumber: number; emp?: string },
  prefix: string,
  at: Date = new Date(),
): string {
  return renderPattern(opts.pattern, {
    prefix,
    typeCode: opts.typeCode,
    seq: opts.lastNumber + 1,
    padding: opts.padding,
    at,
    emp: opts.emp ?? '000',
  });
}

/**
 * The number `nextNumber` would issue next for this author, without reserving
 * it — the same template and scoped-counter lookup, and no upsert. What a form
 * shows before it is saved; the saved number can still differ if someone else
 * gets there first, which is the point of reserving inside the transaction.
 */
export async function previewNext(
  documentType: string,
  ctx: NumberContext = {},
  tx: Prisma.TransactionClient = prisma,
  /**
   * Where numbers may also be typed by hand (the quotation's), the preview
   * steps past any already taken — the same ones `nextNumber`'s caller skips.
   */
  isTaken?: (number: string) => Promise<boolean>,
): Promise<{ number: string; employeeNo: string | null; linked: boolean; periodKey: string }> {
  const at = ctx.at ?? new Date();
  const { template, period, scope, emp, employeeNo } = await templateFor(documentType, tx, ctx, {
    resolveAuthor: true,
  });
  const periodKey = scopedPeriodKey(period, scope, at, emp);

  // For a NONE period with GLOBAL scope the template row IS the counter.
  const counter =
    periodKey === template.periodKey
      ? template
      : await tx.numberSequence.findUnique({
          where: { documentType_periodKey: { documentType, periodKey } },
        });

  const prefix = await prefixFor(tx);
  const render = (seq: number) =>
    renderPattern(template.pattern, { prefix, typeCode: template.typeCode, seq, padding: template.padding, at, emp });
  let seq = (counter?.lastNumber ?? 0) + 1;
  let number = render(seq);
  // A bounded walk: a run of 200 hand-typed numbers ahead of the counter is
  // not a series anyone means to continue.
  for (let tries = 0; isTaken && tries < 200 && (await isTaken(number)); tries++) number = render(++seq);

  return {
    number,
    employeeNo,
    linked: employeeNo !== null,
    periodKey,
  };
}
