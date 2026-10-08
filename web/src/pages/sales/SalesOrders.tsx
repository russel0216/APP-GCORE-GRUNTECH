import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ApprovalStepper, DocumentApproval } from '../../components/ApprovalStepper';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { NumberInput } from '../../components/NumberInput';
import {
  Checkbox,
  ErrorBox,
  Field,
  Loading,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
  type Tone,
  PdfButton,
} from '../../components/ui';
import { quotationTotals, type LineMargin } from '../../lib/quotationMath';
import { CostPanelBlock } from './Quotations';
import {
  DiscountCalculator,
  ProductCells,
  partsFromSuggestion,
  productSentence,
  knownGroupOf,
  type KnownGroup,
  blankLine,
  CellError,
  ContactSelect,
  CostCell,
  figure,
  isBlank,
  LeaveBar,
  lineField,
  linePayload,
  moneyOf,
  nextKey,
  numberOk,
  pct,
  Static,
  withTax,
  type Line,
  type Option,
  type ProductSuggestion,
  type TaxOption,
} from './editorParts';

/**
 * SALES ORDERS — SCORO's "Create invoice" under its real name: the document
 * that books a quotation's work in Gruntech operations. Raised from the
 * quotation page; numbered 4622, then 4622.1 for later orders on the same
 * quotation (progress booking). Internal: cost and margin show only to those
 * who may see cost, exactly as on the quotation.
 */

export const SO_TONES: Record<string, Tone> = { DRAFT: 'warn', ISSUED: 'ok' };

interface SoLine {
  id: string;
  group: string | null;
  title: string | null;
  /** The three boxes, copied from the quotation line (2026-10-08). */
  brand?: string | null;
  productType?: string | null;
  partNumber?: string | null;
  description: string;
  isHeading: boolean;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  unitCost?: number | null;
  costAmount?: number | null;
  costNote?: string | null;
  margin?: number | null;
  marginPct?: number | null;
  providerSupplier?: { id: string; name: string } | null;
  providerUser?: { id: string; name: string } | null;
}

export interface SalesOrderRow {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  termsDays: number;
  paymentMethod: string | null;
  referenceNo: string | null;
  poNumber: string | null;
  comment: string | null;
  siNumber: string | null;
  drNumber: string | null;
  cancelReason: string | null;
  discountPct: number;
  vatRate: number;
  vatInclusive: boolean;
  subtotal: number;
  discountAmount: number;
  net: number;
  vatAmount: number;
  total: number;
  customer: { id: string; code: string; name: string };
  contact: { id: string; name: string; position: string | null } | null;
  quotation: { id: string; number: string; subject: string };
  owner: { id: string; name: string };
  createdAt: string;
}

interface ApprovalRoute {
  name: string;
  steps: { name: string; approvers: { id: string; name: string }[] }[];
}

interface SalesOrderDetailRow extends SalesOrderRow {
  lines: SoLine[];
  canEdit: boolean;
  canSeeCost: boolean;
  /** A route is active for sales orders: the order is submitted, not issued. */
  needsApproval?: boolean;
  /** Optional routes the submitter may tick — "Add the CEO as approver". */
  approvalOptions?: { id: string; label: string }[];
  approvalRoutes?: { standard: ApprovalRoute | null; options: { id: string; route: ApprovalRoute | null }[] } | null;
  costPanel?: { totalCost: number; inHouseCost: number; outsourcedCost: number; totalMargin: number };
}

/** The statuses, as the list's tabs — in the order an order lives them. */
const SO_STATUS_TABS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface SalesOrderListRow extends SalesOrderRow {
  /** Only for a viewer who may see this order's cost; null otherwise or when no line is costed. */
  margin: { amount: number; pct: number | null; costedLines: number; lineCount: number } | null;
}

interface SalesOrderSummary {
  count?: number;
  value?: number;
  cancelledCount?: number;
  /** Only where the viewer may see every listed order's cost. */
  margin?: { amount: number; pct: number | null; costed: number };
  /** The viewer's team's share of the booked value; only for a viewer with a team. */
  team?: { count: number; value: number };
}

/**
 * The sales order list, in the quotation list's layout (2026-10-08): the
 * statuses as tabs with their counts, one Filters panel, customer, PO and the
 * release references in columns of their own, a totals line of the booked
 * value, the printed list and mass actions. The tabs, the totals and the
 * paper all come from the server's one list query.
 */
export function SalesOrders() {
  const navigate = useNavigate();
  const { me, can } = useAuth();
  const [owners, setOwners] = useState<{ value: string; label: string }[]>([]);

  const seesAll = can('gops.sales_orders.view_all');
  // Whoever may edit sales orders opens on their own; a reader — finance,
  // releasing what was booked — opens on all of them. A link's ?scope= wins.
  const mayEdit = can('gops.sales_orders.edit_own') || can('gops.sales_orders.edit_all');
  const seesCost = mayEdit || can('gops.costing.view_all');

  useEffect(() => {
    if (!seesAll) return;
    api
      .get<{ id: string; name: string }[]>(`/users/lookup${qs({ holding: 'gops.sales_orders.create' })}`)
      .then((people) => setOwners(people.map((p) => ({ value: p.id, label: p.name }))))
      .catch(() => setOwners([]));
  }, [seesAll]);

  const columns: Column<SalesOrderListRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '120px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'quotation',
      label: 'Quotation',
      render: (r) => (
        <div>
          <div>{r.quotation.subject}</div>
          <div className="faint mono">{r.quotation.number}</div>
        </div>
      ),
    },
    { key: 'customer', label: 'Customer', sortKey: 'customer', render: (r) => r.customer.name },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={SO_TONES} /> },
    { key: 'po', label: 'PO', render: (r) => r.poNumber ?? <span className="faint">—</span> },
    {
      key: 'release',
      label: 'SI / DR',
      optional: true,
      render: (r) => [r.siNumber, r.drNumber].filter(Boolean).join(' / ') || <span className="faint">—</span>,
    },
    {
      key: 'total',
      label: 'Total',
      sortKey: 'total',
      align: 'right',
      render: (r) => (
        <span className={`mono${r.status === 'CANCELLED' ? ' faint' : ''}`} title={r.status === 'CANCELLED' ? 'Cancelled — books nothing' : undefined}>
          {formatMoney(r.total)}
        </span>
      ),
    },
    ...(seesCost
      ? [
          {
            key: 'margin',
            label: 'Margin',
            align: 'right' as const,
            render: (r: SalesOrderListRow) =>
              r.margin ? (
                <span title={`${r.margin.costedLines} of ${r.margin.lineCount} lines costed`}>
                  <span className="mono">{formatMoney(r.margin.amount)}</span>
                  {r.margin.pct !== null && <div className="faint">{r.margin.pct}%</div>}
                </span>
              ) : (
                <span className="faint">—</span>
              ),
          },
        ]
      : []),
    { key: 'owner', label: 'Booked by', render: (r) => r.owner.name },
    { key: 'orderDate', label: 'Date', sortKey: 'orderDate', render: (r) => formatDate(r.orderDate) },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', optional: true, render: (r) => formatDate(r.createdAt) },
    {
      key: 'pdf',
      label: 'PDF',
      align: 'center',
      width: '56px',
      render: (r) => <PdfButton path={`/api/sales-orders/${r.id}/pdf`} label={`Open the PDF of ${r.number}`} />,
    },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: SO_STATUS_TABS },
    // Declared before its people arrive, so a linked ?ownerId= is read on mount (rule 16).
    ...(seesAll ? [{ key: 'ownerId', label: 'Booked by', options: owners }] : []),
    ...(can('gops.customers.view_all')
      ? [
          {
            key: 'customerId',
            label: 'Customer',
            type: 'lookup' as const,
            placeholder: 'Type a customer name or code…',
            search: async (term: string) =>
              (await api.get<{ id: string; code: string; name: string }[]>(`/customers/lookup${qs({ q: term })}`)).map(
                (c) => ({ value: c.id, label: `${c.name} · ${c.code}` }),
              ),
            describe: async (id: string) => {
              const c = await api.get<{ name: string; code: string }>(`/customers/${id}`);
              return `${c.name} · ${c.code}`;
            },
          },
        ]
      : []),
    { key: 'dateFrom', toKey: 'dateTo', label: 'Order date', type: 'dateRange' },
    {
      key: 'released',
      label: 'Released',
      options: [
        { value: 'yes', label: 'SI or DR number filled in' },
        { value: 'no', label: 'Not yet released' },
      ],
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Orders</h1>
        </div>
      </div>

      <DataList<SalesOrderListRow>
        listKey="sales-orders"
        endpoint="/sales-orders"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        defaultScope={mayEdit ? 'mine' : 'all'}
        searchPlaceholder="Search number, PO, SI/DR, customer, quotation…"
        onRowClick={(r) => navigate(`/g-ops/sales-orders/${r.id}`)}
        emptyTitle="Nothing booked yet"
        emptyHint="Open a quotation and press Create Sales Order — that is where one starts."
        filters={filters}
        printPath="/api/sales-orders/pdf"
        selectable
        rowLabel={(r) => `${r.number} ${r.quotation.subject}`}
        teamScope={!!me?.user.team && can('gops.sales_orders.view_all')}
        summary={(raw, total, scope) => {
          const s = raw as SalesOrderSummary;
          return (
            <>
              <Stat label="Orders" value={total} sub={s.cancelledCount ? `${s.cancelledCount} cancelled, not counted` : undefined} />
              <Stat label="Booked value" value={formatMoney(s.value ?? 0)} figure />
              {s.margin && (
                <Stat
                  label="Margin"
                  value={formatMoney(s.margin.amount)}
                  figure
                  sub={`${s.margin.pct !== null ? `${s.margin.pct}% · ` : ''}${s.margin.costed} costed`}
                />
              )}
              {s.team && scope !== 'team' && (
                <Stat label="My team" value={s.team.count} sub={formatMoney(s.team.value)} />
              )}
            </>
          );
        }}
      />
    </div>
  );
}

// ── One order ────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sales-row">
      <span className="sales-row-label">{label}</span>
      <span>{value ?? <span className="faint">—</span>}</span>
    </div>
  );
}

export function SalesOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [order, setOrder] = useState<SalesOrderDetailRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setOrder(await api.get<SalesOrderDetailRow>(`/sales-orders/${id}`));
      setError(null);
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!order) return error ? <ErrorBox error={error} /> : <Loading />;

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await run();
      toast('ok', done);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const showCost = order.canSeeCost;
  const draft = order.status === 'DRAFT';
  const pending = order.status === 'PENDING_APPROVAL';
  const chosenOption = optionId && (order.approvalOptions ?? []).some((o) => o.id === optionId) ? optionId : null;
  const route = (chosenOption ? order.approvalRoutes?.options.find((o) => o.id === chosenOption)?.route : null) ?? order.approvalRoutes?.standard ?? null;

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/sales-orders">Sales Orders</Link>
        <span className="sep">›</span>
        <span className="mono">{order.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            Sales Order <span className="mono">{order.number}</span>
          </h1>
          <p>
            <StatusBadge status={order.status} extra={SO_TONES} />
            <span className="sales-after-badge">
              {order.customer.name} · per{' '}
              <Link to={`/g-ops/quotations/${order.quotation.id}`} className="mono">
                {order.quotation.number}
              </Link>{' '}
              · booked by {order.owner.name}
            </span>
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => openPdf(`/api/sales-orders/${order.id}/pdf`, () => setError(new Error('The PDF could not be made')))}>
            PDF
          </button>
          {order.canEdit && draft && (
            <Link className="btn" to={`/g-ops/sales-orders/${order.id}/edit`}>
              Modify
            </Link>
          )}
          {order.canEdit && draft && !order.needsApproval && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.post(`/sales-orders/${order.id}/issue`), 'Issued — the sale is booked')}>
              Issue
            </button>
          )}
          {order.canEdit && draft && order.needsApproval && (
            <>
              {(order.approvalOptions ?? []).map((o) => (
                <label key={o.id} className="checkbox">
                  <input type="checkbox" checked={optionId === o.id} onChange={(e) => setOptionId(e.target.checked ? o.id : null)} />
                  <span>{o.label}</span>
                </label>
              ))}
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => act(() => api.post(`/sales-orders/${order.id}/submit`, { optionId: chosenOption }), 'Sent for approval')}
              >
                Submit for approval
              </button>
            </>
          )}
          {order.canEdit && pending && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/sales-orders/${order.id}/withdraw`), 'Pulled back to draft')}>
              Pull back and edit
            </button>
          )}
          {order.canEdit && order.status === 'ISSUED' && (
            <button className="btn" disabled={busy} onClick={() => act(() => api.post(`/sales-orders/${order.id}/reopen`), 'Back to draft')}>
              Reopen
            </button>
          )}
          {order.canEdit && order.status !== 'CANCELLED' && (
            <button className="btn btn-danger" onClick={() => setCancelling((v) => !v)}>
              Cancel order
            </button>
          )}
          {order.canEdit && (draft || order.status === 'CANCELLED') && can('gops.sales_orders.delete') && (
            <button className="btn btn-danger" onClick={() => setRemoving((v) => !v)}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />
      {order.canEdit && draft && order.needsApproval && !!route?.steps.length && (
        // The route the submit would take — the CEO's when it is ticked —
        // with who decides each step, named before anybody presses Submit,
        // exactly as the quotation page shows it.
        <div className="qd-route">
          <span className="qd-route-label">Submit for approval sends it to</span>
          <ApprovalStepper
            steps={route.steps.map((st) => ({
              label: st.name,
              approver: st.approvers.length ? st.approvers.map((p) => p.name).join(' or ') : 'Nobody — no one else holds this role',
              status: 'WAITING',
            }))}
          />
        </div>
      )}
      {(pending || order.status === 'ISSUED') && <DocumentApproval documentType="sales_order" documentId={order.id} reloadToken={reload} />}

      {cancelling && (
        <div className="alert warn row so-confirm">
          <span>Cancelling keeps the record and its number — say why:</span>
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} aria-label="Why it is cancelled" />
          <button
            className="btn btn-sm btn-danger"
            disabled={busy || cancelReason.trim().length < 3}
            onClick={() =>
              act(() => api.post(`/sales-orders/${order.id}/cancel`, { reason: cancelReason.trim() }), 'Cancelled').then(() => setCancelling(false))
            }
          >
            Cancel this order
          </button>
          <button className="btn btn-sm" onClick={() => setCancelling(false)}>
            Keep it
          </button>
        </div>
      )}
      {removing && (
        <div className="alert warn row so-confirm">
          <span>Delete this {order.status === 'CANCELLED' ? 'cancelled order' : 'draft'} for good? Its number is not reused.</span>
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.del(`/sales-orders/${order.id}`);
                toast('ok', 'Deleted');
                navigate('/g-ops/sales-orders');
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            Delete
          </button>
          <button className="btn btn-sm" onClick={() => setRemoving(false)}>
            Keep it
          </button>
        </div>
      )}
      {order.status === 'CANCELLED' && order.cancelReason && (
        <div className="alert warn">Cancelled — {order.cancelReason}</div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Order</h3>
          <Row label="Customer" value={order.customer.name} />
          <Row label="Contact" value={order.contact ? `${order.contact.name}${order.contact.position ? `, ${order.contact.position}` : ''}` : null} />
          <Row
            label="Quotation"
            value={
              <Link to={`/g-ops/quotations/${order.quotation.id}`}>
                <span className="mono">{order.quotation.number}</span> — {order.quotation.subject}
              </Link>
            }
          />
          <Row label="Date of issue" value={formatDate(order.orderDate)} />
          <Row label="Payment terms" value={`${order.termsDays} days`} />
          <Row label="Payment method" value={order.paymentMethod} />
          <Row label="PO number" value={order.poNumber} />
          <Row label="Reference" value={order.referenceNo} />
          {order.comment && <Row label="Notes" value={order.comment} />}
        </div>
        <ReleaseCard order={order} onSaved={load} />
      </div>

      <div className="card sales-card-gap">
        <h3 className="card-title">Lines</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Group</th>
                <th>Product and description</th>
                <th className="right">Qty</th>
                <th className="right">Unit price</th>
                <th className="right">Amount</th>
                {showCost && <th className="right">Cost + provider</th>}
                {showCost && <th className="right">Margin</th>}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) =>
                l.isHeading ? (
                  <tr key={l.id} className="so-heading">
                    <td colSpan={showCost ? 7 : 5}>{l.title}</td>
                  </tr>
                ) : (
                  <tr key={l.id}>
                    <td className="faint">{l.group ?? ''}</td>
                    <td>
                      {l.title && <div className="qe-title">{l.title}</div>}
                      {l.description && <div className={l.title ? 'faint' : ''}>{l.description}</div>}
                    </td>
                    <td className="right mono">
                      {l.quantity} {l.unit}
                    </td>
                    <td className="right mono">{formatMoney(l.unitPrice)}</td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                    {showCost && (
                      <td className="right mono">
                        {l.costAmount == null ? <span className="faint">—</span> : formatMoney(l.costAmount)}
                        {(l.providerSupplier || l.providerUser) && (
                          <div className="faint">{l.providerSupplier?.name ?? l.providerUser?.name}</div>
                        )}
                      </td>
                    )}
                    {showCost && (
                      <td className="right mono">{l.margin == null ? <span className="faint">—</span> : formatMoney(l.margin)}</td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div className="so-totals-wrap">
          <dl className="so-totals">
            <dt>Subtotal</dt>
            <dd className="mono">{formatMoney(order.subtotal)}</dd>
            {order.discountAmount > 0 && (
              <>
                <dt>Discount ({order.discountPct}%)</dt>
                <dd className="mono">-{formatMoney(order.discountAmount)}</dd>
              </>
            )}
            <dt>{order.vatInclusive ? `VAT included (${(order.vatRate * 100).toFixed(0)}%)` : `Tax (${(order.vatRate * 100).toFixed(0)}%)`}</dt>
            <dd className="mono">{formatMoney(order.vatAmount)}</dd>
            <dt className="so-grand">Total (PHP)</dt>
            <dd className="mono so-grand">{formatMoney(order.total)}</dd>
          </dl>
          {showCost && order.costPanel && (
            <dl className="so-totals">
              <dt>Total cost</dt>
              <dd className="mono">{formatMoney(order.costPanel.totalCost)}</dd>
              <dt>In-house</dt>
              <dd className="mono">{formatMoney(order.costPanel.inHouseCost)}</dd>
              <dt>Outsourced</dt>
              <dd className="mono">{formatMoney(order.costPanel.outsourcedCost)}</dd>
              <dt className="so-grand">Total margin</dt>
              <dd className="mono so-grand">{formatMoney(order.costPanel.totalMargin)}</dd>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/** SI / BS and DR numbers — filled at release, editable while the order lives. */
function ReleaseCard({ order, onSaved }: { order: SalesOrderDetailRow; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [si, setSi] = useState(order.siNumber ?? '');
  const [dr, setDr] = useState(order.drNumber ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = order.canEdit && order.status !== 'CANCELLED';

  return (
    <div className="card">
      <h3 className="card-title">Released by</h3>
      <p className="faint">The sales invoice / billing statement and delivery receipt this order went out under.</p>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="SI / BS No.">
          <input value={si} disabled={!editable} onChange={(e) => setSi(e.target.value)} />
        </Field>
        <Field label="DR No.">
          <input value={dr} disabled={!editable} onChange={(e) => setDr(e.target.value)} />
        </Field>
      </div>
      {editable && (si !== (order.siNumber ?? '') || dr !== (order.drNumber ?? '')) && (
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.patch(`/sales-orders/${order.id}`, { siNumber: si.trim() || null, drNumber: dr.trim() || null });
              toast('ok', 'Release references saved');
              await onSaved();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save references'}
        </button>
      )}
    </div>
  );
}

// ── The editor — SCORO's invoice edit screen, as a page ──────────────────────

/**
 * SCORO's "Modify" on an invoice, done the way the quotation is modified
 * (2026-10-08, the owner's call): one card, the header in two columns with
 * the labels beside the values, the lines as one row each — group, product
 * over description, quantity beside unit, price, amount with the with-VAT
 * figure under it, cost and provider, margin — the totals beside the cost
 * panel, and Back / Save at both ends. The cells, the line arithmetic and
 * the payload are the quotation editor's own (`editorParts.tsx`), so the two
 * cannot drift. One Save sends the header and every line in one PUT; a line
 * sent back with its id keeps what it books of the quotation.
 */
interface SoHeader {
  orderDate: string;
  termsDays: string;
  paymentMethod: string;
  referenceNo: string;
  poNumber: string;
  comment: string;
  contactId: string;
  discountPct: string;
  vatRate: number;
  vatInclusive: boolean;
}

function fromSoLine(l: SoLine): Line {
  return {
    key: nextKey(),
    isHeading: l.isHeading,
    group: l.group ?? '',
    brand: l.brand ?? '',
    productType: l.productType ?? (l.brand || l.partNumber ? '' : (l.title ?? '')),
    partNumber: l.partNumber ?? '',
    title: l.title ?? '',
    description: l.description ?? '',
    quantity: String(l.quantity),
    unit: l.unit,
    unitPrice: String(l.unitPrice),
    unitCost: l.unitCost == null ? '' : String(l.unitCost),
    providerKind: l.providerUser ? 'user' : l.providerSupplier ? 'supplier' : 'none',
    provider: l.providerUser ?? l.providerSupplier ?? null,
    costNote: l.costNote ?? '',
  };
}

export function SalesOrderEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [order, setOrder] = useState<(SalesOrderDetailRow & { taxOptions?: TaxOption[] }) | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  /** The saved line behind each row — sent back so a line keeps its booking. */
  const [idByKey, setIdByKey] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<KnownGroup[]>([]);
  /** SCORO's discount calculator, open under the totals. */
  const [calcOpen, setCalcOpen] = useState(false);
  const [contacts, setContacts] = useState<Option[]>([]);
  const [header, setHeader] = useState<SoHeader>({
    orderDate: '',
    termsDays: '30',
    paymentMethod: '',
    referenceNo: '',
    poNumber: '',
    comment: '',
    contactId: '',
    discountPct: '0',
    vatRate: 0.12,
    vatInclusive: false,
  });

  useEffect(() => {
    api
      .get<KnownGroup[]>('/reference/quotation-groups?active=true')
      .then((rows) => setGroups(rows.map((g) => ({ name: g.name, description: g.description, brand: g.brand }))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!id) return;
    api
      .get<SalesOrderDetailRow & { taxOptions?: TaxOption[] }>(`/sales-orders/${id}`)
      .then((o) => {
        setOrder(o);
        setHeader({
          orderDate: o.orderDate.slice(0, 10),
          termsDays: String(o.termsDays),
          paymentMethod: o.paymentMethod ?? '',
          referenceNo: o.referenceNo ?? '',
          poNumber: o.poNumber ?? '',
          comment: o.comment ?? '',
          contactId: o.contact?.id ?? '',
          discountPct: String(o.discountPct),
          vatRate: o.vatRate,
          vatInclusive: o.vatInclusive,
        });
        const rows = o.lines.map(fromSoLine);
        setLines(rows.length ? rows : [blankLine()]);
        setIdByKey(Object.fromEntries(rows.map((l, i) => [l.key, o.lines[i].id])));
        api
          .get<{ contacts: Option[] }>(`/customers/${o.customer.id}`)
          .then((c) => setContacts(c.contacts))
          .catch(() => setContacts([]));
      })
      .catch(setLoadError);
  }, [id]);

  // Leaving with unsaved work asks first — the browser's own prompt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof SoHeader>(k: K, v: SoHeader[K]) => {
    setHeader((h) => ({ ...h, [k]: v }));
    setDirty(true);
  };
  function updateLine(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  }
  function addLine(after?: string, heading = false) {
    const fresh = blankLine(heading);
    setLines((ls) => {
      const i = after ? ls.findIndex((l) => l.key === after) : -1;
      return i < 0 ? [...ls, fresh] : [...ls.slice(0, i + 1), fresh, ...ls.slice(i + 1)];
    });
    setDirty(true);
    setTimeout(() => document.getElementById(lineField(fresh.key, 'title'))?.focus(), 0);
  }
  function removeLine(key: string) {
    setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((l) => l.key !== key)));
    setDirty(true);
  }
  function moveLine(key: string, by: -1 | 1) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  }
  /** The dropdown's rows for a line: the master, plus the line's own group when it is not on it. */
  function groupOptions(current: string): KnownGroup[] {
    return current.trim() && !knownGroupOf(groups, current) ? [...groups, { name: current, description: null, brand: null }] : groups;
  }
  function pickGroup(l: Line, name: string) {
    const brand = knownGroupOf(groups, name)?.brand;
    updateLine(l.key, { group: name, ...(brand && !l.brand.trim() ? { brand } : {}) });
  }
  function pickProduct(l: Line, sg: ProductSuggestion) {
    updateLine(l.key, {
      ...partsFromSuggestion(l, sg),
      description: sg.description || l.description,
      unit: sg.unit || l.unit,
      unitPrice: sg.unitPrice != null ? String(sg.unitPrice) : l.unitPrice,
      ...(sg.unitCost != null && l.unitCost.trim() === '' ? { unitCost: String(sg.unitCost) } : {}),
    });
    setTimeout(() => document.getElementById(lineField(l.key, 'quantity'))?.focus(), 0);
  }

  // ── Live figures (the server's arithmetic, mirrored) ──────────────────────
  const priced = useMemo(() => lines.filter((l) => !isBlank(l)), [lines]);
  const totals = useMemo(
    () =>
      quotationTotals({
        lines: priced.map(moneyOf),
        discountPct: figure(header.discountPct),
        vatRate: header.vatRate,
        vatInclusive: header.vatInclusive,
      }),
    [priced, header.discountPct, header.vatRate, header.vatInclusive],
  );
  const marginByKey = new Map<string, LineMargin>(priced.map((l, i) => [l.key, totals.lines[i]]));

  function validate(): { errors: Record<string, string>; first: string | null } {
    const found: Record<string, string> = {};
    const order: string[] = [];
    const flag = (key: string, message: string, fieldId = key) => {
      if (found[key]) return;
      found[key] = message;
      order.push(fieldId);
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(header.orderDate)) flag('orderDate', 'When was it issued?', 'so-orderDate');
    if (!priced.some((l) => !l.isHeading)) flag('lines', 'Add at least one line', lines[0] ? lineField(lines[0].key, 'productType') : 'so-add-line');
    for (const l of priced) {
      if (l.isHeading) continue;
      if (!l.group.trim()) flag(lineField(l.key, 'group'), 'Choose a product group');
      if (!productSentence(l) && !l.title.trim() && !l.description.trim()) {
        flag(lineField(l.key, 'productType'), 'Give the line a brand, product type or part number, or a description');
      }
      if (!numberOk(l.quantity)) flag(lineField(l.key, 'quantity'), 'Quantity must be zero or more');
      if (!numberOk(l.unitPrice)) flag(lineField(l.key, 'unitPrice'), 'Price must be zero or more');
      if (l.unitCost.trim() !== '' && !numberOk(l.unitCost)) flag(lineField(l.key, 'unitCost'), 'Cost must be zero or more');
    }
    const disc = Number(header.discountPct || 0);
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) flag('discountPct', 'A discount from 0 to 100%', 'so-discount');
    return { errors: found, first: order[0] ?? null };
  }

  async function save() {
    const check = validate();
    setErrors(check.errors);
    if (check.first) {
      setError(new Error('Some fields need attention — they are marked below.'));
      document.getElementById(check.first)?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.put(`/sales-orders/${order!.id}`, {
        orderDate: header.orderDate,
        termsDays: Number(header.termsDays) || 0,
        paymentMethod: header.paymentMethod.trim() || null,
        referenceNo: header.referenceNo.trim() || null,
        poNumber: header.poNumber.trim() || null,
        comment: header.comment.trim() || null,
        contactId: header.contactId || null,
        discountPct: Number(header.discountPct || 0),
        vatRate: header.vatRate,
        vatInclusive: header.vatInclusive,
        // The cost keys go only where the caller may see cost; the server
        // ignores them otherwise, and a saved line keeps its booking by id.
        lines: priced.map((l) => {
          const payload = linePayload(l);
          const { unitCost, providerUserId, providerSupplierId, costNote, ...plain } = payload as typeof payload & {
            providerUserId?: string | null;
            providerSupplierId?: string | null;
            costNote?: string | null;
          };
          return {
            ...(idByKey[l.key] ? { id: idByKey[l.key] } : {}),
            ...plain,
            ...(showCost ? { unitCost, providerUserId, providerSupplierId, costNote } : {}),
          };
        }),
      });
      setDirty(false);
      toast('ok', `Saved ${order!.number}`);
      navigate(`/g-ops/sales-orders/${order!.id}`);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  function cancel() {
    if (dirty && !leaving) {
      setLeaving(true);
      return;
    }
    leave();
  }
  function leave() {
    setLeaving(false);
    setDirty(false);
    navigate(`/g-ops/sales-orders/${id}`);
  }

  if (!order) return loadError ? <ErrorBox error={loadError} /> : <Loading />;
  if (!order.canEdit || order.status !== 'DRAFT') {
    return (
      <div className="card">
        <h3 className="card-title">{order.number} cannot be modified</h3>
        <p className="muted">
          {order.status !== 'DRAFT' ? `It is ${order.status.toLowerCase().replace(/_/g, ' ')} — reopen it first.` : 'Only its author can edit it.'}
        </p>
        <Link className="btn" to={`/g-ops/sales-orders/${order.id}`}>
          Back to {order.number}
        </Link>
      </div>
    );
  }

  const showCost = order.canSeeCost;
  const currency = me?.company?.currency ?? 'PHP';
  const pctLabel = (r: number) => `${Number((r * 100).toFixed(2))}%`;
  const serverTax: TaxOption[] = order.taxOptions ?? [{ rate: order.vatRate, label: pctLabel(order.vatRate) }];
  const taxOptions: TaxOption[] = serverTax.some((o) => Math.abs(o.rate - header.vatRate) < 0.00005)
    ? serverTax
    : [...serverTax, { rate: header.vatRate, label: `${pctLabel(header.vatRate)} (this order)` }];

  return (
    <div className="qe">
      <div className="breadcrumb">
        <Link to="/g-ops/sales-orders">Sales Orders</Link>
        <span className="sep">›</span>
        <Link to={`/g-ops/sales-orders/${order.id}`} className="mono">
          {order.number}
        </Link>
        <span className="sep">›</span>
        <span>Modify</span>
      </div>

      <section className="card qe-card" aria-labelledby="so-title">
        <div className="qe-head">
          <div>
            <h1 id="so-title" className="qe-heading">
              Modify sales order details
            </h1>
            <p className="faint qe-lead">Draft. Nothing changes until you save.</p>
          </div>
          <div className="row qe-actions">
            <button type="button" className="btn" onClick={cancel} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {leaving && <LeaveBar onLeave={leave} onStay={() => setLeaving(false)} />}
        <ErrorBox error={error} />

        <div className="qe-header qe-rows">
          <div className="qe-col">
            <Static label="Order No.">
              <span className="mono">{order.number}</span>
            </Static>
            <Field label="Date of issue" required error={errors.orderDate}>
              <input id="so-orderDate" type="date" value={header.orderDate} onChange={(e) => set('orderDate', e.target.value)} />
            </Field>
            {/* SCORO puts the contact beside the customer, on the same line. */}
            <Static label="Customer">
              <div className="qe-client">
                <Link to={`/g-ops/customers/${order.customer.id}`}>{order.customer.name}</Link>
                <ContactSelect contacts={contacts} value={header.contactId} onChange={(v) => set('contactId', v)} />
              </div>
            </Static>
            <Static label="Quotation">
              <Link to={`/g-ops/quotations/${order.quotation.id}`} className="mono">
                {order.quotation.number}
              </Link>{' '}
              {order.quotation.subject}
            </Static>
            <Static label="Author">{order.owner.name}</Static>
            <Field label="Comment" hint="Printed under Notes on the order">
              <textarea rows={3} value={header.comment} onChange={(e) => set('comment', e.target.value)} />
            </Field>
          </div>

          <div className="qe-col">
            <Field label="Payment terms (days)">
              <NumberInput kind="count" min={0} max={365} value={header.termsDays} onChange={(e) => set('termsDays', e.target.value)} />
            </Field>
            <Field label="Payment method">
              <input value={header.paymentMethod} placeholder="e.g. Bank transfer" onChange={(e) => set('paymentMethod', e.target.value)} />
            </Field>
            <Field label="PO Number" hint="The customer's purchase order this books against">
              <input value={header.poNumber} onChange={(e) => set('poNumber', e.target.value)} />
            </Field>
            <Field label="Reference No.">
              <input value={header.referenceNo} onChange={(e) => set('referenceNo', e.target.value)} />
            </Field>
            <Static label="Currency">{currency}</Static>
            <Static label="Status">
              <StatusBadge status={order.status} extra={SO_TONES} />
            </Static>
          </div>
        </div>

        {/* ── Lines ── */}
        <h2 className="visually-hidden">Lines</h2>
        {errors.lines && (
          <div className="alert error" role="alert">
            {errors.lines}
          </div>
        )}
        <div className="table-wrap qe-table-wrap">
          <table className={`data qe-lines${showCost ? '' : ' qe-lines-nocost'}`}>
            <thead>
              <tr>
                <th className="qe-col-move">
                  <span className="visually-hidden">Order</span>
                </th>
                <th className="qe-col-group">Group</th>
                <th className="qe-col-product">Brand | Product type | Part number | Description</th>
                <th className="qe-col-qty">Quantity | Unit</th>
                <th className="qe-col-price right">Unit price</th>
                <th className="qe-col-amount right">Amount</th>
                {showCost && <th className="qe-col-cost">Cost and provider info</th>}
                {showCost && <th className="qe-col-margin right">Margin</th>}
                <th className="qe-col-remove">
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const n = i + 1;
                const m = marginByKey.get(l.key);
                const last = i === lines.length - 1;
                const err = (f: string) => errors[lineField(l.key, f)];
                const amount = m?.amount ?? 0;
                const what = l.isHeading ? `subheading ${n}` : `line ${n}`;
                const moveCell = (
                  <td className="qe-col-move">
                    <div className="qe-move">
                      <span className="mono faint">{n}</span>
                      <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${what} up`} disabled={i === 0} onClick={() => moveLine(l.key, -1)}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${what} down`} disabled={last} onClick={() => moveLine(l.key, 1)}>
                        ↓
                      </button>
                    </div>
                  </td>
                );
                const removeCell = (
                  <td className="qe-col-remove">
                    <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Remove ${what}`} onClick={() => removeLine(l.key)}>
                      ✕
                    </button>
                  </td>
                );
                if (l.isHeading) {
                  return (
                    <tr key={l.key} id={`line-${n}`} className="qe-line-heading">
                      {moveCell}
                      <td colSpan={showCost ? 7 : 5}>
                        <input
                          id={lineField(l.key, 'title')}
                          className="qe-heading-input"
                          aria-label={`Subheading ${n}`}
                          placeholder="Subheading — e.g. General Requirements"
                          value={l.title}
                          aria-invalid={err('title') ? true : undefined}
                          onChange={(e) => updateLine(l.key, { title: e.target.value })}
                        />
                        <CellError message={err('title')} />
                      </td>
                      {removeCell}
                    </tr>
                  );
                }
                return (
                  <tr key={l.key} id={`line-${n}`}>
                    {moveCell}
                    <td>
                      <select
                        id={lineField(l.key, 'group')}
                        className="qe-group-select"
                        aria-label={`Line ${n} group`}
                        aria-invalid={err('group') ? true : undefined}
                        value={knownGroupOf(groups, l.group)?.name ?? l.group}
                        onChange={(e) => pickGroup(l, e.target.value)}
                      >
                        <option value="">— choose —</option>
                        {groupOptions(l.group).map((g) => (
                          <option key={g.name} value={g.name}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      {knownGroupOf(groups, l.group)?.description && <span className="qe-group-hint">{knownGroupOf(groups, l.group)?.description}</span>}
                      <CellError message={err('group')} />
                    </td>
                    <td>
                      <ProductCells
                        line={l}
                        n={n}
                        invalid={!!err('productType')}
                        describedBy={err('productType') ? `${lineField(l.key, 'productType')}-error` : undefined}
                        onChange={(patch) => updateLine(l.key, patch)}
                        onPick={(sg) => pickProduct(l, sg)}
                      />
                      <textarea
                        aria-label={`Line ${n} description`}
                        placeholder="Description"
                        rows={Math.min(10, Math.max(2, l.description.split('\n').length + 1))}
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      />
                      <CellError id={`${lineField(l.key, 'productType')}-error`} message={err('productType')} />
                    </td>
                    <td>
                      <div className="qe-qty">
                        <NumberInput
                          kind="quantity"
                          id={lineField(l.key, 'quantity')}
                          className="qe-num"
                          min={0}
                          step="any"
                          aria-label={`Line ${n} quantity`}
                          value={l.quantity}
                          aria-invalid={err('quantity') ? true : undefined}
                          onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                        />
                        <input aria-label={`Line ${n} unit`} placeholder="lot" value={l.unit} onChange={(e) => updateLine(l.key, { unit: e.target.value })} />
                      </div>
                      <CellError message={err('quantity')} />
                    </td>
                    <td>
                      <NumberInput
                        kind="money"
                        id={lineField(l.key, 'unitPrice')}
                        className="qe-num"
                        min={0}
                        step="0.01"
                        aria-label={`Line ${n} unit price`}
                        value={l.unitPrice}
                        aria-invalid={err('unitPrice') ? true : undefined}
                        onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                          // Enter on the last row's price starts the next line.
                          if (e.key === 'Enter' && last) {
                            e.preventDefault();
                            addLine(l.key);
                          }
                        }}
                      />
                      <CellError message={err('unitPrice')} />
                    </td>
                    <td className="right mono">
                      {formatMoney(amount, currency)}
                      {!header.vatInclusive && header.vatRate > 0 && amount > 0 && (
                        <div className="faint qe-with-vat" title={`With ${pctLabel(header.vatRate)} VAT`}>
                          <span className="visually-hidden">With VAT: </span>
                          {formatMoney(withTax(amount, header.vatRate), currency)}
                        </div>
                      )}
                    </td>
                    {showCost && (
                      <td>
                        <CostCell line={l} n={n} costError={err('unitCost')} amount={m?.costAmount ?? null} currency={currency} onChange={(patch) => updateLine(l.key, patch)} />
                      </td>
                    )}
                    {showCost && (
                      <td className="right mono">
                        {m?.margin == null ? (
                          <span className="faint">—</span>
                        ) : (
                          <>
                            <div className={m.margin < 0 ? 'quote-negative' : undefined}>{formatMoney(m.margin, currency)}</div>
                            <div className="faint">{pct(m.marginPct)}</div>
                          </>
                        )}
                      </td>
                    )}
                    {removeCell}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="row qe-line-actions">
          <button type="button" className="btn btn-sm" onClick={() => addLine(undefined, true)}>
            + Add subheading
          </button>
          <button type="button" id="so-add-line" className="btn btn-sm" onClick={() => addLine()}>
            + Add row
          </button>
        </div>
        <p className="faint sales-hint">
          Type a product and pick from what was quoted before. Enter on the last line’s price adds a line; empty lines are
          left out when you save. A line kept from the quotation keeps what it books of it; a new line books nothing.
          {showCost ? ' Cost, provider and margin are internal — never on the customer’s paper.' : ''}
        </p>

        {/* ── Totals and the cost panel ── */}
        <div className={`quote-summary${showCost && priced.length > 0 ? '' : ' quote-summary-single'}`}>
          <div>
            <dl className="quote-totals" aria-label="Totals">
              <div>
                <dt>Subtotal</dt>
                <dd className="mono">{formatMoney(totals.subtotal, currency)}</dd>
              </div>
              <div>
                <dt>
                  <label className="quote-discount" htmlFor="so-discount">
                    Discount
                    <NumberInput
                      kind="percent"
                      id="so-discount"
                      min={0}
                      max={100}
                      step="any"
                      value={header.discountPct}
                      aria-invalid={errors.discountPct ? true : undefined}
                      onChange={(e) => set('discountPct', e.target.value)}
                    />
                    %
                    <button
                      type="button"
                      className={`btn btn-sm${calcOpen ? ' is-on' : ''}`}
                      aria-label="Discount calculator — set the sum you want"
                      title="Discount calculator — set the sum you want"
                      aria-expanded={calcOpen}
                      onClick={() => setCalcOpen((o) => !o)}
                    >
                      Σ
                    </button>
                  </label>
                </dt>
                <dd className="mono">{totals.discountAmount > 0 ? `−${formatMoney(totals.discountAmount, currency)}` : formatMoney(0, currency)}</dd>
              </div>
              <div>
                <dt>Sum without tax</dt>
                <dd className="mono">{formatMoney(totals.netOfTax, currency)}</dd>
              </div>
              <div>
                <dt>
                  <label className="quote-discount" htmlFor="so-tax">
                    {header.vatInclusive ? 'Tax included' : 'Tax'}
                    <select id="so-tax" value={String(header.vatRate)} onChange={(e) => set('vatRate', Number(e.target.value))}>
                      {taxOptions.map((o) => (
                        <option key={o.rate} value={String(o.rate)}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </dt>
                <dd className="mono">{formatMoney(totals.vatAmount, currency)}</dd>
              </div>
              <div className="quote-totals-grand">
                <dt>Total</dt>
                <dd className="mono">{formatMoney(totals.total, currency)}</dd>
              </div>
            </dl>
            {calcOpen && (
              <DiscountCalculator
                subtotal={totals.subtotal}
                vatRate={header.vatRate}
                vatInclusive={header.vatInclusive}
                currency={currency}
                onInsert={(v) => {
                  set('discountPct', v);
                  setCalcOpen(false);
                }}
                onClose={() => setCalcOpen(false)}
              />
            )}
            {errors.discountPct && <CellError message={errors.discountPct} />}
            <Checkbox checked={header.vatInclusive} onChange={(v) => set('vatInclusive', v)} label="Prices are VAT inclusive — the tax is backed out rather than added on" />
          </div>
          {showCost && priced.length > 0 && <CostPanelBlock panel={totals.cost} />}
        </div>

        {leaving && <LeaveBar onLeave={leave} onStay={() => setLeaving(false)} />}
        <div className="row qe-foot">
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>
    </div>
  );
}
