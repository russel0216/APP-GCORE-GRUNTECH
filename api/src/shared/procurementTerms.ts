import { prisma } from '../prisma';
import type { PdfSection } from './pdf';

/**
 * The standard terms a purchase order and a request for quotation carry
 * (2026-10-21, the owner's call: "category for goods and services, with the
 * terms that are applicable"). One Setting, `procurement.terms`, edited on
 * G-CHAIN › Procurement Settings: the goods terms print where a document has
 * goods lines, the service terms where it has service lines, each under its
 * own title. Blank prints nothing.
 */
export const TERMS_KEY = 'procurement.terms';

export interface ProcurementTerms {
  goods: string;
  services: string;
}

export const DEFAULT_TERMS: ProcurementTerms = {
  goods: [
    'Goods are delivered complete and in good condition to the address on this order, with the delivery receipt and the sales invoice.',
    'Goods found damaged, short or not as ordered are returned or replaced at the supplier’s cost.',
    'Payment follows the terms above, counted from the delivery of the goods in full.',
    'The manufacturer’s warranty applies, and the supplier handles any claim under it.',
  ].join('\n'),
  services: [
    'The service is rendered as described on this order, by qualified personnel, following the site’s safety rules.',
    'The supplier provides its own tools, equipment and consumables unless this order says otherwise.',
    'The work is accepted only once it is completed and signed off as rendered; payment follows the terms above from that acceptance.',
    'Workmanship is guaranteed for 90 days from acceptance: any defect is corrected at the supplier’s cost.',
  ].join('\n'),
};

/** The terms as stored, each falling back to the standard wording when never set. */
export async function procurementTerms(): Promise<ProcurementTerms> {
  const row = await prisma.setting.findUnique({ where: { key: TERMS_KEY } });
  const stored = (row?.value ?? {}) as Partial<ProcurementTerms>;
  return {
    goods: typeof stored.goods === 'string' ? stored.goods : DEFAULT_TERMS.goods,
    services: typeof stored.services === 'string' ? stored.services : DEFAULT_TERMS.services,
  };
}

/** The paper's terms sections for the natures a document's lines carry. */
export async function termsSections(natures: Iterable<string>): Promise<PdfSection[]> {
  const has = new Set(natures);
  const terms = await procurementTerms();
  const out: PdfSection[] = [];
  if (has.has('GOODS') && terms.goods.trim()) out.push({ kind: 'text', title: 'Terms — goods', body: terms.goods.trim() });
  if (has.has('SERVICE') && terms.services.trim()) out.push({ kind: 'text', title: 'Terms — services', body: terms.services.trim() });
  return out;
}
