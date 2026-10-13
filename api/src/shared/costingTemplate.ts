import { prisma } from '../prisma';
import { formatQuantity } from './pdf';
import {
  COMPANY_FIELDS,
  PAGE_FIELDS,
  readDesign,
  type DesignData,
  type DesignField,
  type ItemColumnKey,
  type PdfDesign,
  type TextBlock,
} from './pdfDesign';

/**
 * The Project Costing as a designed document (2026-10-13, the owner's call:
 * "add PDF Template of Costing in Admin Setting to modify") — the third after
 * the quotation and the sales order: the fields it can print, the sample a
 * layout is previewed with, and the standard layout, the quotation's dress on
 * a portrait A4 page. The costing is internal paper, so its line table prints
 * cost (it IS cost: the unit cost and the amount of every line).
 *
 * The Scope of Work stays the engine's Gantt chart, an APPENDIX on landscape
 * pages of its own behind the designed pages (the designed engine draws boxes,
 * not charts): `GET /costings/:id/pdf` renders both and joins them
 * (`appendPdf`). An administrator lays out the estimate, never the chart.
 */

export const COSTING_TEMPLATE_KEY = 'pdfTemplate.costing';

export const COSTING_FIELDS: DesignField[] = [
  { key: 'costing.number', label: 'Costing number', group: 'Costing', sample: 'GT-COST-2026-0042' },
  { key: 'costing.title', label: 'Project / job', group: 'Costing', sample: 'Booster pump room, Phase 2' },
  { key: 'costing.date', label: 'Date, 10/13/2026', group: 'Costing', sample: '10/13/2026' },
  { key: 'costing.dateLong', label: 'Date, October 13, 2026', group: 'Costing', sample: 'October 13, 2026' },
  { key: 'costing.status', label: 'Status', group: 'Costing', sample: 'Draft' },
  { key: 'costing.systemUnit', label: 'System / unit', group: 'Costing', sample: 'Booster pump controller' },
  { key: 'costing.location', label: 'Location (the site)', group: 'Costing', sample: 'Pump house, Calamba, Laguna' },
  { key: 'costing.validUntil', label: 'Valid until, October 30, 2026', group: 'Costing', sample: 'November 12, 2026' },
  { key: 'costing.plannedStart', label: 'Start date (when set)', group: 'Schedule', sample: 'October 14, 2026' },
  { key: 'costing.plannedFinish', label: 'Finish date (the plan’s last working day)', group: 'Schedule', sample: 'November 5, 2026' },
  { key: 'costing.planDays', label: 'Duration, 20 working days (Mon–Sat)', group: 'Schedule', sample: '20 working days (Mon–Sat)' },
  { key: 'costing.terms', label: 'Terms & Conditions', group: 'Costing', sample: '50% down payment, balance on turnover.' },
  { key: 'costing.currency', label: 'Currency, PHP', group: 'Money', sample: 'PHP' },
  { key: 'costing.totalCost', label: 'Project budgeted cost', group: 'Money', sample: '132,401.00' },
  { key: 'costing.marginPct', label: 'Margin, % of the price', group: 'Money', sample: '35%' },
  { key: 'costing.marginAmount', label: 'Margin, amount', group: 'Money', sample: '71,292.85' },
  { key: 'costing.contractValue', label: 'Subtotal (the contract value, before VAT)', group: 'Money', sample: '203,693.85' },
  { key: 'costing.vatRate', label: 'VAT rate, 12%', group: 'Money', sample: '12%' },
  { key: 'costing.vatAmount', label: 'VAT', group: 'Money', sample: '24,443.26' },
  { key: 'costing.grandTotal', label: 'Total, VAT included', group: 'Money', sample: '228,137.11' },
  { key: 'customer.name', label: 'Customer', group: 'Customer', sample: 'Sample Manufacturing Corp.' },
  { key: 'owner.name', label: 'Prepared by', group: 'Prepared by', sample: 'Juan Dela Cruz' },
  { key: 'owner.position', label: 'Their position', group: 'Prepared by', sample: 'Project Engineer' },
  { key: 'owner.email', label: 'Their email', group: 'Prepared by', sample: 'juan.delacruz@gruntech.com' },
  { key: 'owner.phone', label: 'Their phone', group: 'Prepared by', sample: '0917 555 0100' },
];

/** Every field a costing layout may name. */
export const COSTING_FIELD_KEYS = new Set([...COMPANY_FIELDS, ...PAGE_FIELDS, ...COSTING_FIELDS].map((f) => f.key));

/**
 * The line table's columns a costing layout may place, and what each means on
 * a costing: `no` is the line's code (101, 102 …), `unitPrice` its UNIT COST.
 */
export const COSTING_COLUMNS: readonly ItemColumnKey[] = ['no', 'product', 'qtyUnit', 'qty', 'unit', 'unitPrice', 'amount'];
export const COSTING_COLUMN_LABELS: Partial<Record<ItemColumnKey, string>> = {
  no: 'Line code (101, 102 …)',
  product: 'Line, with its description under it',
  unitPrice: 'Unit cost',
};

/** A line of the cost table — its code, its name over its description, unit, quantity, unit cost, amount. */
export function costingLineRow(l: { code: string | null; name: string; description?: string | null; unit: string; quantity: number; unitCost: string; amount: string }) {
  const body = l.description && l.description !== l.name ? l.description : undefined;
  return {
    cells: {
      no: l.code ?? '',
      product: body ? { title: l.name, body } : { title: l.name },
      unit: l.unit,
      qty: formatQuantity(l.quantity),
      qtyUnit: `${formatQuantity(l.quantity)} ${l.unit}`.trim(),
      unitPrice: l.unitCost,
      amount: l.amount,
    },
  };
}

/** A bucket's subtotal: a bold line under its lines, the figure in the amount column. */
export const costingSubtotalRow = (name: string, amount: string) => ({ cells: { product: { title: `${name} subtotal` }, amount: { title: amount } } });

export function costingSample(long = false): DesignData {
  const fields = Object.fromEntries(COSTING_FIELDS.map((f) => [f.key, f.sample ?? '']));
  const rows: DesignData['rows'] = [
    { heading: '1   Materials' },
    costingLineRow({ code: '101', name: 'VFD 15 kW', description: 'Variable frequency drive, IP54', unit: 'unit', quantity: 2, unitCost: '45,000.50', amount: '90,001.00' }),
    costingLineRow({ code: '102', name: 'Consumables', unit: 'lot', quantity: 1, unitCost: '3,000.00', amount: '3,000.00' }),
  ];
  if (long) for (let i = 3; i <= 40; i++) rows.push(costingLineRow({ code: String(100 + i), name: `Cable tray fitting, item ${i}`, description: 'Hot-dip galvanised, 300 mm', unit: 'pcs', quantity: 4, unitCost: '350.00', amount: '1,400.00' }));
  rows.push(costingSubtotalRow('Materials', long ? '146,201.00' : '93,001.00'));
  rows.push({ heading: '3   Labor' });
  rows.push(costingLineRow({ code: '301', name: 'Assembly and programming', unit: 'lot', quantity: 1, unitCost: '39,400.00', amount: '39,400.00' }));
  rows.push(costingSubtotalRow('Labor', '39,400.00'));
  return {
    title: 'Project Costing (sample)',
    fields,
    rows,
    totals: [
      { label: 'Project budgeted cost', value: 'PHP 132,401.00' },
      { label: 'Margin (35% of the price)', value: 'PHP 71,292.85' },
      { label: 'Subtotal', value: 'PHP 203,693.85' },
      { label: 'VAT (12%)', value: 'PHP 24,443.26' },
      { label: 'Total', value: 'PHP 228,137.11', bold: true },
    ],
    signatories: [
      { role: 'Prepared by', name: 'Juan Dela Cruz', phone: '0917 555 0100', email: 'juan.delacruz@gruntech.com', at: new Date('2026-10-13T01:30:00Z') },
      { role: 'Technical Manager', name: 'Ana Cruz', at: new Date('2026-10-13T03:10:00Z') },
      { role: 'Team Leader', name: 'Jose Reyes' },
    ],
  };
}

const L = 36;
const W = 523.28;
const PURPLE = '#5B2A8C';
const GREEN = '#2E9A4B';
const INK = '#222222';
const RULE = '#D9D9D9';
const GREY = '#666666';

const text = (spec: Pick<TextBlock, 'id' | 'anchor' | 'x' | 'y' | 'w' | 'h' | 'text' | 'size'> & Partial<TextBlock>): TextBlock => ({
  type: 'text',
  bold: false,
  italic: false,
  color: INK,
  align: 'left',
  uppercase: false,
  spacing: 0,
  lineGap: 0,
  fit: false,
  multiPageOnly: false,
  ...spec,
});

/**
 * The standard costing layout: the quotation's dress — the letterhead, the
 * purple title against the green number, PROJECT and DETAILS side by side,
 * the cost table with its numbered buckets and their subtotals, the summary
 * flush right, Terms after it, the sign-offs at the foot of the last page.
 */
export const STANDARD_COSTING_DESIGN: PdfDesign = {
  version: 1,
  orientation: 'portrait',
  flowTop: 50,
  flowBottom: 760.89,
  blocks: [
    { id: 'logo', name: 'Logo', type: 'logo', anchor: 'first', x: L, y: 30, w: 72, h: 72, align: 'left' },
    text({
      id: 'company-name', name: 'Company name', anchor: 'first', x: 117, y: 37, w: 255, h: 17.5,
      text: '{{company.name}}', size: 15, bold: true, color: PURPLE, uppercase: true, fit: true,
    }),
    text({
      id: 'company-lines', name: 'Company details', anchor: 'first', x: 117, y: 57.5, w: 255, h: 42,
      text: [
        '{{company.address}}',
        'Tel No.: {{company.phone}} | Fax No.: {{company.fax}} | Email: {{company.email}}',
        'Website: {{company.website}}',
        'TIN: {{company.tin}} | REG NO: {{company.regNo}}',
      ].join('\n'),
      size: 7.5, lineGap: 2.5,
    }),
    text({
      id: 'title', name: 'Title', anchor: 'first', x: 374.28, y: 26, w: 185, h: 28,
      text: 'PROJECT COSTING', size: 20, color: PURPLE, align: 'right', fit: true,
    }),
    text({
      id: 'number', name: 'Costing number', anchor: 'first', x: 374.28, y: 62, w: 185, h: 12,
      text: '# {{costing.number}}', size: 10, bold: true, color: GREEN, align: 'right',
    }),
    { id: 'rule-top', name: 'Rule under the letterhead', type: 'line', anchor: 'first', x: L, y: 114.25, w: W, h: 1.5, color: GREEN },
    text({
      id: 'project-heading', name: 'PROJECT heading', anchor: 'first', x: L, y: 137, w: 246, h: 10,
      text: 'PROJECT', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      id: 'project', name: 'Project', anchor: 'first', x: L, y: 159, w: 246, h: 47,
      text: ['**{{costing.title}}**', '{{customer.name}}', '{{costing.location}}', 'System / Unit: {{costing.systemUnit}}'].join('\n'),
      size: 9.5, lineGap: 1,
    }),
    text({
      id: 'details-heading', name: 'DETAILS heading', anchor: 'first', x: 302, y: 137, w: 257.28, h: 10,
      text: 'DETAILS', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      // A line whose field is empty drops out: no start date, no Start and Finish.
      id: 'details', name: 'Details', anchor: 'first', x: 302, y: 159, w: 257.28, h: 56,
      text: [
        'Date: {{costing.date}}',
        'Valid until: {{costing.validUntil}}',
        'Start date: {{costing.plannedStart}}',
        'Finish date: {{costing.plannedFinish}}',
      ].join('\n'),
      size: 9.5, bold: true, lineGap: 4,
    }),
    {
      id: 'items', name: 'Cost lines', type: 'items', anchor: 'first', x: L, y: 228, w: W, h: 250,
      columns: [
        { key: 'no', label: 'No.', width: 38, align: 'left' },
        { key: 'product', label: 'Description', width: 230, align: 'left' },
        { key: 'unit', label: 'Unit', width: 42, align: 'left' },
        { key: 'qty', label: 'Qty', width: 42, align: 'right' },
        { key: 'unitPrice', label: 'Unit cost ({{costing.currency}})', width: 81, align: 'right' },
        { key: 'amount', label: 'Amount ({{costing.currency}})', width: 90.28, align: 'right' },
      ],
      size: 9, headColor: PURPLE, headingColor: GREEN, textColor: INK, bodyColor: '#555555', ruleColor: RULE,
    },
    {
      id: 'totals', name: 'Summary', type: 'totals', anchor: 'after', x: 299.48, y: 496, w: 259.8, h: 128,
      size: 9, labelWidth: 157.6, rowHeight: 24.5, textColor: INK, accentColor: PURPLE, ruleColor: RULE,
      grid: false, perBand: 3, bandGap: 4,
    },
    text({
      id: 'terms', name: 'Terms and conditions', anchor: 'after', x: L, y: 640, w: W, h: 21.8, showIf: 'costing.terms',
      text: '**Terms & Conditions:**\n{{costing.terms}}', size: 9, lineGap: 1,
    }),
    text({
      id: 'schedule-note', name: 'Schedule note', anchor: 'after', x: L, y: 672, w: W, h: 8.1, showIf: 'costing.planDays',
      text: 'Scope of work: {{costing.planDays}} — the schedule follows on its own pages.', size: 7, italic: true, color: GREY,
    }),
    { id: 'rule-end', name: 'Rule after the text', type: 'line', anchor: 'after', x: L, y: 694.2, w: W, h: 0.75, color: RULE },
    {
      id: 'signoffs', name: 'Sign-offs', type: 'signoffs', anchor: 'last', x: L, y: 714, w: W, h: 60,
      size: 8, colWidth: 133, headColor: PURPLE, textColor: INK,
      nameSize: 10, showPosition: false, showPhone: true, showEmail: true, style: 'columns', ruleColor: RULE,
    },
    { id: 'footer-rule', name: 'Footer rule', type: 'line', anchor: 'every', x: L, y: 784.51, w: W, h: 0.75, color: RULE },
    text({
      id: 'strapline', name: 'Strapline', anchor: 'every', x: L, y: 796.89, w: W, h: 16.2,
      text: '{{company.strapline}}', size: 14, bold: true, color: GREEN, align: 'center', uppercase: true, spacing: 1.5, fit: true,
    }),
    text({
      id: 'page-number', name: 'Page number', anchor: 'every', x: 499.28, y: 816.89, w: 60, h: 8.7,
      text: 'Page {{page}} of {{pages}}', size: 7.5, color: GREY, align: 'right', multiPageOnly: true,
    }),
    text({
      id: 'running-header', name: 'Running header', anchor: 'later', x: L, y: 22, w: W, h: 9.3,
      text: '{{costing.title}}   ·   Project Costing # {{costing.number}}   ·   {{costing.date}}', size: 8, color: GREY, align: 'center',
    }),
  ],
};

/**
 * The layout costings print with: the administrator's, or the standard one —
 * and a stored layout that no longer reads prints the standard rather than
 * failing every costing.
 */
export async function costingDesign(): Promise<{ design: PdfDesign; saved: boolean; unreadable: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: COSTING_TEMPLATE_KEY } });
  if (!row) return { design: STANDARD_COSTING_DESIGN, saved: false, unreadable: false };
  const design = readDesign(row.value);
  if (!design) {
    console.warn(`[pdf] ${COSTING_TEMPLATE_KEY} does not read as a layout; printing the standard one`);
    return { design: STANDARD_COSTING_DESIGN, saved: false, unreadable: true };
  }
  return { design, saved: true, unreadable: false };
}
