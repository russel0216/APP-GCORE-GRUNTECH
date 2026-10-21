import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  humanise,
  statusTone,
  StatusBadge,
  Empty,
  ErrorBox,
  Loading,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { DocumentApproval, DecisionNote } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { RFQ_TONES } from './Rfq';
import { PulloutCard } from './PulloutSlips';
import { Attachments } from '../../components/Attachments';
import { OrderSpendPanel, type OrderSpend } from './PurchaseRequisitionEditor';

export const PR_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'PARTIALLY_ORDERED', label: 'Partly ordered' },
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/**
 * Re-exported so the dozen call sites across G-CHAIN keep working, but the
 * rules now live in one place for the whole application. This copy, and eight
 * others like it, had already drifted apart.
 */
export { statusTone };

/** `humanise` under the name G-CHAIN already calls it. */
export const label = humanise;

/**
 * The register lives under both menus (G-OPS for the people who raise
 * requests, G-CHAIN for the people who work them). Every link out of it stays
 * in the menu it was opened from, so the sidebar does not jump modules.
 */
function usePrBase(): string {
  const { pathname } = useLocation();
  return pathname.startsWith('/g-ops') ? '/g-ops/purchase-requests' : '/g-chain/purchase-requests';
}

interface PrRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  purpose: string;
  neededBy: string | null;
  createdAt: string;
  job: { id: string; number: string; name: string } | null;
  salesOrder?: { id: string; number: string; customer: { name: string } } | null;
  warehouse: { id: string; name: string } | null;
  requestedBy: { id: string; name: string };
  itemCount: number;
  estimatedTotal: number;
  canvassCount: number;
  orderCount: number;
}

export function PurchaseRequests() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const base = usePrBase();
  const [params] = useSearchParams();
  // The old `?new=1&jobId=` hand-off (a link saved before the requisition
  // became a page) opens the page with the same preset.
  if (params.get('new') === '1') {
    const jobId = params.get('jobId');
    return <Navigate to={`${base}/new${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ''}`} replace />;
  }

  const columns: Column<PrRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'purpose',
      label: 'Request',
      render: (r) => (
        <div>
          <div>{r.purpose}</div>
          <div className="faint">
            {r.job
              ? `${r.job.number} — ${r.job.name}`
              : r.salesOrder
                ? `${r.salesOrder.number} — ${r.salesOrder.customer.name}`
                : (r.warehouse?.name ?? 'Stock')}
          </div>
        </div>
      ),
    },
    {
      key: 'kind',
      label: 'Type',
      render: (r) => (
        <span
          className="badge"
          title={
            r.kind === 'DIRECT_TO_JOB'
              ? 'Charges the project when received'
              : r.kind === 'SALES_ORDER'
                ? 'Bought for a sales order — no project'
                : 'Charges a project when issued from stock'
          }
        >
          {r.kind === 'DIRECT_TO_JOB' ? 'direct to job' : r.kind === 'SALES_ORDER' ? 'sales order' : 'stock'}
        </span>
      ),
    },
    { key: 'items', label: 'Lines', align: 'right', render: (r) => r.itemCount },
    {
      key: 'estimatedTotal',
      label: 'Estimated',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.estimatedTotal)}</span>,
    },
    { key: 'requestedBy', label: 'Raised by', render: (r) => r.requestedBy.name },
    { key: 'neededBy', label: 'Needed by', sortKey: 'neededBy', render: (r) => formatDate(r.neededBy) },
    {
      key: 'progress',
      label: 'Sourcing',
      render: (r) =>
        r.orderCount > 0 ? (
          <span className="badge ok">{r.orderCount} order{r.orderCount === 1 ? '' : 's'}</span>
        ) : r.canvassCount > 0 ? (
          <span className="badge info">canvassing</span>
        ) : (
          <span className="faint">—</span>
        ),
      optional: true,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Purchase Requests</h1>
        </div>
      </div>

      <DataList<PrRow>
        listKey="purchase-requests"
        endpoint="/purchase-requests"
        printPath="/api/purchase-requests/pdf"
        reportPath="/g-chain/reports?kind=purchase-requests"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, purpose, project, sales order…"
        onRowClick={(r) => navigate(`${base}/${r.id}`)}
        emptyTitle="No purchase requests yet"
        emptyHint="Direct to job charges the project when the goods arrive; stock replenishment charges one only when it is issued."
        filters={[
          { key: 'status', label: 'Status', options: PR_STATUSES },
          {
            key: 'kind',
            label: 'Type',
            options: [
              { value: 'DIRECT_TO_JOB', label: 'Direct to job' },
              { value: 'SALES_ORDER', label: 'For a sales order' },
              { value: 'STOCK_REPLENISHMENT', label: 'Stock replenishment' },
            ],
          },
        ]}
        actions={
          can('gchain.purchase_requests.create') ? (
            <Link className="btn btn-primary btn-sm" to={`${base}/new`}>
              + New purchase request
            </Link>
          ) : null
        }
      />

    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

interface PrItem {
  id: string;
  name: string | null;
  partNumber: string | null;
  description: string;
  quantity: number;
  unit: string;
  estimatedCost: number;
  estimatedAmount: number;
  orderedQty: number;
  /** Taken from the shelf by a pull-out slip instead of bought (2026-10-14). */
  pulledQty: number;
  item: { id: string; code: string; name: string } | null;
  costCategory: { id: string; code: string; name: string } | null;
}

interface PrDetail {
  id: string;
  number: string;
  kind: string;
  status: string;
  purpose: string;
  neededBy: string | null;
  notes: string | null;
  preferredSupplier: string | null;
  createdAt: string;
  /** DRAFT and the caller may change it (its requester, or edit_all). */
  canEdit: boolean;
  /** PENDING_APPROVAL and the caller may pull it back to draft. */
  canWithdraw: boolean;
  canCancel: boolean;
  estimatedTotal: number;
  job: { id: string; number: string; name: string } | null;
  salesOrder?: { id: string; number: string; customer: { name: string } } | null;
  warehouse: { id: string; name: string } | null;
  requestedBy: { id: string; name: string };
  items: PrItem[];
  canvasses: { id: string; number: string; status: string; createdAt: string }[];
  rfqs: { id: string; number: string; status: string; createdAt: string; _count: { suppliers: number; items: number } }[];
  orders: { id: string; number: string; status: string; total: number; supplier: { id: string; name: string } }[];
  budget: Record<string, { budgeted: number; committed: number; incurred: number; available: number }>;
  /** A sales order's purchase: the order's quoted cost and what it has spent (2026-10-21). */
  spend: OrderSpend | null;
}

export function PurchaseRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const base = usePrBase();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [pr, setPr] = useState<PrDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Bumped on every reload so the approval chain re-reads after a submit —
  // the chain lives behind its own endpoint and will not know otherwise.
  const [reload, setReload] = useState(0);

  // A project's request belongs to its project: back goes to the project's
  // Purchase Requisition tab, whichever path opened it (the project tab, the
  // approval notification and My Work all link the G-CHAIN path). Someone who
  // cannot open projects, or a stock replenishment, keeps the menu's register.
  // The tab shows only to a holder of one of its registers' view_all (the
  // project page's own rule); anyone else goes back to the project itself.
  const seesProjects = can('gops.projects.view_all') || can('gops.projects.view_own');
  const seesTab = [
    'gchain.purchase_requests.view_all',
    'gchain.purchase_orders.view_all',
    'gchain.receiving.view_all',
    'gchain.stock_issuance.view_all',
    'gchain.borrow_slips.view_all',
  ].some(can);
  const project = seesProjects && pr?.job ? pr.job : null;
  useBackLink(
    project ? `/g-ops/projects/${project.id}${seesTab ? '?tab=procurement' : ''}` : null,
    project ? (seesTab ? `${project.number} Purchase Requisition` : project.number) : null,
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPr(await api.get<PrDetail>(`/purchase-requests/${id}`));
      setReload((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!pr) return <ErrorBox error={error ?? new Error('Request not found')} />;

  async function submit() {
    if (!pr) return;
    try {
      await api.post(`/purchase-requests/${pr.id}/submit`);
      toast('ok', 'Submitted for approval');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  async function startCanvass() {
    if (!pr) return;
    try {
      const created = await api.post<{ id: string }>('/canvasses', { requestId: pr.id });
      navigate(`/g-chain/canvass/${created.id}`);
    } catch (err) {
      setError(err);
    }
  }

  async function raiseOrder() {
    if (!pr) return;
    navigate(`/g-chain/purchase-orders/new?fromRequest=${pr.id}`);
  }

  // Which budget lines this request would strain.
  const strained = pr.job
    ? pr.items
        .filter((i) => i.costCategory)
        .reduce((acc, i) => {
          const key = i.costCategory!.id;
          acc[key] = (acc[key] ?? 0) + i.estimatedAmount;
          return acc;
        }, {} as Record<string, number>)
    : {};

  // The lines change on the requisition page, with the header — Modify.
  const addLineButton = pr.canEdit ? (
    <Link className="btn btn-sm" to={`${base}/${pr.id}/edit`}>
      Add lines
    </Link>
  ) : null;

  /** Asked in the confirm bar, which shows a refusal — so this throws rather than catching. */
  async function withdraw() {
    if (!pr) return;
    await api.post(`/purchase-requests/${pr.id}/withdraw`);
    toast('ok', `${pr.number} is a draft again`);
    await load();
  }

  const sourcing = pr.status === 'APPROVED' || pr.status === 'PARTIALLY_ORDERED';
  // The API's own rule: a draft or rejected request with no order raised from it.
  const mayDelete =
    (pr.status === 'DRAFT' || pr.status === 'REJECTED' || pr.status === 'CANCELLED') &&
    pr.orders.length === 0 &&
    can('gchain.purchase_requests.delete');

  async function cancel(reason: string) {
    if (!pr) return;
    await api.post(`/purchase-requests/${pr.id}/cancel`, { reason });
    toast('ok', `${pr.number} cancelled`);
    await load();
  }

  /** Asked in the confirm bar, which shows a refusal — so this throws rather than catching. */
  async function remove() {
    if (!pr) return;
    await api.del(`/purchase-requests/${pr.id}`);
    toast('ok', `${pr.number} deleted`);
    navigate(base);
  }

  return (
    <div>
      <RecordHeader
        type="Purchase Request"
        code={pr.number}
        title={pr.purpose}
        status={pr.status}
        amount={formatMoney(pr.estimatedTotal)}
        // Estimated, not contracted: a PR is a request, and what it finally
        // costs is settled at the purchase order.
        amountLabel="Estimated total"
        meta={
          <>
            {pr.kind === 'DIRECT_TO_JOB' ? 'Direct to project' : pr.kind === 'SALES_ORDER' ? 'For a sales order' : 'Stock replenishment'}
            {pr.job ? (
              <>
                {' '}
                ·{' '}
                <Link to={`/g-ops/projects/${pr.job.id}`}>
                  {pr.job.number} — {pr.job.name}
                </Link>
              </>
            ) : pr.salesOrder ? (
              <>
                {' '}
                ·{' '}
                <Link to={`/g-ops/sales-orders/${pr.salesOrder.id}`}>
                  {pr.salesOrder.number} — {pr.salesOrder.customer.name}
                </Link>
              </>
            ) : pr.warehouse ? (
              ` · ${pr.warehouse.name}`
            ) : (
              ''
            )}{' '}
            · requested by {pr.requestedBy.name}
            {pr.neededBy ? ` · needed by ${formatDate(pr.neededBy)}` : ''}
            {pr.preferredSupplier ? ` · preferred supplier ${pr.preferredSupplier}` : ''}
          </>
        }
        actions={
          <>
            {pr.canEdit && can('gchain.purchase_requests.create') && pr.items.length > 0 && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {/* PR › RFQ › Canvass › PO (2026-10-14): asking suppliers is the next step. */}
            {sourcing && can('gchain.rfq.create') && (
              <button className="btn btn-primary" onClick={() => navigate(`/g-chain/rfq/new?fromRequest=${pr.id}`)}>
                Request quotations
              </button>
            )}
            {sourcing && can('gchain.canvass.create') && (
              <button className="btn" onClick={startCanvass}>
                Start canvass
              </button>
            )}
            {sourcing && can('gchain.purchase_orders.create') && (
              <button className={`btn${can('gchain.rfq.create') ? '' : ' btn-primary'}`} onClick={raiseOrder}>
                Raise order
              </button>
            )}
          </>
        }
        print={`/api/purchase-requests/${pr.id}/pdf`}
        more={[
          // A project's request may be filled from the shelf instead of bought (2026-10-14).
          pr.kind === 'DIRECT_TO_JOB' &&
            (pr.status === 'APPROVED' || pr.status === 'PARTIALLY_ORDERED') &&
            can('gchain.pullout_slips.create') && {
              label: 'Pull out from stock…',
              hint: 'Take what the warehouse holds instead of buying it',
              onSelect: () => navigate(`/g-chain/pullout-slips/new?request=${pr.id}`),
            },
          pr.canWithdraw && {
            label: 'Pull back and edit',
            hint: 'Withdraws it from the approver',
            confirm: {
              title: `Pull ${pr.number} back to draft?`,
              body: 'Its approval is withdrawn and the approvers are told. Submit it again once it is changed.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
          pr.canCancel && {
            label: 'Cancel purchase request',
            danger: true,
            confirm: {
              title: `Cancel ${pr.number}?`,
              body:
                pr.status === 'PENDING_APPROVAL'
                  ? 'Its approval is withdrawn and the approvers are told.'
                  : pr.status === 'APPROVED'
                    ? 'Nothing was ordered on it; the budget it committed is released.'
                    : 'Nothing has been approved or ordered on it.',
              confirmLabel: 'Cancel purchase request',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
          mayDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${pr.number}?`,
              body: `This ${pr.status === 'CANCELLED' ? 'cancelled request' : pr.status === 'REJECTED' ? 'rejected request' : 'draft'} goes for good. Its number is not reused.`,
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={pr.canEdit ? `${base}/${pr.id}/edit` : undefined}
        confirm={confirm}
      />

      <DecisionNote documentType="purchase_request" documentId={pr.id} reloadToken={reload} />
      <DocumentApproval documentType="purchase_request" documentId={pr.id} reloadToken={reload} />

      <ErrorBox error={error} />

      {pr.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With the approver. It cannot be changed until they decide
          {pr.canWithdraw ? ' — or pull it back from ⋯ to change it.' : '.'}
        </div>
      )}
      {pr.status === 'APPROVED' && pr.kind === 'DIRECT_TO_JOB' && (
        <div className="alert ok">
          Approved — {formatMoney(pr.estimatedTotal)} is now committed against the project's budget
          at estimated prices. Raising the order replaces that with the price actually agreed.
        </div>
      )}
      {pr.kind === 'SALES_ORDER' && pr.spend && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Against the sales order's quoted cost</h3>
          </div>
          <OrderSpendPanel spend={pr.spend} asked={pr.status === 'DRAFT' ? pr.estimatedTotal : undefined} />
        </div>
      )}

      <div className="card proc-card">
        <div className="card-head">
          <h3 className="card-title">Items requested</h3>
        </div>

        {pr.items.length === 0 ? (
          <Empty
            title="No lines yet"
            hint="Add what is needed, with quantities and estimated cost."
            action={addLineButton ?? undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Budget line</th>
                  <th>Part No.</th>
                  <th>Item</th>
                  <th className="right">Qty</th>
                  <th>Unit</th>
                  <th className="right">Est. cost</th>
                  <th className="right">Est. amount</th>
                  <th className="right">Ordered</th>
                </tr>
              </thead>
              <tbody>
                {pr.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>
                    <td className="mono">{i.partNumber ?? (i.item ? i.item.code : '')}</td>
                    <td>
                      {i.name && i.name !== i.description ? (
                        <>
                          <strong>{i.name}</strong>
                          <div className="faint">{i.description}</div>
                        </>
                      ) : (
                        <strong>{i.name ?? i.description}</strong>
                      )}
                    </td>
                    <td className="right mono">{i.quantity}</td>
                    <td>{i.unit}</td>
                    <td className="right mono">{formatMoney(i.estimatedCost)}</td>
                    <td className="right mono">{formatMoney(i.estimatedAmount)}</td>
                    <td className="right mono faint">
                      {i.orderedQty || '—'}
                      {i.pulledQty > 0 && <div className="faint">{i.pulledQty} from stock</div>}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={6} className="right">
                    <strong>ESTIMATED TOTAL</strong>
                  </td>
                  <td className="right mono">
                    <strong>{formatMoney(pr.estimatedTotal)}</strong>
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pr.notes && (
        <div className="card proc-card">
          <h3 className="card-title">Notes</h3>
          <p className="activity-notes">{pr.notes}</p>
        </div>
      )}

      {pr.job && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(pr.status) && Object.keys(pr.budget).length > 0 && (
        <div className="card proc-card">
          <h3 className="card-title">Against the project budget</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Budget line</th>
                  <th className="right">Budgeted</th>
                  <th className="right">Already committed</th>
                  <th className="right">Available</th>
                  <th className="right">This request</th>
                  <th className="right">After</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pr.budget).map(([categoryId, b]) => {
                  const asked = strained[categoryId] ?? 0;
                  const after = b.available - asked;
                  const category = pr.items.find((i) => i.costCategory?.id === categoryId)?.costCategory;
                  return (
                    <tr key={categoryId}>
                      <td>{category?.name ?? categoryId}</td>
                      <td className="right mono">{formatMoney(b.budgeted)}</td>
                      <td className="right mono">{formatMoney(b.committed)}</td>
                      <td className="right mono">{formatMoney(b.available)}</td>
                      <td className="right mono">{formatMoney(asked)}</td>
                      <td className={`right mono${after < 0 ? ' proc-over' : ''}`}>
                        {formatMoney(after)}
                        {after < 0 && <span className="visually-hidden"> — over budget</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(pr.status === 'DRAFT' || pr.status === 'PENDING_APPROVAL') &&
            Object.entries(pr.budget).some(([id, b]) => (strained[id] ?? 0) > b.available) && (
            <div className="alert error proc-card-note">
              This request exceeds what is left on at least one budget line. Submitting it will be
              blocked — raise a budget request first, or reduce the quantities.
            </div>
          )}
        </div>
      )}

      <PulloutCard requestId={pr.id} />

      {(pr.rfqs.length > 0 || pr.canvasses.length > 0 || pr.orders.length > 0) && (
        <div className="grid grid-2">
          {pr.rfqs.length > 0 && (
            <div className="card">
              <h3 className="card-title">Requests for quotation</h3>
              <div className="stack">
                {pr.rfqs.map((r) => (
                  <Link key={r.id} to={`/g-chain/rfq/${r.id}`} className="row">
                    <span className="mono">{r.number}</span>
                    <StatusBadge status={r.status} extra={RFQ_TONES} />
                    <span>
                      {r._count.suppliers} supplier{r._count.suppliers === 1 ? '' : 's'} · {r._count.items} line{r._count.items === 1 ? '' : 's'}
                    </span>
                    <span className="faint">{formatDate(r.createdAt)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {pr.canvasses.length > 0 && (
            <div className="card">
              <h3 className="card-title">Canvasses</h3>
              <div className="stack">
                {pr.canvasses.map((c) => (
                  <Link key={c.id} to={`/g-chain/canvass/${c.id}`} className="row">
                    <span className="mono">{c.number}</span>
                    <StatusBadge status={c.status} extra={{ AWARDED: 'ok' }} />
                    <span className="faint">{formatDate(c.createdAt)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {pr.orders.length > 0 && (
            <div className="card">
              <h3 className="card-title">Purchase orders</h3>
              <div className="stack">
                {pr.orders.map((o) => (
                  <Link key={o.id} to={`/g-chain/purchase-orders/${o.id}`} className="row">
                    <span className="mono">{o.number}</span>
                    <StatusBadge status={o.status} />
                    <span>{o.supplier.name}</span>
                    <span className="mono faint">{formatMoney(o.total)}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Attachments
        entityType="purchase_request"
        entityId={pr.id}
        title="Attachments"
        hint="The supplier's quotation, a specification or a drawing — printed behind the request"
        canEdit={pr.canEdit || pr.canWithdraw}
      />
    </div>
  );
}
