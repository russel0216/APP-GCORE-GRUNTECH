import { Prisma, type NumberSequence } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest, conflict, notFound } from '../http/kit';

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
 * each January (the month is printed, never counted) and never collides with
 * a colleague's because the pattern carries `{EMP}`. An OWNER counter without `{EMP}` in its pattern is refused for
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
  // Follow-on orders for one quotation carry a decimal suffix (4622.1) the
  // route appends; only the base number comes from this counter.
  { type: 'sales_order', code: 'SO', label: 'Sales Order' },
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
  // The design team's request (2026-10-09): GT-CJO-2026-0001 on the stock pattern.
  { type: 'cad_job_order', code: 'CJO', label: 'CAD Job Order' },
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

/** The fields a counter row copies from its template. Those of the one row with periodKey ''. */
type CounterTemplate = Pick<NumberSequence, 'documentType' | 'label' | 'pattern' | 'typeCode' | 'period' | 'scope' | 'padding'>;

/**
 * A counter row, made from its template: the ONE copy of the template's
 * fields, used wherever a counter row is created (`nextNumber`'s first number
 * of a period, `setCounter`'s typed one) — a second copy of this block would
 * be a second place for a template field to be forgotten.
 */
function counterCreate(template: CounterTemplate, periodKey: string, lastNumber: number) {
  return {
    documentType: template.documentType,
    label: template.label,
    pattern: template.pattern,
    typeCode: template.typeCode,
    period: template.period,
    scope: template.scope,
    periodKey,
    padding: template.padding,
    lastNumber,
  };
}

/**
 * Reserves the next number for a document type.
 *
 * Runs inside a transaction and uses an atomic increment, so two users
 * creating a quotation at the same moment cannot be handed the same number.
 * Call this from inside the caller's own transaction where one exists, so a
 * rollback does not burn a number.
 *
 * Where numbers may also be typed by hand (the quotation's), `isTaken` says
 * which are: the number issued is the first past the counter that nobody
 * holds, and the counter lands ON it, as the increment alone would have left
 * it. The candidates are rendered here and asked about one by one — ONE read
 * each and one write at the end (the review of 2026-10-10: the walk used to
 * re-run the whole issue per candidate, five round trips each, and a
 * thousand of those outran the transaction's five seconds before the 409
 * could be reached — the save then answered 500). The increment has locked
 * the row for this transaction, so a colleague's save waits on it exactly as
 * before. Past `FREE_NUMBER_TRIES` taken in a row the issue is a 409 naming
 * Admin › Numbering, which rolls back with the caller's transaction.
 */
export async function nextNumber(
  documentType: string,
  tx: Prisma.TransactionClient = prisma,
  ctx: NumberContext = {},
  isTaken?: (number: string) => Promise<boolean>,
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
    create: counterCreate(template, periodKey, 1),
    update: { lastNumber: { increment: 1 } },
  });

  const prefix = await prefixFor(tx);
  const render = (n: number) =>
    renderPattern(seq.pattern, { prefix, typeCode: seq.typeCode, seq: n, padding: seq.padding, at, emp });
  let place = seq.lastNumber;
  let number = render(place);
  if (isTaken) {
    for (let tries = 0; await isTaken(number); tries++) {
      if (tries >= FREE_NUMBER_TRIES) {
        throw conflict(
          `No free ${seq.label.toLowerCase()} number within ${FREE_NUMBER_TRIES.toLocaleString('en-US')} of the series — set the counter in Admin › Numbering`,
        );
      }
      number = render(++place);
    }
    if (place !== seq.lastNumber) {
      await tx.numberSequence.update({
        where: { documentType_periodKey: { documentType, periodKey } },
        data: { lastNumber: place },
      });
    }
  }
  return number;
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
  // A bounded walk, on the same budget as the issue (`FREE_NUMBER_TRIES`): a
  // run of a thousand taken numbers ahead of the counter is not a series
  // anyone means to continue. The preview stops on the last one tried; the
  // save behind it is what refuses.
  for (let tries = 0; isTaken && tries < FREE_NUMBER_TRIES && (await isTaken(number)); tries++) number = render(++seq);

  return {
    number,
    employeeNo,
    linked: employeeNo !== null,
    periodKey,
  };
}

/**
 * How far past the counter a free number is looked for, where numbers may
 * also be typed by hand (the quotation's). A typed number moves its series
 * (below), so the walk only meets numbers a LOWERED series lands on again or
 * numbers typed under a colleague's digits; a thousand of them in a row is a
 * counter somebody has to set by hand, and the issue says so (409). The
 * walk is `nextNumber(…, isTaken)`'s and `previewNext(…, isTaken)`'s, on
 * the same budget, so the preview and the save agree.
 */
export const FREE_NUMBER_TRIES = 1000;

/** What `parseNumber` reads off a number: the counter row it sits in, and its place in it. */
export interface ParsedNumber {
  /** The counter row's key — `2026`, `2026-09@001`, '' for a flat company-wide counter. */
  periodKey: string;
  seq: number;
  /** The `{EMP}` digits as a counter keys them (`employeeToken`), where the pattern has the token. */
  emp?: string;
  year?: number;
  month?: number;
}

const PATTERN_TOKEN = /\{(PREFIX|TYPE|YYYY|YY|MM|EMP|SEQ)\}/g;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

/**
 * Reads a number back through the template's own pattern — the one parser,
 * the inverse of `renderPattern` (2026-10-10, the owner's call: "remember the
 * manual edit, start there from the last edit"): a number typed by hand names
 * the series it belongs to by its OWN year, month and employee digits, and
 * `setCounter` moves that series. Null for a number outside the pattern's
 * shape (`ZZQ-12` under `{EMP}{YY}{MM}{SEQ}`), which then moves nothing.
 *
 * The tokens: `{PREFIX}` and `{TYPE}` are the literals, case-blind; `{YYYY}`
 * four digits, `{YY}` two (2000 + YY); `{MM}` 01–12 — the range is IN the
 * expression, so a digit string re-parses under a longer `{EMP}` rather than
 * failing (the 4-digit employee 9871's `98712610001` reads 9871 · 26 · 10 ·
 * 001, not 987 · 12 · 61 · …); `{EMP}` exactly what `employeeToken` yields —
 * three digits, or four or more NOT starting with 0 (a number is padded to
 * three, never wider), the fewest that fit; `{SEQ}` one digit or more with at
 * least one of them not 0 — a hand-typed number need not carry the padding,
 * but a counter never stands at 0 (`nextNumber` makes a row at 1), so place 0
 * is no place. Those two bounds are what keep a TYPO out of another series
 * (the review of 2026-10-10): `0012613060`, a thirteenth month, is null —
 * neither employee 00126's 2013 series at 0 nor, with a 1 at the end, at 1 —
 * `0012610000` is null, and SCORO's 8-digit `12610060` is null rather than
 * employee 12610's 2006 series. Everything else is literal. The period
 * key is the one `scopedPeriodKey` builds, from the number's own tokens:
 * YEAR → `<year>`, MONTH → `<year>-<MM>`, NONE → '', `@<emp>` for an OWNER
 * counter — PER CODE, so a number typed under a colleague's digits moves the
 * colleague's series, which is the number's. A period whose token the pattern
 * lacks (the PUT guard in Admin › Numbering normally prevents it) is null.
 */
export function parseNumber(
  template: { pattern: string; typeCode: string; period: string; scope: string },
  prefix: string,
  number: string,
): ParsedNumber | null {
  const names: string[] = [];
  let source = '^';
  let last = 0;
  for (const m of template.pattern.matchAll(PATTERN_TOKEN)) {
    source += escapeRegExp(template.pattern.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const token = m[1];
    if (token === 'PREFIX') source += escapeRegExp(prefix);
    else if (token === 'TYPE') source += escapeRegExp(template.typeCode);
    else {
      names.push(token);
      source +=
        token === 'YYYY' ? '(\\d{4})'
        : token === 'YY' ? '(\\d{2})'
        : token === 'MM' ? '(0[1-9]|1[0-2])'
        : token === 'EMP' ? '(\\d{3}|[1-9]\\d{3,}?)'
        : '(\\d*[1-9]\\d*)';
    }
  }
  source += escapeRegExp(template.pattern.slice(last)) + '$';
  const m = new RegExp(source, 'i').exec(number.trim());
  if (!m) return null;
  const got: Partial<Record<string, string>> = {};
  names.forEach((name, i) => (got[name] = m[i + 1]));
  if (got.SEQ === undefined) return null;

  // A counter is an Int: a run of digits past it is not a place in a series.
  const seq = Number(got.SEQ);
  if (!Number.isSafeInteger(seq) || seq > 2_147_483_647) return null;
  const year = got.YYYY !== undefined ? Number(got.YYYY) : got.YY !== undefined ? 2000 + Number(got.YY) : undefined;
  const month = got.MM !== undefined ? Number(got.MM) : undefined;
  const emp = got.EMP !== undefined ? employeeToken(got.EMP) : undefined;

  const period = template.period as Period;
  let periodKey = '';
  if (period === 'YEAR') {
    if (year === undefined) return null;
    periodKey = String(year);
  } else if (period === 'MONTH') {
    if (year === undefined || month === undefined) return null;
    periodKey = `${year}-${String(month).padStart(2, '0')}`;
  }
  if ((template.scope as Scope) === 'OWNER') {
    if (emp === undefined) return null;
    periodKey += `@${emp}`;
  }
  return { periodKey, seq, ...(emp !== undefined ? { emp } : {}), ...(year !== undefined ? { year } : {}), ...(month !== undefined ? { month } : {}) };
}

/** What `setCounter` did: the row it moved and where it stood before and after, for the caller's audit row. */
export interface CounterMove {
  periodKey: string;
  seq: number;
  before: number;
  after: number;
}

/**
 * Moves a series to a number somebody typed — the ONE writer of a counter
 * from a number (2026-10-10, the owner's call). `set` writes the number's
 * SEQ whether that raises or lowers the counter ("start there from the last
 * edit"); `raise` writes it only past the counter's own figure — a conditional
 * `updateMany`, the guarantee the old SCORO seeding gave, for the coming
 * upload of SCORO's quotations, whose numbers must leave every series at
 * its highest. A missing row is made from the template through
 * `counterCreate`, as `nextNumber` makes one. Null, and nothing written,
 * for a type with no template or a number outside its pattern's shape.
 *
 * Call it inside the caller's transaction AFTER the number's uniqueness
 * check, so a refused number rolls the counter back with the document.
 */
export async function setCounter(
  documentType: string,
  number: string,
  tx: Prisma.TransactionClient,
  opts: { mode: 'set' | 'raise' },
): Promise<CounterMove | null> {
  const template = await tx.numberSequence.findFirst({ where: { documentType, periodKey: '' } });
  if (!template) return null;
  const parsed = parseNumber(template, await prefixFor(tx), number);
  if (!parsed) return null;
  const { periodKey, seq } = parsed;
  const where = { documentType_periodKey: { documentType, periodKey } };

  const existing = await tx.numberSequence.findUnique({ where, select: { lastNumber: true } });
  const before = existing?.lastNumber ?? 0;
  if (opts.mode === 'set') {
    await tx.numberSequence.upsert({ where, create: counterCreate(template, periodKey, seq), update: { lastNumber: seq } });
  } else {
    // The row first (a no-op update when it exists), then the raise as one
    // conditional write — so two raises at once never lower each other.
    if (!existing) await tx.numberSequence.upsert({ where, create: counterCreate(template, periodKey, seq), update: {} });
    await tx.numberSequence.updateMany({ where: { documentType, periodKey, lastNumber: { lt: seq } }, data: { lastNumber: seq } });
  }
  const row = await tx.numberSequence.findUniqueOrThrow({ where, select: { lastNumber: true } });
  return { periodKey, seq, before, after: row.lastNumber };
}
