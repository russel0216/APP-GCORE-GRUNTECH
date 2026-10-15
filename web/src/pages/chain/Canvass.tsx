import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';

/**
 * The canvass is the COMPARISON SHEET (2026-10-14, the owner's sample
 * canvass sheet): the request's lines with the REFERENCE BUDGET (the
 * approved request's estimate), a unit cost and amount per supplier, then
 * the total, the SAVINGS against the reference budget (pesos and %) and the
 * lead time and terms. Raised from an RFQ it snapshots the RFQ's lines and
 * quotes ("Refresh from RFQ" copies again while open); raised from a request
 * with no RFQ it compares every line, the suppliers typed on it. The figures
 * are the API's (`shared/canvassMath.ts`).
 */

const CANVASS_TONES = { AWARDED: 'ok' } as const;

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

interface CanvassRow {
  id: string;
  number: string;
  status: string;
  createdAt: string;
  supplierCount: number;
  suppliers: string[];
  awarded: string | null;
  budget: number;
  pick: { name: string; total: number; savings: number; savingsPct: number | null; awarded: boolean; complete: boolean } | null;
  request: { id: string; number: string; purpose: string; job: { id: string; number: string; name: string } | null };
  rfq: { id: string; number: string } | null;
  createdBy: { id: string; name: string };
}

interface CanvassSummary {
  open?: number;
  awarded?: number;
}

const pctText = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}%`);

interface CanvassableRfq {
  id: string;
  number: string;
  status: string;
  request: { number: string; purpose: string; job: { number: string; name: string } | null };
  quotedSuppliers: number;
}

/**
 * "+ New canvass" (2026-10-16, the owner's call: "cannot add at the moment"):
 * the RFQs with quotes in and no live sheet, in the page; picking one opens
 * its comparison sheet — or, past six quoting suppliers, the RFQ page to
 * choose the six.
 */
function NewCanvassPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CanvassableRfq[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .get<CanvassableRfq[]>(`/rfqs/canvassable${q ? `?q=${encodeURIComponent(q)}` : ''}`)
        .then((r) => live && setRows(r))
        .catch((e) => live && setError(e));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  async function start(r: CanvassableRfq) {
    if (r.quotedSuppliers > 6) {
      navigate(`/g-chain/rfq/${r.id}?canvass=1`);
      return;
    }
    setBusy(r.id);
    setError(null);
    try {
      const created = await api.post<{ id: string; number?: string }>('/canvasses', { rfqId: r.id });
      toast('ok', 'Canvass started');
      navigate(`/g-chain/canvass/${created.id}`);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">New canvass — which RFQ does it compare?</h3>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorBox error={error} />
      <Field label="Search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="RFQ or request number, purpose…" autoFocus />
      </Field>
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="faint">
          No RFQ is ready: a canvass compares an RFQ that went out and has at least one quote, with no sheet already open. Record the
          quotes on the <Link to="/g-chain/rfq">RFQ</Link> first.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>RFQ</th>
                <th>For</th>
                <th className="num">Suppliers quoted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.number}</td>
                  <td>
                    {r.request.purpose}
                    <div className="faint mono">
                      {r.request.number}
                      {r.request.job ? ` · ${r.request.job.number}` : ''}
                    </div>
                  </td>
                  <td className="num">{r.quotedSuppliers}</td>
                  <td className="right">
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void start(r)}>
                      {busy === r.id ? 'Starting…' : r.quotedSuppliers > 6 ? 'Choose six…' : 'Start canvass'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Canvasses() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);

  const columns: Column<CanvassRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (c) => <span className="mono">{c.number}</span> },
    {
      key: 'request',
      label: 'For',
      render: (c) => (
        <div>
          <div>{c.request.purpose}</div>
          <div className="faint mono">
            {c.request.number}
            {c.request.job ? ` · ${c.request.job.number}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'rfq', label: 'RFQ', render: (c) => (c.rfq ? <span className="mono">{c.rfq.number}</span> : <span className="faint">—</span>) },
    {
      key: 'suppliers',
      label: 'Suppliers',
      align: 'right',
      render: (c) => (
        <span className={c.supplierCount < 3 ? 'faint' : ''} title={c.suppliers.join(', ')}>
          {c.supplierCount}
        </span>
      ),
    },
    {
      key: 'pick',
      label: 'Awarded / lowest',
      render: (c) =>
        c.pick ? (
          <div>
            <div>{c.pick.name}</div>
            <div className="faint">{c.pick.awarded ? 'awarded' : 'lowest complete quote'}</div>
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
    { key: 'budget', label: 'Reference budget', align: 'right', render: (c) => <span className="mono">{formatMoney(c.budget)}</span> },
    {
      key: 'savings',
      label: 'Savings',
      align: 'right',
      render: (c) =>
        c.pick?.savingsPct != null ? (
          <span className={`mono ${c.pick.savings < 0 ? 'proc-over' : 'proc-best'}`}>{pctText(c.pick.savingsPct)}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    { key: 'createdBy', label: 'Canvassed by', render: (c) => c.createdBy.name },
    { key: 'createdAt', label: 'Date', sortKey: 'createdAt', render: (c) => formatDate(c.createdAt) },
    { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} extra={CANVASS_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Canvass</h1>
        </div>
      </div>
      {adding && <NewCanvassPanel onClose={() => setAdding(false)} />}

      <DataList<CanvassRow>
        listKey="canvasses"
        endpoint="/canvasses"
        printPath="/api/canvasses/pdf"
        reportPath="/g-chain/reports?kind=canvass"
        columns={columns}
        rowKey={(c) => c.id}
        searchPlaceholder="Search number, request, RFQ, supplier…"
        onRowClick={(c) => navigate(`/g-chain/canvass/${c.id}`)}
        emptyTitle="No canvasses yet"
        emptyHint="Start one from an RFQ once the quotes are in."
        actions={
          can('gchain.canvass.create') ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
              + New canvass
            </button>
          ) : undefined
        }
        selectable
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'OPEN', label: 'Open' },
              { value: 'AWARDED', label: 'Awarded' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
        ]}
        summary={(raw, total) => {
          const sum = raw as CanvassSummary;
          return (
            <>
              <Stat label="Canvass sheets" value={total} />
              <Stat label="Open" value={sum.open ?? 0} sub="awaiting an award" />
              <Stat label="Awarded" value={sum.awarded ?? 0} />
            </>
          );
        }}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SHEET
// ════════════════════════════════════════════════════════════════════

interface SheetSupplier {
  id: string;
  isSelected: boolean;
  leadTimeDays: number | null;
  terms: string | null;
  remarks: string | null;
  contactName: string | null;
  contactPhone: string | null;
  quoteRef: string | null;
  total: number;
  quotedCount: number;
  complete: boolean;
  amounts: Record<string, number>;
  budgetOnQuoted: number;
  savings: number;
  savingsPct: number | null;
  supplier: { id: string; code: string; name: string; paymentTerms: string | null; phone: string | null; email: string | null };
  quotes: { id: string; requestItemId: string; unitPrice: number }[];
}

interface CanvassDetailData {
  id: string;
  number: string;
  status: string;
  notes: string | null;
  createdAt: string;
  awardedAt: string | null;
  recommendedRowId: string | null;
  lowestSupplierId: string | null;
  budget: number;
  canEdit: boolean;
  canEditSuppliers: boolean;
  canAward: boolean;
  canRefresh: boolean;
  canCancel: boolean;
  canDelete: boolean;
  createdBy: { id: string; name: string };
  awardedBy: { id: string; name: string } | null;
  rfq: { id: string; number: string; status: string } | null;
  orders: { id: string; number: string; status: string }[];
  request: {
    id: string;
    number: string;
    purpose: string;
    approvedAt: string | null;
    job: { id: string; number: string; name: string } | null;
    warehouse: { id: string; name: string } | null;
    items: {
      id: string;
      partNumber: string | null;
      name: string | null;
      description: string;
      quantity: number;
      unit: string;
      estimatedCost: number;
      estimatedAmount: number;
    }[];
  };
  suppliers: SheetSupplier[];
}

type SheetLineItem = CanvassDetailData['request']['items'][number];
const titleOf = (l: SheetLineItem) => l.name || l.description;
const bodyOf = (l: SheetLineItem) => (l.name && l.description && l.description !== l.name ? l.description : null);

export function CanvassDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [canvass, setCanvass] = useState<CanvassDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [modifying, setModifying] = useState(false);
  const [editingRow, setEditingRow] = useState<SheetSupplier | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCanvass(await api.get<CanvassDetailData>(`/canvasses/${id}`));
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
  if (!canvass) return <ErrorBox error={error ?? new Error('Canvass not found')} />;

  /** Asked in the confirm bar, which shows a refusal — so these throw rather than catching. */
  async function award(rowId: string) {
    if (!canvass) return;
    const res = await api.post<{ supplier: string }>(`/canvasses/${canvass.id}/award/${rowId}`);
    toast('ok', `Awarded to ${res.supplier}`);
    await load();
  }
  async function recommend(rowId: string | null) {
    if (!canvass) return;
    setCanvass(await api.patch<CanvassDetailData>(`/canvasses/${canvass.id}`, { recommendedRowId: rowId }));
  }
  async function refresh() {
    if (!canvass) return;
    setCanvass(await api.post<CanvassDetailData>(`/canvasses/${canvass.id}/refresh`));
    toast('ok', `${canvass.number} refreshed from ${canvass.rfq?.number ?? 'its RFQ'}`);
  }
  async function cancel(reason: string) {
    if (!canvass) return;
    await api.post(`/canvasses/${canvass.id}/cancel`, { reason });
    toast('ok', `${canvass.number} cancelled`);
    await load();
  }
  async function remove() {
    if (!canvass) return;
    await api.del(`/canvasses/${canvass.id}`);
    toast('ok', `${canvass.number} deleted`);
    navigate('/g-chain/canvass');
  }

  const lines = canvass.request.items;
  const winner = canvass.suppliers.find((s) => s.isSelected);
  const recommended = canvass.suppliers.find((s) => s.id === canvass.recommendedRowId);
  const lowest = canvass.suppliers.find((s) => s.id === canvass.lowestSupplierId);
  const mayEditRows = canvass.canEditSuppliers;
  const raiseOrder = winner && !canvass.orders.length && can('gchain.purchase_orders.create');

  const addSupplierButton =
    mayEditRows && canvass.suppliers.length < 6 ? (
      <button className="btn btn-sm" onClick={() => setAdding(true)}>
        + Add supplier
      </button>
    ) : null;

  return (
    <div>
      <RecordHeader
        type="Canvass Sheet"
        code={canvass.number}
        title={canvass.request.purpose}
        status={canvass.status}
        statusExtra={CANVASS_TONES}
        amount={formatMoney(winner ? winner.total : canvass.budget)}
        amountLabel={winner ? 'Awarded total' : 'Reference budget'}
        meta={
          <>
            For <Link to={`/g-chain/purchase-requests/${canvass.request.id}`}>{canvass.request.number}</Link>
            {canvass.rfq && (
              <>
                {' '}
                · <Link to={`/g-chain/rfq/${canvass.rfq.id}`}>{canvass.rfq.number}</Link>
              </>
            )}
            {canvass.request.job && (
              <>
                {' '}
                ·{' '}
                <Link to={`/g-ops/projects/${canvass.request.job.id}`}>
                  {canvass.request.job.number} — {canvass.request.job.name}
                </Link>
              </>
            )}{' '}
            · canvassed by {canvass.createdBy.name} on {formatDate(canvass.createdAt)}
            {winner && canvass.awardedBy && canvass.awardedAt
              ? ` · awarded to ${winner.supplier.name} by ${canvass.awardedBy.name} on ${formatDate(canvass.awardedAt)}`
              : ''}
          </>
        }
        actions={
          raiseOrder ? (
            <button className="btn btn-primary" onClick={() => navigate(`/g-chain/purchase-orders/new?fromCanvass=${canvass.id}`)}>
              Raise order
            </button>
          ) : canvass.canAward && recommended ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Award ${canvass.number} to ${recommended.supplier.name}?`,
                  body: `${recommended.complete ? 'Their quote' : 'Their quote, on the lines they quoted,'} totals ${formatMoney(recommended.total)}. The RFQ closes and the purchase order is raised from the award.`,
                  confirmLabel: 'Award',
                  tone: 'primary',
                  onConfirm: () => award(recommended.id),
                })
              }
            >
              Award to {recommended.supplier.name}
            </button>
          ) : null
        }
        print={`/api/canvasses/${canvass.id}/pdf`}
        more={[
          canvass.canRefresh && {
            label: `Refresh from ${canvass.rfq?.number ?? 'the RFQ'}`,
            hint: 'Copies its quotes and terms again',
            confirm: {
              title: `Refresh ${canvass.number} from ${canvass.rfq?.number ?? 'its RFQ'}?`,
              body: 'Each supplier takes the prices and terms recorded on the RFQ now; a supplier that has quoted since is added, six at most. Prices typed on this sheet are replaced.',
              confirmLabel: 'Refresh',
              tone: 'primary',
              onConfirm: refresh,
            },
          },
          canvass.canCancel && {
            label: 'Cancel canvass',
            danger: true,
            confirm: {
              title: `Cancel ${canvass.number}?`,
              body:
                canvass.status === 'AWARDED'
                  ? 'The award is withdrawn; no order was placed on it. The RFQ opens again and can be canvassed anew.'
                  : 'The quotes stay on it as a record. The request can be canvassed again.',
              confirmLabel: 'Cancel canvass',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
          canvass.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${canvass.number}?`,
              body: 'This cancelled canvass goes for good. Its number is not reused.',
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={canvass.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      {canvass.suppliers.length > 0 && canvass.suppliers.length < 3 && canvass.status === 'OPEN' && (
        <div className="alert info">
          Only {canvass.suppliers.length} supplier{canvass.suppliers.length === 1 ? '' : 's'} so far. Three quotes is the usual
          standard for a defensible award.
        </div>
      )}

      <section className="card" aria-labelledby="cvs-sheet">
        <div className="proc-card-head">
          <h3 id="cvs-sheet" className="card-title">
            Comparison sheet
          </h3>
          {canvass.suppliers.length > 0 && addSupplierButton}
        </div>
        {canvass.suppliers.length === 0 ? (
          <Empty title="No suppliers yet" hint="Add the suppliers whose quotes you have in hand." action={addSupplierButton ?? undefined} />
        ) : (
          <div className="table-wrap">
            <table className="data cvs-sheet">
              <thead>
                <tr className="cvs-group-row">
                  <th colSpan={4} />
                  <th colSpan={2} className="cvs-group">
                    <div>Reference budget</div>
                    <div className="faint cvs-group-sub">approved PR estimate</div>
                  </th>
                  {canvass.suppliers.map((s) => (
                    <th key={s.id} colSpan={2} className={`cvs-group${s.isSelected ? ' cvs-awarded' : ''}`}>
                      <div>
                        <Link to={`/g-chain/suppliers/${s.supplier.id}`}>{s.supplier.name}</Link>
                      </div>
                      <div className="faint cvs-group-sub">
                        {[s.contactPhone ? `Tel ${s.contactPhone}` : null, s.contactName].filter(Boolean).join(' · ') || '—'}
                      </div>
                      <div className="cvs-badges">
                        {s.isSelected && <span className="badge ok">awarded</span>}
                        {!s.isSelected && canvass.recommendedRowId === s.id && <span className="badge info">recommended</span>}
                        {canvass.lowestSupplierId === s.id && <span className="badge">lowest complete</span>}
                        {!s.complete && s.quotedCount > 0 && (
                          <span className="badge warn">
                            {s.quotedCount} of {lines.length} lines
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="cvs-code">Item code</th>
                  <th className="cvs-desc">Description</th>
                  <th>U/M</th>
                  <th className="right">Qty</th>
                  <th className="right">Unit cost</th>
                  <th className="right">Amount</th>
                  {canvass.suppliers.map((s) => (
                    <Fragment key={s.id}>
                      <th className={`right${s.isSelected ? ' cvs-awarded' : ''}`}>Unit cost</th>
                      <th className={`right${s.isSelected ? ' cvs-awarded' : ''}`}>Amount</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const prices = canvass.suppliers.map((s) => s.quotes.find((qq) => qq.requestItemId === l.id)?.unitPrice);
                  const valid = prices.filter((p): p is number => p !== undefined && p > 0);
                  const best = valid.length > 1 ? Math.min(...valid) : null;
                  return (
                    <tr key={l.id}>
                      <td className="mono cvs-code">{l.partNumber ?? ''}</td>
                      <td className="cvs-desc">
                        <strong>{titleOf(l)}</strong>
                        {bodyOf(l) && <div className="faint">{bodyOf(l)}</div>}
                      </td>
                      <td>{l.unit}</td>
                      <td className="right mono">{l.quantity}</td>
                      <td className="right mono faint">{formatMoney(l.estimatedCost)}</td>
                      <td className="right mono faint">{formatMoney(l.estimatedAmount)}</td>
                      {canvass.suppliers.map((s, i) => {
                        const price = prices[i];
                        const tint = s.isSelected ? ' cvs-awarded' : '';
                        return price === undefined ? (
                          <Fragment key={s.id}>
                            <td className={`right faint${tint}`}>—</td>
                            <td className={`right faint${tint}`}>not quoted</td>
                          </Fragment>
                        ) : (
                          <Fragment key={s.id}>
                            <td
                              className={`right mono${price === best ? ' proc-best' : ''}${tint}`}
                              title={price === best ? 'Lowest quote for this line' : undefined}
                            >
                              {formatMoney(price)}
                            </td>
                            <td className={`right mono${tint}`}>{formatMoney(s.amounts[l.id] ?? 0)}</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="cvs-total">
                  <td colSpan={5} className="right">
                    <strong>Total</strong>
                  </td>
                  <td className="right mono">
                    <strong>{formatMoney(canvass.budget)}</strong>
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td key={s.id} colSpan={2} className={`right mono${s.isSelected ? ' cvs-awarded' : ''}`}>
                      <strong>{s.quotedCount ? formatMoney(s.total) : '—'}</strong>
                      {s.quotedCount > 0 && !s.complete && (
                        <div className="faint">
                          {s.quotedCount} of {lines.length} lines
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td colSpan={6} className="right">
                    <strong>Savings vs reference budget</strong>
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td key={s.id} colSpan={2} className={`right mono${s.isSelected ? ' cvs-awarded' : ''}`}>
                      {s.quotedCount ? (
                        <>
                          <strong className={s.savings < 0 ? 'proc-over' : 'proc-best'}>
                            {formatMoney(s.savings)} · {pctText(s.savingsPct)}
                          </strong>
                          {!s.complete && <div className="faint">on the lines quoted</div>}
                        </>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td colSpan={6} className="right faint">
                    Lead time · Terms
                  </td>
                  {canvass.suppliers.map((s) => (
                    <td key={s.id} colSpan={2} className={`right${s.isSelected ? ' cvs-awarded' : ''}`}>
                      {[s.leadTimeDays != null ? `${s.leadTimeDays} day${s.leadTimeDays === 1 ? '' : 's'}` : null, s.terms ?? s.supplier.paymentTerms]
                        .filter(Boolean)
                        .join(' · ') || <span className="faint">—</span>}
                    </td>
                  ))}
                </tr>
                {canvass.suppliers.some((s) => s.remarks || s.quoteRef) && (
                  <tr>
                    <td colSpan={6} className="right faint">
                      Quotation · Remarks
                    </td>
                    {canvass.suppliers.map((s) => (
                      <td key={s.id} colSpan={2} className={`right faint${s.isSelected ? ' cvs-awarded' : ''}`}>
                        {[s.quoteRef, s.remarks].filter(Boolean).join(' · ') || '—'}
                      </td>
                    ))}
                  </tr>
                )}
                {(mayEditRows || canvass.canEdit) && (
                  <tr>
                    <td colSpan={6} />
                    {canvass.suppliers.map((s) => (
                      <td key={s.id} colSpan={2} className="right">
                        <div className="proc-row-actions cvs-actions">
                          {mayEditRows && (
                            <button className="btn btn-sm" aria-label={`Modify ${s.supplier.name}`} onClick={() => setEditingRow(s)}>
                              Modify
                            </button>
                          )}
                          {canvass.canEdit && s.quotedCount > 0 && (
                            <button
                              className="btn btn-sm"
                              aria-pressed={canvass.recommendedRowId === s.id}
                              aria-label={`Recommend ${s.supplier.name}`}
                              onClick={() => void recommend(canvass.recommendedRowId === s.id ? null : s.id).catch(setError)}
                            >
                              {canvass.recommendedRowId === s.id ? 'Recommended' : 'Recommend'}
                            </button>
                          )}
                          {canvass.canAward && (
                            <button
                              className="btn btn-sm"
                              aria-label={`Award to ${s.supplier.name}`}
                              disabled={!s.quotedCount}
                              onClick={() =>
                                confirm.ask({
                                  title: `Award ${canvass.number} to ${s.supplier.name}?`,
                                  body: s.complete
                                    ? `Their quote totals ${formatMoney(s.total)}. The RFQ closes and the purchase order is raised from the award.`
                                    : `Their quote prices ${s.quotedCount} of ${lines.length} lines. The order takes those lines; the rest are left to order.`,
                                  confirmLabel: 'Award',
                                  tone: 'primary',
                                  onConfirm: () => award(s.id),
                                })
                              }
                            >
                              Award
                            </button>
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {lowest && canvass.status === 'OPEN' && (
          <div className="alert info proc-card-note">
            Lowest complete quote: <strong>{lowest.supplier.name}</strong> at {formatMoney(lowest.total)} ({pctText(lowest.savingsPct)} under
            the reference budget). Lead time and terms are shown above — award on the whole picture, not just the number.
          </div>
        )}
      </section>

      {(canvass.notes || canvass.orders.length > 0) && (
        <div className="grid grid-2">
          {canvass.notes && (
            <section className="card proc-card">
              <h3 className="card-title">Remarks</h3>
              <p className="activity-notes">{canvass.notes}</p>
            </section>
          )}
          {canvass.orders.length > 0 && (
            <section className="card proc-card">
              <h3 className="card-title">Purchase order</h3>
              <div className="stack">
                {canvass.orders.map((o) => (
                  <Link key={o.id} to={`/g-chain/purchase-orders/${o.id}`} className="row">
                    <span className="mono">{o.number}</span>
                    <StatusBadge status={o.status} />
                    <span className="faint">raised at the awarded prices</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {adding && (
        <AddSupplierModal
          canvassId={canvass.id}
          existing={canvass.suppliers.map((s) => s.supplier.id)}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {editingRow && (
        <SupplierRowModal
          canvassId={canvass.id}
          supplierRow={editingRow}
          items={lines}
          onClose={() => setEditingRow(null)}
          onSaved={() => {
            setEditingRow(null);
            void load();
          }}
        />
      )}

      {modifying && (
        <CanvassNotesModal
          canvass={canvass}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            toast('ok', `${canvass.number} updated`);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddSupplierModal({
  canvassId,
  existing,
  onClose,
  onSaved,
}: {
  canvassId: string;
  existing: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // One more supplier to compare: anyone on the master not already on it.
  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [form, setForm] = useState({ leadTimeDays: '', terms: '', contactName: '', contactPhone: '' });

  async function save() {
    if (!supplier) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/canvasses/${canvassId}/suppliers`, {
        supplierId: supplier.id,
        leadTimeDays: form.leadTimeDays === '' ? null : Number(form.leadTimeDays),
        terms: form.terms || null,
        contactName: form.contactName.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add supplier"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !supplier}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Supplier" required>
        <SupplierPicker value={supplier} onChange={setSupplier} onError={setError} exclude={existing} autoFocus />
      </Field>
      <div className="grid grid-2">
        <Field label="Contact person">
          <input value={form.contactName} maxLength={200} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
        </Field>
        <Field label="Tel No.">
          <input value={form.contactPhone} maxLength={60} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
        </Field>
        <Field label="Lead time (days)">
          <NumberInput kind="count" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} />
        </Field>
        <Field label="Terms">
          <input value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * The canvass's own remarks, while it is open — printed on the sheet. Which
 * request it canvasses is what it is, and an award is the decision on
 * record, so nothing else on the header changes.
 */
function CanvassNotesModal({ canvass, onClose, onSaved }: { canvass: CanvassDetailData; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notes, setNotes] = useState(canvass.notes ?? '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/canvasses/${canvass.id}`, { notes: notes.trim() || null });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify canvass ${canvass.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Remarks" hint="Printed on the sheet: why the recommendation, anything the award should weigh">
        <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * One supplier on an open sheet: whom it names, their lead time, terms and
 * remarks, and the price they quoted per line (a quote received by phone is
 * typed here too). Saved as two calls — the row, then the prices — and
 * removing the supplier is in the foot, behind a question.
 */
function SupplierRowModal({
  canvassId,
  supplierRow,
  items,
  onClose,
  onSaved,
}: {
  canvassId: string;
  supplierRow: SheetSupplier;
  items: SheetLineItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [row, setRow] = useState({
    leadTimeDays: supplierRow.leadTimeDays == null ? '' : String(supplierRow.leadTimeDays),
    terms: supplierRow.terms ?? '',
    remarks: supplierRow.remarks ?? '',
    contactName: supplierRow.contactName ?? '',
    contactPhone: supplierRow.contactPhone ?? '',
  });
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.id, String(supplierRow.quotes.find((qq) => qq.requestItemId === i.id)?.unitPrice ?? '')])),
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const patch = {
        leadTimeDays: row.leadTimeDays === '' ? null : Number(row.leadTimeDays),
        terms: row.terms.trim() || null,
        remarks: row.remarks.trim() || null,
        contactName: row.contactName.trim() || null,
        contactPhone: row.contactPhone.trim() || null,
      };
      if (
        patch.leadTimeDays !== supplierRow.leadTimeDays ||
        patch.terms !== supplierRow.terms ||
        patch.remarks !== supplierRow.remarks ||
        patch.contactName !== supplierRow.contactName ||
        patch.contactPhone !== supplierRow.contactPhone
      ) {
        await api.patch(`/canvasses/${canvassId}/suppliers/${supplierRow.id}`, patch);
      }
      await api.put(`/canvasses/${canvassId}/suppliers/${supplierRow.id}/quotes`, {
        quotes: Object.entries(prices)
          .filter(([, v]) => v !== '')
          .map(([requestItemId, v]) => ({ requestItemId, unitPrice: Number(v) })),
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const total = items.reduce((s, i) => s + Math.round(i.quantity * (Number(prices[i.id]) || 0) * 100) / 100, 0);

  return (
    <Modal
      wide
      title={`Modify supplier ${supplierRow.supplier.name}`}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          // A supplier added to the sheet by mistake leaves it here, with
          // their prices. The modal opens only while the canvass is open.
          danger={{
            label: 'Remove',
            question: `Remove ${supplierRow.supplier.name} from this canvass? Their prices go with them.`,
            onConfirm: async () => {
              await api.del(`/canvasses/${canvassId}/suppliers/${supplierRow.id}`);
              toast('ok', `${supplierRow.supplier.name} removed`);
              onSaved();
            },
          }}
        >
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Contact person">
          <input value={row.contactName} maxLength={200} onChange={(e) => setRow({ ...row, contactName: e.target.value })} />
        </Field>
        <Field label="Tel No.">
          <input value={row.contactPhone} maxLength={60} onChange={(e) => setRow({ ...row, contactPhone: e.target.value })} />
        </Field>
        <Field label="Lead time (days)">
          <NumberInput kind="count" min="0" value={row.leadTimeDays} onChange={(e) => setRow({ ...row, leadTimeDays: e.target.value })} />
        </Field>
        <Field label="Terms" hint={supplierRow.supplier.paymentTerms ? `Supplier default: ${supplierRow.supplier.paymentTerms}` : undefined}>
          <input value={row.terms} onChange={(e) => setRow({ ...row, terms: e.target.value })} />
        </Field>
      </div>
      <Field label="Remarks">
        <input value={row.remarks} onChange={(e) => setRow({ ...row, remarks: e.target.value })} />
      </Field>
      <p className="muted">
        Leave a line blank if they did not quote it. An incomplete quote is left out of the lowest-total comparison, and its saving
        is measured on the lines it quoted.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Qty</th>
              <th className="right proc-col-input">Unit price</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{titleOf(i)}</td>
                <td className="right mono">
                  {i.quantity} {i.unit}
                </td>
                <td>
                  <NumberInput
                    kind="money"
                    step="0.01"
                    className="mono proc-cell-input"
                    aria-label={`Unit price for ${titleOf(i)}`}
                    value={prices[i.id] ?? ''}
                    onChange={(e) => setPrices({ ...prices, [i.id]: e.target.value })}
                  />
                </td>
                <td className="right mono">{prices[i.id] ? formatMoney(Math.round(i.quantity * Number(prices[i.id]) * 100) / 100) : '—'}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="right">
                <strong>Total</strong>
              </td>
              <td className="right mono">
                <strong>{formatMoney(total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
