import { ReportPage, type ReportKind } from '../../components/ReportPage';

/**
 * G-CHAIN › Reports (2026-10-15, the owner's call: "a Report button per
 * menu, any applicable in the list, selectable time range" — monthly
 * incoming goods by quantity and value, supplier monthly total cost, and the
 * like). One report per procurement and warehouse menu on the shared
 * `ReportPage`; the API is `routes/chainReports.ts` on `shared/reportKit.ts`.
 */

/** The reports, in the strips' order; each names the list it reports on. */
export const REPORT_KINDS: readonly ReportKind[] = [
  { key: 'overview', label: 'Overview', list: '/g-chain' },
  { key: 'purchase-requests', label: 'Purchase requests', list: '/g-chain/purchase-requests' },
  { key: 'rfq', label: 'RFQ', list: '/g-chain/rfqs' },
  { key: 'canvass', label: 'Canvass', list: '/g-chain/canvasses' },
  { key: 'purchase-orders', label: 'Purchase orders', list: '/g-chain/purchase-orders' },
  { key: 'incoming', label: 'Incoming', list: '/g-chain/incoming' },
  { key: 'inventory', label: 'Inventory', list: '/g-chain/inventory' },
  { key: 'outgoing', label: 'Outgoing', list: '/g-chain/outgoing' },
  { key: 'borrow', label: 'Borrow slips', list: '/g-chain/borrow-slips' },
  { key: 'pullout', label: 'Pull-out slips', list: '/g-chain/pullout-slips' },
];

export function ChainReports() {
  return <ReportPage title="Supply Chain Reports" endpoint="/chain-reports" kinds={REPORT_KINDS} />;
}
