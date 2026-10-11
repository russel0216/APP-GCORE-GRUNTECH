import { Prisma, type QuotationOutcome, type RevisionStatus } from '@prisma/client';
import { prisma } from '../../prisma';
import { required, optional, type ImportSpec, type ImportActor } from '../../shared/csv';
import { nextNumber, setCounter, type CounterMove } from '../../shared/numbering';
import { recalcQuotationRevision } from '../../shared/quotation';
import { groupKey, rememberGroups } from '../../shared/quotationGroups';
import { pipelineStages, stageProbability } from '../../shared/pipelineStages';
import { audit } from '../../shared/audit';
import { lineData, QUOTE_NUMBER, type QuotationLineInput } from '../sales';
import type { Registered } from '../imports';

/**
 * SCORO's "quotes export", as SCORO writes it (2026-10-11, the owner's file:
 * "could you add this to the database so I can check if it's possible to
 * migrate data of SCORO from a CSV file"; 2026-10-10: "later I will upload
 * data of SCORO Quotation, it will act as part of the G-CORE"). Each row
 * becomes a REAL quotation — never an archive — through the ordinary import
 * framework: the columns are SCORO's own headers, matched by name, so the
 * file goes in as it comes.
 *
 * `build` RESOLVES and `write` CREATES (the plantilla import's rule, because
 * `runImport` calls build on every dry run): the owner is a login that must
 * already exist, the customer and the contact are found or made, and a
 * quotation whose number is already in G-CORE is left exactly as it is — a
 * quotation in G-CORE is G-CORE's, and a re-run of the same file changes
 * nothing.
 *
 * SCORO's export comes two ways (the owner's two files of 2026-10-11): the
 * header alone, one row per quotation, or WITH the line columns — one row
 * per line, the header repeated on every row. The rows are grouped by
 * `doc_no` (`groupBy` / `buildGroup`, the framework's rule for a record
 * that spans rows). A group with no line content gets ONE summary line
 * worth its subtotal, costed at SCORO's total cost so the margin reads as
 * SCORO's; a group with lines gets them, in file order. The one exception
 * to "left as it is": a quotation that came from the header-only file —
 * revision 0 DRAFT, exactly the summary line — takes the lines file's lines
 * in place of its summary line, the promise the summary line made.
 */

type Tx = Prisma.TransactionClient;

/** SCORO's null date. Treated as empty everywhere. */
const SCORO_NULL_DATE = /^0000-00-00/;

/** The import's own name on every audit row it files. */
const SOURCE = 'the SCORO quotes import';

/**
 * SCORO's statuses → the quotation's outcome. Case-blind, trimmed; an
 * unknown one is an error naming it rather than a guess.
 */
const STATUS_OUTCOME: Record<string, QuotationOutcome> = {
  opportunity: 'OPEN',
  'this month forecast': 'OPEN',
  hold: 'OPEN',
  negotiation: 'SUBMITTED',
  closing: 'NEGOTIATION',
  confirmed: 'WON',
  completed: 'WON',
  'confirmed project': 'WON',
  rejected: 'LOST',
  cancelled: 'LOST',
};

/** A name as it is compared: trimmed, single-spaced, case-blind. */
const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
const sameName = (a: string, b: string) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

/** `(SCORO id 4798)` as the company import wrote it — whole tokens, several ids in one note. */
const SCORO_IDS = /SCORO id\s+(\d+(?:\s*,\s*\d+)*)/gi;
function scoroIdsIn(notes: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const m of (notes ?? '').matchAll(SCORO_IDS)) {
    for (const id of m[1].split(',')) ids.push(id.trim());
  }
  return ids;
}

/** A SCORO date cell: `YYYY-MM-DD` or `YYYY-MM-DD hh:mm:ss`, as the DATE at UTC midnight; the null date and blank are none. */
function scoroDate(row: Record<string, string>, header: string): Date | null {
  const v = (row[header] ?? '').trim();
  if (!v || SCORO_NULL_DATE.test(v)) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`${header} "${v}" is not a date — SCORO writes YYYY-MM-DD`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) throw new Error(`${header} "${v}" is not a date`);
  return date;
}

function scoroDecimal(row: Record<string, string>, header: string): Prisma.Decimal | null {
  const v = (row[header] ?? '').trim();
  if (!v) return null;
  const n = v.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(n)) throw new Error(`${header} "${v}" is not a number`);
  return new Prisma.Decimal(n);
}

/** The whole days from one DATE to another; both at UTC midnight already. */
const daysApart = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

/**
 * The customer a payer names: by SCORO id first (a customer whose notes carry
 * `(SCORO id N)`, the way the company import wrote it), then by name or
 * legal name, case-blind with spaces collapsed. One rule for `build` and for
 * `write`, which looks again inside its transaction — a second row of the
 * same file may have created the customer a moment ago. A customer switched
 * off is used as it is.
 */
async function findCustomer(tx: Tx | typeof prisma, name: string, scoroId: string | null): Promise<{ id: string } | null> {
  if (scoroId) {
    const noted = await tx.customer.findMany({
      where: { notes: { contains: 'SCORO id', mode: 'insensitive' } },
      select: { id: true, notes: true },
      orderBy: { createdAt: 'asc' },
    });
    const byId = noted.find((c) => scoroIdsIn(c.notes).includes(scoroId));
    if (byId) return { id: byId.id };
  }
  const wanted = collapse(name);
  return tx.customer.findFirst({
    where: {
      OR: [{ name: { equals: wanted, mode: 'insensitive' } }, { legalName: { equals: wanted, mode: 'insensitive' } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
}

/** One of the customer's contacts by name, case-blind with spaces collapsed. */
async function findContact(tx: Tx | typeof prisma, customerId: string, name: string): Promise<{ id: string } | null> {
  const contacts = await tx.customerContact.findMany({ where: { customerId }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  return contacts.find((c) => sameName(c.name, name)) ?? null;
}

interface ScoroQuoteRecord {
  /** SCORO's own quote id, kept in the audit row. */
  scoroId: string | null;
  number: string;
  ownerId: string;
  /** Resolved in build; created in write when `id` is null. */
  customer: { id: string | null; name: string; scoroId: string | null };
  /** Resolved in build; created on the customer in write when `id` is null. */
  contact: { id: string | null; name: string } | null;
  outcome: QuotationOutcome;
  probability: number;
  submittedAt: Date | null;
  decidedAt: Date | null;
  lostReason: string | null;
  /** SCORO's doc_date: the issue date, `createdAt` of the quotation and its revision. */
  issuedAt: Date;
  expectedClosing: Date | null;
  validityDays: number;
  subject: string;
  notes: string | null;
  prNumber: string | null;
  delivery: string | null;
  paymentTerms: string | null;
  discountPct: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  revisionStatus: RevisionStatus;
  /** The one summary line: the subtotal before discount, and SCORO's total cost. */
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  group: string | null;
  /** The file's lines, in order, when the export carries them; null for the header-only export. */
  lines: QuotationLineInput[] | null;
}

/** Whether a row of the export carries a line: the lines export names a product, a comment or a line id on every row. */
const hasLineContent = (row: Record<string, string>) => !!(row['product_name'] || row['line_comment'] || row['line_id']);

/**
 * The lines of one quotation's rows, each resolved in the shape `lineData`
 * stores (the summary line's road). SCORO's `product_name` is the whole
 * title — its sentence is not reliably "brand, type, part", so the three
 * product boxes stay empty. SCORO stores the LINE's total cost
 * (`line_cost`), and a line here carries a UNIT cost: `line_cost ÷ amount`
 * to the centavo, from which `lineData` recomputes `costAmount` = qty ×
 * unitCost — a centavo at most from SCORO's figure on a line whose cost does
 * not divide evenly. A supplier or a person SCORO names is matched by name
 * and never created; one not on file is kept in `costNote` so nothing is lost.
 */
async function scoroLines(rows: Record<string, string>[], firstRowNumber: number): Promise<QuotationLineInput[]> {
  const lines: QuotationLineInput[] = [];
  for (const [i, row] of rows.entries()) {
    const where = `line ${i + 1} (row ${firstRowNumber + i}): `;
    const name = collapse(row['product_name'] ?? '');
    if ((row['is_subheading'] ?? '').trim() === '1') {
      if (!name) throw new Error(`${where}a subheading needs its product_name`);
      lines.push({ isHeading: true, title: name, quantity: 0, unit: 'lot', unitPrice: 0 });
      continue;
    }
    const quantity = scoroDecimal(row, 'amount') ?? new Prisma.Decimal(0);
    const price = scoroDecimal(row, 'price') ?? new Prisma.Decimal(0);
    const lineCost = scoroDecimal(row, 'line_cost');
    if (quantity.lt(0) || price.lt(0)) throw new Error(`${where}amount and price cannot be negative`);
    const unitCost = lineCost && lineCost.gt(0) && quantity.gt(0) ? lineCost.div(quantity).toDecimalPlaces(2) : null;

    const notes: string[] = [];
    let providerSupplierId: string | null = null;
    let providerUserId: string | null = null;
    const supplierName = collapse(row['supplier_name'] ?? '');
    const doerName = collapse(row['doer_name'] ?? '');
    const internal = (row['is_internal'] ?? '').trim() === '1';
    if (internal && doerName) {
      const users = await prisma.user.findMany({ select: { id: true, name: true, isActive: true } });
      const named = users.filter((u) => sameName(u.name, doerName));
      providerUserId = (named.find((u) => u.isActive) ?? named[0])?.id ?? null;
      if (!providerUserId) notes.push(`Doer in SCORO: ${doerName}`);
    } else if (supplierName) {
      const supplier = await prisma.supplier.findFirst({
        where: { name: { equals: supplierName, mode: 'insensitive' } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      providerSupplierId = supplier?.id ?? null;
      if (!providerSupplierId) notes.push(`Supplier in SCORO: ${supplierName}`);
    }
    const costComment = (row['cost_comment'] ?? '').trim();
    const costNote = [costComment, ...notes].filter(Boolean).join(' — ') || null;

    lines.push({
      group: collapse(row['product_group'] ?? '') || null,
      title: name || null,
      description: (row['line_comment'] ?? '').trim(),
      quantity: Number(quantity),
      unit: (row['unit'] ?? '').trim() || 'lot',
      unitPrice: Number(price),
      unitCost: unitCost === null ? null : Number(unitCost),
      providerSupplierId,
      providerUserId,
      costNote,
    });
  }
  return lines;
}

const scoroQuoteSpec: ImportSpec<ScoroQuoteRecord> = {
  entity: 'scoro_quotes',
  label: 'SCORO quotations',
  // SCORO's own headers, verbatim. doc_no first: the framework's key column
  // is columns[0]; the file's own column order does not matter.
  columns: [
    {
      header: 'doc_no',
      required: true,
      example: '0012603004',
      hint: 'The quotation number, as SCORO numbered it; the series continues past it. One row per line groups by it. A number already in G-CORE is left as it is — except that a quotation imported from the header-only export (its one "As quoted in SCORO" line, still a draft) takes the lines from a file that carries them',
    },
    {
      header: 'payer',
      required: true,
      example: 'FIRST BALFOUR-LEIGHTON JOINT VENTURE',
      hint: 'The customer — matched by SCORO id in its notes, then by name or legal name; an unknown one is created by name alone',
    },
    { header: 'quote_name', example: 'Tap-off Unit', hint: 'The subject; blank reads "SCORO quote <doc_no>"' },
    { header: 'doc_date', example: '2026-03-11', hint: 'The date of issue (the quotation’s and the revision’s date)' },
    { header: 'doc_deadline', example: '2026-04-10', hint: 'With doc_date, the validity in days; 30 when either is missing' },
    { header: 'owner_name', example: 'Carter Gasiong', hint: 'The author — must be a G-CORE login of that name (Admin › Users)' },
    { header: 'contact_person', example: 'Leo Solis', hint: 'The customer’s contact — matched by name, else added to the customer' },
    { header: 'payer_id', example: '4798', hint: 'SCORO’s customer id, kept as "(SCORO id N)" in a created customer’s notes so the next file matches it' },
    { header: 'doc_description', example: 'Quotation Validity : 120 days', hint: 'The revision’s notes' },
    { header: 'currency', example: 'PHP', hint: 'Must be the company currency; G-CORE prints only that' },
    {
      header: 'status_name',
      example: 'Opportunity',
      hint: 'Opportunity, This Month Forecast, Hold → Open; Negotiation → Submitted; Closing → Negotiation; Confirmed, Completed, Confirmed Project → Won; Rejected, Cancelled → Lost. The stage sets the probability',
    },
    { header: 'status_changed_date', example: '', hint: 'When it was submitted (Submitted, Negotiation, Won, Lost); else doc_date' },
    { header: 'confirmed_date', example: '0000-00-00 00:00:00', hint: 'When it was won or lost; SCORO’s 0000-00-00 is none' },
    { header: 'discount', example: '0.000000', hint: 'The quotation discount, a percentage to six decimals' },
    { header: 'total_sum', example: '325406114.88', hint: 'Net after discount, before VAT — the one summary line is worth the subtotal this implies' },
    { header: 'total_vat', example: '39048733.79', hint: 'With total_sum, the VAT rate the revision is stored with' },
    { header: 'total_sum_vat', example: '364454848.67', hint: 'Not stored: the revision’s total is recomputed from the line' },
    { header: 'total_cost', example: '263424000.0000', hint: 'The summary line’s cost, so the margin reads as SCORO’s' },
    { header: 'c_prnumber', example: '', hint: 'PR Number' },
    { header: 'c_delivery', example: '16 to 18 weeks Upon receive of Down Payment', hint: 'Delivery' },
    { header: 'c_paymentterms', example: '50% Down payment / 50% Progress Billing', hint: 'Payment terms' },
    { header: 'estimated_closing_date', example: '2026-04-10', hint: 'Expected closing' },
    { header: 'id', example: '8773', hint: 'SCORO’s quote id, kept in the audit row' },
    // The line columns of SCORO's lines export (2026-10-11, the owner's second file): one row per line.
    { header: 'product_group', example: 'Schneider Electric', hint: 'The line’s group; a new one joins Admin › Categories › Quotation groups' },
    { header: 'product_name', example: 'SCHNEIDER ELECTRIC, TAP-OFF UNIT, 32 AMPS', hint: 'The line’s title, as SCORO wrote it (a subheading’s text when is_subheading is 1)' },
    { header: 'line_comment', example: '32A Tap-off unit -1 Whip TPN, includes: …', hint: 'The line’s description' },
    { header: 'amount', example: '4704.000000000000', hint: 'The quantity' },
    { header: 'unit', example: 'set', hint: 'The unit; blank is "lot"' },
    { header: 'price', example: '69176.470000', hint: 'The unit price' },
    { header: 'line_cost', example: '263424000.0000', hint: 'The LINE’s total cost; stored as a unit cost (÷ amount) to the centavo' },
    { header: 'line_vat_percent', example: '12.000', hint: 'The first priced line’s rate is the revision’s VAT rate' },
    { header: 'is_subheading', example: '0', hint: '1 makes the row a subheading over the lines below it' },
    { header: 'supplier_name', example: 'SCHNEIDER ELECTRIC PHILIPPINES', hint: 'Who carries the cost — matched to a supplier by name, never created; otherwise kept in the cost note' },
    { header: 'doer_name', example: '', hint: 'With is_internal 1, one of our people carrying the cost — matched to a login by name; otherwise kept in the cost note' },
    { header: 'is_internal', example: '0', hint: '1 when the cost is carried in-house (doer_name), 0 when by a supplier' },
    { header: 'cost_comment', example: '', hint: 'The line’s cost note' },
    { header: 'line_id', example: '39866', hint: 'SCORO’s line id — a row with one is a line' },
  ],
  // One row per line in the lines export: the rows sharing a doc_no are one quotation.
  groupBy: (row) => (row['doc_no'] ?? '').trim(),
  buildGroup: async (rows, firstRowNumber) => {
    const header = await scoroQuoteSpec.build(rows[0], firstRowNumber);
    if (!rows.some(hasLineContent)) return header;
    const lines = await scoroLines(rows, firstRowNumber);
    // The rate SCORO put on the lines, where it says; the header's otherwise.
    const firstPriced = rows.find((r) => hasLineContent(r) && (r['is_subheading'] ?? '').trim() !== '1' && (r['line_vat_percent'] ?? '').trim());
    const lineRate = firstPriced ? scoroDecimal(firstPriced, 'line_vat_percent') : null;
    return { ...header, lines, vatRate: lineRate ? lineRate.div(100).toDecimalPlaces(4) : header.vatRate };
  },
  existing: async (row) => {
    const number = (row['doc_no'] ?? '').trim();
    if (!number) return null;
    const found = await prisma.quotation.findFirst({
      where: { number: { equals: number, mode: 'insensitive' } },
      select: { id: true },
    });
    return found?.id ?? null;
  },
  build: async (row) => {
    const number = required(row, 'doc_no');
    if (!QUOTE_NUMBER.test(number)) {
      throw new Error(`doc_no "${number}" is not a quote number — letters, digits and - / _ . only, up to 40 characters`);
    }

    // The author: never invented.
    const ownerName = required(row, 'owner_name');
    const users = await prisma.user.findMany({ select: { id: true, name: true, isActive: true } });
    const owners = users.filter((u) => sameName(u.name, ownerName));
    const owner = owners.find((u) => u.isActive) ?? owners[0];
    if (!owner) throw new Error(`No login named "${ownerName}" — add them in Admin › Users first`);

    const company = await prisma.company.findUniqueOrThrow({ where: { id: 'company' }, select: { currency: true, vatRate: true } });
    const currency = optional(row, 'currency');
    if (currency && currency.toUpperCase() !== company.currency.toUpperCase()) {
      throw new Error(`currency "${currency}" is not the company currency (${company.currency}) — G-CORE prints only that`);
    }

    const payer = required(row, 'payer');
    const payerId = optional(row, 'payer_id');
    const customer = await findCustomer(prisma, payer, payerId);
    const contactName = optional(row, 'contact_person');
    const contact = contactName
      ? { id: customer ? (await findContact(prisma, customer.id, contactName))?.id ?? null : null, name: collapse(contactName) }
      : null;

    const statusName = optional(row, 'status_name') ?? 'Opportunity';
    const outcome = STATUS_OUTCOME[collapse(statusName).toLowerCase()];
    if (!outcome) {
      throw new Error(`status_name "${statusName}" is not a SCORO status this import knows (Opportunity, Negotiation, Closing, Confirmed, Completed, Confirmed Project, Rejected, Cancelled, Hold, This Month Forecast)`);
    }
    const probability = stageProbability(outcome, await pipelineStages()) ?? 50;

    const issuedAt = scoroDate(row, 'doc_date') ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const deadline = scoroDate(row, 'doc_deadline');
    const docDate = scoroDate(row, 'doc_date');
    const validityDays = docDate && deadline && daysApart(docDate, deadline) >= 1 ? daysApart(docDate, deadline) : 30;
    const statusChanged = scoroDate(row, 'status_changed_date');
    const confirmed = scoroDate(row, 'confirmed_date');
    const moved = outcome !== 'OPEN';
    const decided = outcome === 'WON' || outcome === 'LOST';

    const discount = scoroDecimal(row, 'discount') ?? new Prisma.Decimal(0);
    if (discount.lt(0) || discount.gte(100)) throw new Error(`discount "${row['discount']}" is not a percentage under 100`);
    const totalSum = scoroDecimal(row, 'total_sum') ?? new Prisma.Decimal(0);
    const totalVat = scoroDecimal(row, 'total_vat') ?? new Prisma.Decimal(0);
    const totalCost = scoroDecimal(row, 'total_cost');
    // An imported rate is a fact and is stored as read, whatever the company's
    // options are today; the company rate only where the file says nothing.
    const vatRate = totalSum.gt(0) ? totalVat.div(totalSum).toDecimalPlaces(4) : company.vatRate;
    // The one line is worth the subtotal BEFORE discount, so the recalc lands
    // on SCORO's net: total_sum ÷ (1 − discount/100), to the centavo.
    const unitPrice = totalSum.div(new Prisma.Decimal(1).sub(discount.div(100))).toDecimalPlaces(2);

    const others = await prisma.quotationGroup.findUnique({ where: { key: groupKey('OTHERS') }, select: { name: true, isActive: true } });

    return {
      scoroId: optional(row, 'id'),
      number,
      ownerId: owner.id,
      customer: { id: customer?.id ?? null, name: collapse(payer), scoroId: payerId },
      contact,
      outcome,
      probability,
      submittedAt: moved ? (statusChanged ?? issuedAt) : null,
      decidedAt: decided ? (confirmed ?? statusChanged ?? issuedAt) : null,
      lostReason: outcome === 'LOST' ? `SCORO status: ${collapse(statusName)}` : null,
      issuedAt,
      expectedClosing: scoroDate(row, 'estimated_closing_date'),
      validityDays,
      subject: optional(row, 'quote_name') ?? `SCORO quote ${number}`,
      notes: optional(row, 'doc_description'),
      prNumber: optional(row, 'c_prnumber'),
      delivery: optional(row, 'c_delivery'),
      paymentTerms: optional(row, 'c_paymentterms'),
      discountPct: discount,
      vatRate,
      revisionStatus: outcome === 'WON' ? 'APPROVED' : 'DRAFT',
      unitPrice,
      unitCost: totalCost && totalCost.gt(0) ? totalCost.toDecimalPlaces(2) : null,
      group: others?.isActive ? others.name : null,
      lines: null,
    };
  },
};

/** What the summary line says of itself until the lines export replaces it. */
export const SUMMARY_LINE_TITLE = 'As quoted in SCORO';
export const summaryLineDescription = (number: string) =>
  `Imported from SCORO quote ${number} as one line — the SCORO lines were not in the file. Replace it with the real lines when they are imported.`;

async function writeScoroQuotes(
  records: { record: ScoroQuoteRecord; existingId: string | null }[],
  actor?: ImportActor,
): Promise<void> {
  const by = { actorId: actor?.id ?? null, actorName: actor?.name ?? null };
  /** The lines a record stores: the file's, or the one summary line. */
  const linesOf = (record: ScoroQuoteRecord): QuotationLineInput[] =>
    record.lines ?? [
      {
        group: record.group,
        title: SUMMARY_LINE_TITLE,
        description: summaryLineDescription(record.number),
        quantity: 1,
        unit: 'lot',
        unitPrice: Number(record.unitPrice),
        unitCost: record.unitCost === null ? null : Number(record.unitCost),
      },
    ];

  for (const { record, existingId } of records) {
    if (existingId) {
      // A quotation already in G-CORE is G-CORE's: the file does not touch it
      // — except to keep the summary line's promise. One that came from the
      // header-only export (revision 0 still a draft, exactly the one
      // "As quoted in SCORO" line) takes the real lines from a file that
      // carries them; anything else is left exactly as it is.
      if (!record.lines) continue;
      await prisma.$transaction(async (tx) => {
        const rev = await tx.quotationRevision.findFirst({
          where: { quotationId: existingId, revision: 0 },
          include: { items: { select: { id: true, title: true } } },
        });
        if (!rev || rev.status !== 'DRAFT' || rev.items.length !== 1 || rev.items[0].title !== SUMMARY_LINE_TITLE) return;
        await tx.quotationItem.delete({ where: { id: rev.items[0].id } });
        await tx.quotationItem.createMany({ data: record.lines!.map((line, i) => ({ revisionId: rev.id, ...lineData(line, i) })) });
        await rememberGroups(tx, record.lines!.map((l) => l.group));
        await recalcQuotationRevision(rev.id, tx);
        await audit(
          {
            entityType: 'quotation',
            entityId: existingId,
            action: 'UPDATED',
            summary: `Replaced the summary line with ${record.lines!.length} line${record.lines!.length === 1 ? '' : 's'} from the SCORO lines export`,
            after: { scoroId: record.scoroId, number: record.number, lines: record.lines!.length },
            ...by,
          },
          undefined,
          tx,
        );
      });
      continue;
    }

    // One transaction per row: the customer, the contact, the quotation, its
    // revision, the line, the recalc and the counter stand or fall together.
    await prisma.$transaction(async (tx) => {
      let customerId = record.customer.id;
      if (!customerId) {
        // Looked for again here: an earlier row of this file may have made it.
        const again = await findCustomer(tx, record.customer.name, record.customer.scoroId);
        if (again) customerId = again.id;
      }
      if (!customerId) {
        // By name alone, as CustomerPicker's quick-add files one: no team, no
        // sub-industry, the SCORO id in the notes so the next file matches it.
        const made = await tx.customer.create({
          data: {
            code: await nextNumber('customer', tx),
            name: record.customer.name,
            notes: record.customer.scoroId ? `(SCORO id ${record.customer.scoroId})` : null,
            createdById: actor?.id ?? null,
          },
          select: { id: true, code: true, name: true },
        });
        customerId = made.id;
        await audit(
          {
            entityType: 'customer',
            entityId: made.id,
            action: 'CREATED',
            summary: `Created customer ${made.code} ${made.name} from ${SOURCE}${record.customer.scoroId ? ` (SCORO id ${record.customer.scoroId})` : ''}`,
            ...by,
          },
          undefined,
          tx,
        );
      }

      let contactId: string | null = null;
      if (record.contact) {
        contactId = record.contact.id ?? (await findContact(tx, customerId, record.contact.name))?.id ?? null;
        if (!contactId) {
          const made = await tx.customerContact.create({ data: { customerId, name: record.contact.name }, select: { id: true, name: true } });
          contactId = made.id;
          await audit(
            {
              entityType: 'customer',
              entityId: customerId,
              action: 'UPDATED',
              summary: `Added contact ${made.name} — created from ${SOURCE}`,
              ...by,
            },
            undefined,
            tx,
          );
        }
      }

      const quotation = await tx.quotation.create({
        data: {
          number: record.number,
          customerId,
          contactId,
          ownerId: record.ownerId,
          subject: record.subject,
          outcome: record.outcome,
          probability: record.probability,
          submittedAt: record.submittedAt,
          decidedAt: record.decidedAt,
          lostReason: record.lostReason,
          expectedClosing: record.expectedClosing,
          createdAt: record.issuedAt,
          revisions: {
            create: [
              {
                revision: 0,
                status: record.revisionStatus,
                validityDays: record.validityDays,
                notes: record.notes,
                vatRate: record.vatRate,
                discountPct: record.discountPct,
                prNumber: record.prNumber,
                delivery: record.delivery,
                paymentTerms: record.paymentTerms,
                createdAt: record.issuedAt,
              },
            ],
          },
        },
        include: { revisions: { select: { id: true } } },
      });
      const revisionId = quotation.revisions[0].id;

      // The file's lines, or the one summary line, in the shape every
      // quotation line is stored in; SCORO's groups join the master.
      const lines = linesOf(record);
      await tx.quotationItem.createMany({ data: lines.map((line, i) => ({ revisionId, ...lineData(line, i) })) });
      await rememberGroups(tx, lines.map((l) => l.group));
      await recalcQuotationRevision(revisionId, tx);

      // The series follows the highest imported number and is never lowered
      // (`raise`, the mode built for this upload); a number outside the
      // template's shape moves nothing.
      const counter: CounterMove | null = await setCounter('quotation', record.number, tx, { mode: 'raise' });

      await audit(
        {
          entityType: 'quotation',
          entityId: quotation.id,
          action: 'CREATED',
          summary: `Imported from SCORO quote CSV (SCORO id ${record.scoroId ?? '—'})`,
          after: { scoroId: record.scoroId, number: record.number, outcome: record.outcome, lines: lines.length, ...(counter ? { counter } : {}) },
          ...by,
        },
        undefined,
        tx,
      );
    });
  }
}

export const scoroQuotesImport: Registered = {
  spec: scoroQuoteSpec as unknown as ImportSpec<never>,
  permission: 'gops.quotations.create',
  write: writeScoroQuotes as unknown as Registered['write'],
};

/** The spec and the writer by their own names, so verify-sales drives exactly what the route runs. */
export { scoroQuoteSpec, writeScoroQuotes };
