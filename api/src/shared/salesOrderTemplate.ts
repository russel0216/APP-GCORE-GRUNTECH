import { prisma } from '../prisma';
import {
  COMPANY_FIELDS,
  COST_COLUMNS,
  PAGE_FIELDS,
  readDesign,
  type DesignData,
  type DesignField,
  type ItemsBlock,
  type PdfDesign,
  type TextBlock,
} from './pdfDesign';

/**
 * The sales order's PDF as a designed document (see `pdfDesign.ts`), the
 * second after the quotation: the fields it can print, the sample a layout is
 * previewed with, and the standard layout — the quotation's dress on an A4
 * page turned LANDSCAPE, because the owner's sample (Sale Order 4622) carries
 * the cost and margin columns and portrait cannot hold them readably.
 *
 * It is the internal booking record, never the customer's copy, so its layout
 * may place the cost columns — the one designed document that may. Cost still
 * reaches the paper only for a caller who may see it: the PDF route strips
 * the cost columns from the layout (`withoutCostColumns`) and the data
 * builder sends no cost cells or cost totals to anyone else.
 */

export const SALES_ORDER_TEMPLATE_KEY = 'pdfTemplate.sales_order';

export const SALES_ORDER_FIELDS: DesignField[] = [
  { key: 'order.number', label: 'Order number (decimal for progress booking)', group: 'Sales order', sample: '0012610002.1' },
  { key: 'order.date', label: 'Order date, 10/07/2026', group: 'Sales order', sample: '10/07/2026' },
  { key: 'order.dateLong', label: 'Order date, October 7, 2026', group: 'Sales order', sample: 'October 7, 2026' },
  { key: 'order.status', label: 'Status', group: 'Sales order', sample: 'Draft' },
  { key: 'order.subject', label: 'Subject (the quotation’s)', group: 'Sales order', sample: 'Supply and installation of an air compressor' },
  { key: 'order.poNumber', label: 'Customer PO number', group: 'Sales order', sample: 'PO-4521' },
  { key: 'order.paymentTerms', label: 'Payment terms, 30 days', group: 'Sales order', sample: '30 days' },
  { key: 'order.paymentMethod', label: 'Payment method', group: 'Sales order', sample: 'Bank transfer' },
  { key: 'order.referenceNo', label: 'Reference', group: 'Sales order', sample: '' },
  { key: 'order.siNumber', label: 'SI / BS number', group: 'Sales order', sample: '' },
  { key: 'order.drNumber', label: 'DR number', group: 'Sales order', sample: '' },
  { key: 'order.comment', label: 'Notes', group: 'Sales order', sample: 'First 50% booking per the approved quotation.' },
  { key: 'order.draftNote', label: 'Draft note (only while a draft)', group: 'Sales order', sample: 'DRAFT — not yet issued.' },
  { key: 'order.cancelReason', label: 'Cancellation reason', group: 'Sales order', sample: '' },
  { key: 'order.currency', label: 'Currency, PHP', group: 'Money', sample: 'PHP' },
  { key: 'order.vatRate', label: 'VAT rate, 12%', group: 'Money', sample: '12%' },
  { key: 'order.subtotal', label: 'Subtotal', group: 'Money', sample: '125,000.00' },
  { key: 'order.discount', label: 'Discount', group: 'Money', sample: '' },
  { key: 'order.net', label: 'Sum without tax', group: 'Money', sample: '125,000.00' },
  { key: 'order.vat', label: 'VAT', group: 'Money', sample: '15,000.00' },
  { key: 'order.total', label: 'Total', group: 'Money', sample: '140,000.00' },
  { key: 'quotation.number', label: 'Quotation number it books', group: 'Quotation', sample: '0012610001' },
  { key: 'quotation.subject', label: 'Quotation subject', group: 'Quotation', sample: 'Supply and installation of an air compressor' },
  { key: 'customer.name', label: 'Customer, registered name', group: 'Customer', sample: 'Sample Manufacturing Corp.' },
  { key: 'customer.code', label: 'Customer code', group: 'Customer', sample: 'CUS-0042' },
  { key: 'customer.address', label: 'Address (the quotation’s site)', group: 'Customer', sample: 'Lot 5 Phase 2, Light Industry Park, Laguna' },
  { key: 'customer.phone', label: 'Customer phone', group: 'Customer', sample: '(049) 555 0142' },
  { key: 'customer.tin', label: 'Customer TIN', group: 'Customer', sample: '123-456-789-000' },
  { key: 'contact.name', label: 'Contact', group: 'Contact', sample: 'Engr. Juan Dela Cruz' },
  { key: 'contact.position', label: 'Contact’s position', group: 'Contact', sample: 'Facilities Head' },
  { key: 'contact.nameAndPosition', label: 'Contact, with their position', group: 'Contact', sample: 'Engr. Juan Dela Cruz, Facilities Head' },
  { key: 'owner.name', label: 'Prepared by', group: 'Prepared by', sample: 'Maria Santos' },
  { key: 'owner.position', label: 'Their position', group: 'Prepared by', sample: 'Sales Engineer' },
  { key: 'owner.email', label: 'Their email', group: 'Prepared by', sample: 'maria.santos@gruntech.com' },
  { key: 'owner.phone', label: 'Their phone', group: 'Prepared by', sample: '0917 555 0100' },
];

/** Every field a sales order layout may name. Cost is not a field — only a column. */
export const SALES_ORDER_FIELD_KEYS = new Set([...COMPANY_FIELDS, ...PAGE_FIELDS, ...SALES_ORDER_FIELDS].map((f) => f.key));

/**
 * What a layout is previewed with when no sales order is chosen. The sample
 * is a DRAFT, so the editor shows the draft note; it carries cost and margin,
 * because the editor is the administrator's and the standard layout places
 * both columns.
 */
export function salesOrderSample(long = false): DesignData {
  const fields = Object.fromEntries(SALES_ORDER_FIELDS.map((f) => [f.key, f.sample ?? '']));
  const line = (
    title: string,
    body: string,
    qty: number,
    unit: string,
    price: number,
    group: string,
    cost: number,
    provider: string,
  ) => ({
    cells: {
      product: { title, body },
      qtyUnit: `${qty} ${unit}`,
      qty: String(qty),
      unit,
      unitPrice: price.toLocaleString('en-PH', { minimumFractionDigits: 2 }),
      amount: (price * qty).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
      group,
      cost: { title: (cost * qty).toLocaleString('en-PH', { minimumFractionDigits: 2 }), body: provider },
      margin: ((price - cost) * qty).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
    },
  });
  const rows: DesignData['rows'] = [
    line('Air compressor, 37 kW rotary screw', 'Oil-injected, 8 bar, with refrigerated dryer and 1,000 L receiver tank.', 1, 'unit', 98_000, 'Equipment', 72_500, 'Atlas Copco PH'),
    line('Installation and commissioning', 'Labour, tools and consumables; start-up, testing and turnover.', 1, 'lot', 27_000, 'Services', 14_000, ''),
  ];
  if (long) {
    rows.push({ heading: 'Piping and accessories' });
    for (let i = 3; i <= 40; i++) {
      rows.push(line(`Pipe fitting, item ${i}`, 'Galvanised, schedule 40, threaded both ends.', 2, 'pcs', 350, 'Materials', 220, ''));
    }
  }
  return {
    title: 'Sales Order (sample)',
    fields,
    rows,
    totals: [
      { label: 'Subtotal:', value: '125,000.00' },
      { label: 'Tax (12%):', value: '15,000.00' },
      { label: 'Total (PHP):', value: '140,000.00', bold: true },
      { label: 'Cost (PHP):', value: '86,500.00' },
      { label: 'Margin sum:', value: '38,500.00' },
    ],
    signatories: [
      {
        role: 'Prepared by',
        name: 'Maria Santos',
        position: 'Sales Engineer',
        phone: '0917 555 0100',
        email: 'maria.santos@gruntech.com',
        at: new Date('2026-10-07T01:30:00Z'),
      },
      { role: 'Noted by' },
      { role: 'Approved by' },
    ],
  };
}

const L = 36;
const W = 769.89; // 841.89 − two 36pt margins, on the page's long side
const PURPLE = '#5B2A8C';
const GREEN = '#2E9A4B';
const INK = '#222222';
const RULE = '#D9D9D9';
const GREY = '#666666';

/** A text box with the plain defaults, so the layout below lists only what differs. */
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
 * The standard sales order layout: the Quotation_Template dress — the logo
 * with the company beside it, the purple title with the green number against
 * it, a green rule, CUSTOMER and ORDER DETAILS side by side, the slate of
 * columns, totals flush right, dated sign-offs, the strapline on every page —
 * turned landscape so the cost and margin columns fit beside the money.
 */
export const STANDARD_SALES_ORDER_DESIGN: PdfDesign = {
  version: 1,
  orientation: 'landscape',
  flowTop: 46,
  flowBottom: 515,
  blocks: [
    { id: 'logo', name: 'Logo', type: 'logo', anchor: 'first', x: L, y: 28, w: 66, h: 66, align: 'left' },
    text({
      id: 'company-name', name: 'Company name', anchor: 'first', x: 112, y: 33, w: 300, h: 17.5,
      text: '{{company.name}}', size: 15, bold: true, color: PURPLE, uppercase: true, fit: true,
    }),
    text({
      id: 'company-lines', name: 'Company details', anchor: 'first', x: 112, y: 53.5, w: 300, h: 42,
      text: [
        '{{company.address}}',
        'Tel No.: {{company.phone}} | Fax No.: {{company.fax}} | Email: {{company.email}}',
        'Website: {{company.website}}',
        'TIN: {{company.tin}} | REG NO: {{company.regNo}}',
      ].join('\n'),
      size: 7.5, lineGap: 2.5,
    }),
    text({
      id: 'title', name: 'Title', anchor: 'first', x: 560.89, y: 24, w: 245, h: 28,
      text: 'SALES ORDER', size: 24, color: PURPLE, align: 'right',
    }),
    text({
      id: 'number', name: 'Order number', anchor: 'first', x: 560.89, y: 60, w: 245, h: 12,
      text: '# {{order.number}}', size: 10, bold: true, color: GREEN, align: 'right',
    }),
    { id: 'rule-top', name: 'Rule under the letterhead', type: 'line', anchor: 'first', x: L, y: 104, w: W, h: 1.5, color: GREEN },
    text({
      id: 'customer-heading', name: 'CUSTOMER heading', anchor: 'first', x: L, y: 122, w: 360, h: 10,
      text: 'CUSTOMER', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      id: 'customer', name: 'Customer', anchor: 'first', x: L, y: 140, w: 360, h: 56,
      text: [
        '**{{customer.name}}**',
        '{{customer.address}}',
        '{{customer.phone}} | TIN: {{customer.tin}}',
        'Attention: {{contact.nameAndPosition}}',
      ].join('\n'),
      size: 9.5, lineGap: 1,
    }),
    text({
      id: 'details-heading', name: 'ORDER DETAILS heading', anchor: 'first', x: 430, y: 122, w: 375.89, h: 10,
      text: 'ORDER DETAILS', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      id: 'details', name: 'Order details', anchor: 'first', x: 430, y: 140, w: 375.89, h: 56,
      text: [
        'Per quotation: {{quotation.number}} | Date: {{order.date}}',
        'Purchase Order No.: {{order.poNumber|—}} | Payment terms: {{order.paymentTerms}}',
        'Payment method: {{order.paymentMethod}} | Reference: {{order.referenceNo}}',
        'SI / BS No.: {{order.siNumber}} | DR No.: {{order.drNumber}}',
      ].join('\n'),
      size: 9.5, bold: true, lineGap: 3,
    }),
    {
      id: 'items', name: 'Lines', type: 'items', anchor: 'first', x: L, y: 212, w: W, h: 210,
      columns: [
        { key: 'group', label: 'Group', width: 70, align: 'left' },
        { key: 'product', label: 'Product name and additional info', width: 270, align: 'left' },
        { key: 'qtyUnit', label: 'Qty', width: 55, align: 'left' },
        { key: 'unitPrice', label: 'Unit price ({{order.currency}})', width: 85, align: 'right' },
        { key: 'amount', label: 'Total ({{order.currency}})', width: 85, align: 'right' },
        { key: 'cost', label: 'Cost + supplier', width: 115, align: 'right' },
        { key: 'margin', label: 'Margin', width: 70, align: 'right' },
      ],
      size: 9, headColor: PURPLE, headingColor: GREEN, textColor: INK, bodyColor: '#555555', ruleColor: RULE,
    },
    {
      id: 'totals', name: 'Totals', type: 'totals', anchor: 'after', x: 560, y: 440, w: 245.89, h: 100,
      size: 9, labelWidth: 130, textColor: INK, accentColor: PURPLE, ruleColor: RULE,
    },
    text({
      id: 'notes', name: 'Notes', anchor: 'after', x: L, y: 440, w: 480, h: 21.8, showIf: 'order.comment',
      text: '**Notes:**\n{{order.comment}}', size: 9, lineGap: 1,
    }),
    text({
      id: 'cancelled', name: 'Cancellation', anchor: 'after', x: L, y: 473, w: 480, h: 10.4, showIf: 'order.cancelReason',
      text: '**Cancelled:** {{order.cancelReason}}', size: 9,
    }),
    text({
      id: 'internal-note', name: 'Internal note', anchor: 'after', x: L, y: 486, w: 480, h: 8.1,
      text: 'Internal booking record — not for the customer. The sales invoice is issued by Finance.',
      size: 7, italic: true, color: GREY,
    }),
    {
      // Beside the totals, flowing after the content: on the short page a
      // last-page block would take a page of its own whenever the cost
      // totals run past it, and an internal record does not need one.
      id: 'signoffs', name: 'Sign-offs', type: 'signoffs', anchor: 'after', x: L, y: 504, w: 500, h: 60,
      size: 8, colWidth: 150, headColor: PURPLE, textColor: INK,
      nameSize: 10, showPosition: false, showPhone: true, showEmail: true,
    },
    text({
      id: 'draft-note', name: 'Draft note', anchor: 'every', x: L, y: 528, w: 300, h: 9.3, showIf: 'order.draftNote',
      text: '{{order.draftNote}}', size: 8, bold: true, color: GREY, uppercase: true,
    }),
    { id: 'footer-rule', name: 'Footer rule', type: 'line', anchor: 'every', x: L, y: 540, w: W, h: 0.75, color: RULE },
    text({
      id: 'strapline', name: 'Strapline', anchor: 'every', x: L, y: 552, w: W, h: 16.2,
      text: '{{company.strapline}}', size: 14, bold: true, color: GREEN, align: 'center', uppercase: true, spacing: 1.5, fit: true,
    }),
    text({
      id: 'page-number', name: 'Page number', anchor: 'every', x: 745.89, y: 575, w: 60, h: 8.7,
      text: 'Page {{page}} of {{pages}}', size: 7.5, color: GREY, align: 'right', multiPageOnly: true,
    }),
    text({
      id: 'running-header', name: 'Running header', anchor: 'later', x: L, y: 16, w: W, h: 9.3,
      text: '{{customer.name}}   ·   Sales Order # {{order.number}}   ·   {{order.date}}', size: 8, color: GREY, align: 'center',
    }),
  ],
};

/**
 * The layout sales orders print with: the administrator's, or the standard
 * one. A stored layout that no longer reads prints the standard rather than
 * failing every order, and says so to whoever opens the editor.
 */
export async function salesOrderDesign(): Promise<{ design: PdfDesign; saved: boolean; unreadable: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: SALES_ORDER_TEMPLATE_KEY } });
  if (!row) return { design: STANDARD_SALES_ORDER_DESIGN, saved: false, unreadable: false };
  const design = readDesign(row.value);
  if (!design) {
    console.warn(`[pdf] ${SALES_ORDER_TEMPLATE_KEY} does not read as a layout; printing the standard one`);
    return { design: STANDARD_SALES_ORDER_DESIGN, saved: false, unreadable: true };
  }
  return { design, saved: true, unreadable: false };
}

/**
 * The layout without its cost and margin columns — what a caller who may not
 * see cost prints with. The remaining columns stretch to the table's width,
 * because widths are shares (`table()` normalises them), so nothing else in
 * the layout has to move.
 */
export function withoutCostColumns(design: PdfDesign): PdfDesign {
  return {
    ...design,
    blocks: design.blocks.map((b) => {
      if (b.type !== 'items') return b;
      const columns = b.columns.filter((c) => !COST_COLUMNS.includes(c.key));
      return columns.length ? ({ ...b, columns } as ItemsBlock) : b;
    }),
  };
}
