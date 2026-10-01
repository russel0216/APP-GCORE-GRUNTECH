import { prisma } from '../prisma';
import {
  COMPANY_FIELDS,
  PAGE_FIELDS,
  readDesign,
  type DesignData,
  type DesignField,
  type PdfDesign,
  type TextBlock,
} from './pdfDesign';

/**
 * The quotation's PDF as a designed document (see `pdfDesign.ts`): the fields
 * it can print, the sample a layout is previewed with, and the standard
 * layout — Quotation_Template, the letter the quotation printed before the
 * layout became editable. An administrator's layout is stored in one
 * `Setting` row; without one, or if it no longer reads, the standard prints.
 */

export const QUOTATION_TEMPLATE_KEY = 'pdfTemplate.quotation';

export const QUOTATION_FIELDS: DesignField[] = [
  { key: 'quotation.number', label: 'Quote number, with the revision (R1, R2…)', group: 'Quotation', sample: '0012610001 R1' },
  { key: 'quotation.baseNumber', label: 'Quote number only', group: 'Quotation', sample: '0012610001' },
  { key: 'quotation.revision', label: 'Revision number', group: 'Quotation', sample: '1' },
  { key: 'quotation.date', label: 'Date, 10/02/2026', group: 'Quotation', sample: '10/02/2026' },
  { key: 'quotation.dateLong', label: 'Date, October 2, 2026', group: 'Quotation', sample: 'October 2, 2026' },
  { key: 'quotation.subject', label: 'Subject', group: 'Quotation', sample: 'Supply and installation of an air compressor' },
  { key: 'quotation.validity', label: 'Validity, 30 days', group: 'Quotation', sample: '30 days' },
  { key: 'quotation.validUntil', label: 'Valid until', group: 'Quotation', sample: '11/01/2026' },
  { key: 'quotation.paymentTerms', label: 'Payment terms', group: 'Quotation', sample: '30 days PDC' },
  { key: 'quotation.prNumber', label: 'PR number', group: 'Quotation', sample: 'PR-2026-0147' },
  { key: 'quotation.delivery', label: 'Delivery', group: 'Quotation', sample: '4 to 6 weeks upon receipt of PO' },
  { key: 'quotation.terms', label: 'Terms and conditions', group: 'Quotation', sample: '50% downpayment, balance upon completion.' },
  { key: 'quotation.notes', label: 'Notes', group: 'Quotation', sample: '' },
  { key: 'quotation.currency', label: 'Currency, PHP', group: 'Money', sample: 'PHP' },
  { key: 'quotation.vatRate', label: 'VAT rate, 12%', group: 'Money', sample: '12%' },
  { key: 'quotation.subtotal', label: 'Sub total', group: 'Money', sample: '125,000.00' },
  { key: 'quotation.discount', label: 'Discount', group: 'Money', sample: '' },
  { key: 'quotation.vat', label: 'VAT', group: 'Money', sample: '15,000.00' },
  { key: 'quotation.total', label: 'Total', group: 'Money', sample: '140,000.00' },
  { key: 'customer.name', label: 'Customer, registered name', group: 'Customer', sample: 'Sample Manufacturing Corp.' },
  { key: 'customer.tradeName', label: 'Customer, trading name', group: 'Customer', sample: 'Sample Manufacturing' },
  { key: 'customer.code', label: 'Customer code', group: 'Customer', sample: 'CUS-0042' },
  { key: 'customer.address', label: 'Address (the site, else the first site)', group: 'Customer', sample: 'Lot 5 Phase 2, Light Industry Park, Laguna' },
  { key: 'customer.phone', label: 'Customer phone', group: 'Customer', sample: '(049) 555 0142' },
  { key: 'customer.email', label: 'Customer email', group: 'Customer', sample: 'purchasing@sample.ph' },
  { key: 'contact.name', label: 'Contact', group: 'Contact', sample: 'Engr. Juan Dela Cruz' },
  { key: 'contact.position', label: 'Contact’s position', group: 'Contact', sample: 'Facilities Head' },
  { key: 'contact.nameAndPosition', label: 'Contact, with their position', group: 'Contact', sample: 'Engr. Juan Dela Cruz, Facilities Head' },
  { key: 'contact.email', label: 'Contact’s email', group: 'Contact', sample: 'juan.delacruz@sample.ph' },
  { key: 'contact.phone', label: 'Contact’s phone, else mobile', group: 'Contact', sample: '0917 555 0142' },
  { key: 'site.name', label: 'Site', group: 'Site', sample: 'Laguna Plant' },
  { key: 'site.address', label: 'Site address', group: 'Site', sample: 'Lot 5 Phase 2, Light Industry Park, Laguna' },
  { key: 'owner.name', label: 'Prepared by', group: 'Prepared by', sample: 'Maria Santos' },
  { key: 'owner.position', label: 'Their position', group: 'Prepared by', sample: 'Sales Engineer' },
  { key: 'owner.email', label: 'Their email', group: 'Prepared by', sample: 'maria.santos@gruntech.com' },
  { key: 'owner.phone', label: 'Their phone', group: 'Prepared by', sample: '0917 555 0100' },
];

/** Every field a quotation layout may name. */
export const QUOTATION_FIELD_KEYS = new Set([...COMPANY_FIELDS, ...PAGE_FIELDS, ...QUOTATION_FIELDS].map((f) => f.key));

/**
 * What a layout is previewed with when no quotation is chosen. `long` runs to
 * several pages, so the running header, the repeated table head and the page
 * numbers can be seen too.
 */
export function quotationSample(long = false): DesignData {
  const fields = Object.fromEntries(QUOTATION_FIELDS.map((f) => [f.key, f.sample ?? '']));
  const line = (n: number, title: string, body: string, qty: number, unit: string, price: number, group: string) => ({
    cells: {
      no: String(n),
      product: { title, body },
      qtyUnit: `${qty} ${unit}`,
      qty: String(qty),
      unit,
      unitPrice: price.toLocaleString('en-PH', { minimumFractionDigits: 2 }),
      amount: (price * qty).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
      group,
    },
  });
  const rows: DesignData['rows'] = [
    { heading: 'General Requirements' },
    line(1, 'Air compressor, 37 kW rotary screw', 'Oil-injected, 8 bar, with refrigerated dryer and 1,000 L receiver tank.', 1, 'unit', 98_000, 'Equipment'),
    line(2, 'Installation and commissioning', 'Labour, tools and consumables; start-up, testing and turnover.', 1, 'lot', 27_000, 'Services'),
  ];
  if (long) {
    rows.push({ heading: 'Piping and accessories' });
    for (let i = 3; i <= 34; i++) {
      rows.push(line(i, `Pipe fitting, item ${i}`, 'Galvanised, schedule 40, threaded both ends.', 2, 'pcs', 350, 'Materials'));
    }
  }
  return {
    title: 'Quotation (sample)',
    fields,
    rows,
    totals: [
      { label: 'Sub Total:', value: '125,000.00' },
      { label: 'VAT (12%):', value: '15,000.00' },
      { label: 'Total Price (PHP):', value: '140,000.00', bold: true },
    ],
    signatories: [
      {
        role: 'Prepared by',
        name: 'Maria Santos',
        position: 'Sales Engineer',
        phone: '0917 555 0100',
        email: 'maria.santos@gruntech.com',
        at: new Date('2026-10-02T01:30:00Z'),
      },
      { role: 'Approved by' },
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
 * Quotation_Template, as boxes: the logo top-left with the company beside it,
 * QUOTATION and the green number top-right, a green rule, CUSTOMER and DETAILS
 * side by side, the lines, the totals under the last columns, Delivery, the
 * terms and notes when there are any, the thank-you line, the dated sign-offs
 * on the last page, and the rule and strapline along the foot of every page.
 */
export const STANDARD_QUOTATION_DESIGN: PdfDesign = {
  version: 1,
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
      text: 'QUOTATION', size: 24, color: PURPLE, align: 'right',
    }),
    text({
      id: 'number', name: 'Quote number', anchor: 'first', x: 374.28, y: 62, w: 185, h: 12,
      text: '# {{quotation.number}}', size: 10, bold: true, color: GREEN, align: 'right',
    }),
    { id: 'rule-top', name: 'Rule under the letterhead', type: 'line', anchor: 'first', x: L, y: 114.25, w: W, h: 1.5, color: GREEN },
    text({
      id: 'customer-heading', name: 'CUSTOMER heading', anchor: 'first', x: L, y: 137, w: 246, h: 10,
      text: 'CUSTOMER', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      id: 'customer', name: 'Customer', anchor: 'first', x: L, y: 159, w: 246, h: 47,
      text: ['**{{customer.name}}**', '{{customer.address}}', '{{customer.phone}}', 'Attention: {{contact.nameAndPosition}}'].join('\n'),
      size: 9.5, lineGap: 1,
    }),
    text({
      id: 'details-heading', name: 'DETAILS heading', anchor: 'first', x: 302, y: 137, w: 257.28, h: 10,
      text: 'DETAILS', size: 8.5, bold: true, color: PURPLE,
    }),
    text({
      id: 'details', name: 'Details', anchor: 'first', x: 302, y: 159, w: 257.28, h: 41,
      text: ['Date: {{quotation.date}}', 'Payment Terms: {{quotation.paymentTerms|—}}', 'PR Number: {{quotation.prNumber|—}}'].join('\n'),
      size: 9.5, bold: true, lineGap: 4,
    }),
    {
      id: 'items', name: 'Lines', type: 'items', anchor: 'first', x: L, y: 223, w: W, h: 250,
      columns: [
        { key: 'product', label: 'Product description', width: 270, align: 'left' },
        { key: 'qtyUnit', label: 'Qty', width: 57.6, align: 'left' },
        { key: 'unitPrice', label: 'Unit price ({{quotation.currency}})', width: 109.4, align: 'right' },
        { key: 'amount', label: 'Total ({{quotation.currency}})', width: 86.28, align: 'right' },
      ],
      size: 9, headColor: PURPLE, headingColor: GREEN, textColor: INK, bodyColor: '#555555', ruleColor: RULE,
    },
    {
      id: 'totals', name: 'Totals', type: 'totals', anchor: 'after', x: 327.48, y: 491, w: 231.8, h: 79,
      size: 9, labelWidth: 129.6, textColor: INK, accentColor: PURPLE, ruleColor: RULE,
    },
    text({
      id: 'delivery', name: 'Delivery', anchor: 'after', x: L, y: 586, w: W, h: 10.4,
      text: '**Delivery:** {{quotation.delivery|—}}', size: 9,
    }),
    text({
      id: 'terms', name: 'Terms and conditions', anchor: 'after', x: L, y: 608.5, w: W, h: 21.8, showIf: 'quotation.terms',
      text: '**Terms and Conditions:**\n{{quotation.terms}}', size: 9, lineGap: 1,
    }),
    text({
      id: 'notes', name: 'Notes', anchor: 'after', x: L, y: 641.8, w: W, h: 21.8, showIf: 'quotation.notes',
      text: '**Notes:**\n{{quotation.notes}}', size: 9, lineGap: 1,
    }),
    text({
      id: 'thanks', name: 'Thank-you line', anchor: 'after', x: L, y: 674.5, w: W, h: 8.1,
      text:
        'Thank you very much for the opportunity to provide the following quotation. ' +
        'This document is system generated and does not require signature.',
      size: 7, italic: true,
    }),
    { id: 'rule-end', name: 'Rule after the text', type: 'line', anchor: 'after', x: L, y: 694.2, w: W, h: 0.75, color: RULE },
    {
      // The role, the name in bold 10pt, then the contact number, the email
      // and when — 58pt, ending 10pt above the footer rule.
      id: 'signoffs', name: 'Sign-offs', type: 'signoffs', anchor: 'last', x: L, y: 714, w: W, h: 60,
      size: 8, colWidth: 133, headColor: PURPLE, textColor: INK,
      nameSize: 10, showPosition: false, showPhone: true, showEmail: true,
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
      text: '{{customer.name}}   ·   Quotation # {{quotation.number}}   ·   {{quotation.date}}', size: 8, color: GREY, align: 'center',
    }),
  ],
};

/**
 * The layout quotations print with: the administrator's, or the standard one.
 * A stored layout that no longer reads — written by an older version, edited
 * by hand — prints the standard rather than failing every quotation, and says
 * so to whoever opens the editor.
 */
export async function quotationDesign(): Promise<{ design: PdfDesign; saved: boolean; unreadable: boolean }> {
  const row = await prisma.setting.findUnique({ where: { key: QUOTATION_TEMPLATE_KEY } });
  if (!row) return { design: STANDARD_QUOTATION_DESIGN, saved: false, unreadable: false };
  const design = readDesign(row.value);
  if (!design) {
    console.warn(`[pdf] ${QUOTATION_TEMPLATE_KEY} does not read as a layout; printing the standard one`);
    return { design: STANDARD_QUOTATION_DESIGN, saved: false, unreadable: true };
  }
  return { design, saved: true, unreadable: false };
}
