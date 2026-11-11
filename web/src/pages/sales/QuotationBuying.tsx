import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorBox, StatusBadge, formatMoney, useToast } from '../../components/ui';
import { OfficeLineSelect, useOfficeLines } from '../../components/OfficeLine';
import { OrderSpendPanel, type OrderSpend } from '../chain/PurchaseRequisitionEditor';

/**
 * Bought ahead for a quotation (2026-11-10, the owner's call: "may request on
 * an open quotation till purchase order and incoming … charged once the
 * quotation is won or a sales order filed"; lost: "they are required to
 * allocate to a project with remaining budget, or it can be charged to an
 * office budget line"). The card says what was spent on the quotation — charged
 * to nothing yet — and, once it is LOST, lists what must be given a home:
 * its purchasing (a project with budget left, or the warehouse's stock) and
 * its cash and travel requests (a project, or an office budget line).
 */

export interface QuotationBuyingData {
  spend: (OrderSpend & { charged?: boolean }) | null;
  canRequest: boolean;
  canOrder?: boolean;
  toReallocate: {
    purchasing: {
      requests: { id: string; number: string; status: string; amount: number }[];
      orders: { id: string; number: string; status: string }[];
      amount: number;
      heldValue: number;
    };
    cash: { id: string; number: string; status: string; reason: string; isTravel: boolean; amount: number }[];
  } | null;
  canReallocate: boolean;
}

interface JobOption {
  id: string;
  number: string;
  name: string;
}

export function QuotationBuying({ quotationId, buying, onChanged }: { quotationId: string; buying: QuotationBuyingData; onChanged: () => void }) {
  const spend = buying.spend;
  const touched = !!spend && spend.requested + spend.committed + spend.incurred > 0;
  const pending = buying.toReallocate;
  const owes = !!pending && (pending.purchasing.requests.length > 0 || pending.purchasing.orders.length > 0 || pending.purchasing.heldValue > 0 || pending.cash.length > 0);
  if (!touched && !buying.canRequest && !buying.canOrder && !owes) return null;

  return (
    <div className="card sales-card-gap">
      <div className="card-head">
        <h2 className="card-title">Bought ahead for this quotation</h2>
        {(buying.canRequest || buying.canOrder) && (
          <div className="card-actions">
            {buying.canRequest && (
              <Link className="btn btn-sm" to={`/g-chain/purchase-requests/new?quotation=${quotationId}`}>
                + New purchase request
              </Link>
            )}
            {buying.canOrder && (
              <Link className="btn btn-sm" to={`/g-chain/purchase-orders/new?quotation=${quotationId}`}>
                + New purchase order
              </Link>
            )}
          </div>
        )}
      </div>
      {touched && spend ? (
        <>
          <p className="muted">
            Charged to nothing yet: it moves to the sales order when one is issued on this quotation, or to the project built from it.
          </p>
          <OrderSpendPanel spend={spend} />
        </>
      ) : (
        !owes && <p className="muted">Nothing has been bought ahead. A purchase request may be raised before the customer confirms.</p>
      )}
      {owes && pending && <Reallocate quotationId={quotationId} pending={pending} canReallocate={buying.canReallocate} onChanged={onChanged} />}
    </div>
  );
}

function Reallocate({
  quotationId,
  pending,
  canReallocate,
  onChanged,
}: {
  quotationId: string;
  pending: NonNullable<QuotationBuyingData['toReallocate']>;
  canReallocate: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const offices = useOfficeLines();
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  // One form at a time: 'purchasing', or a cash request's id.
  const [open, setOpen] = useState<string | null>(null);
  const [to, setTo] = useState<'project' | 'other'>('project');
  const [jobId, setJobId] = useState('');
  const [costCategoryId, setCostCategoryId] = useState('');
  const [officeLineId, setOfficeLineId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!canReallocate) return;
    api.get<JobOption[]>('/jobs/lookup').then(setJobs).catch(() => setJobs([]));
    api
      .get<{ id: string; name: string; isActive?: boolean }[]>('/reference/cost-categories')
      .then((c) => setCategories(c.filter((x) => x.isActive !== false)))
      .catch(() => setCategories([]));
  }, [canReallocate]);

  const hasPurchasing = pending.purchasing.requests.length > 0 || pending.purchasing.orders.length > 0 || pending.purchasing.heldValue > 0;

  function start(key: string) {
    setOpen(key);
    setTo('project');
    setError(null);
  }

  async function send(what: 'purchasing' | 'budget_request', requestId?: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/quotations/${quotationId}/reallocate`, {
        what,
        requestId,
        ...(to === 'project' ? { jobId, costCategoryId } : what === 'purchasing' ? { stock: true } : { officeBudgetLineId: officeLineId }),
      });
      toast('ok', 'Re-allocated');
      setOpen(null);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const form = (what: 'purchasing' | 'budget_request', requestId?: string) => (
    <div className="prq-panel stack">
      <div className="grid-2">
        <label className="field">
          <span>Charge it to</span>
          <select value={to} onChange={(e) => setTo(e.target.value as typeof to)}>
            <option value="project">A project with budget left</option>
            <option value="other">{what === 'purchasing' ? 'Warehouse stock (the company keeps the goods)' : 'An office budget line'}</option>
          </select>
        </label>
        {to === 'project' ? (
          <>
            <label className="field">
              <span>Project</span>
              <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">— choose —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.number} — {j.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Budget line</span>
              <select value={costCategoryId} onChange={(e) => setCostCategoryId(e.target.value)}>
                <option value="">— choose —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : what === 'budget_request' ? (
          <label className="field">
            <span>Office budget line</span>
            <OfficeLineSelect budgets={offices} value={officeLineId} onChange={setOfficeLineId} none="— choose —" />
          </label>
        ) : null}
      </div>
      <p className="muted">
        {to === 'project'
          ? 'Refused when the budget line has less left than what is charged — choose a project with budget remaining.'
          : what === 'purchasing'
            ? 'The requests and orders become stock replenishment; goods already received go on the company’s shelf at their cost.'
            : 'It counts against the office budget line from now on.'}
      </p>
      <ErrorBox error={error} />
      <div className="row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || (to === 'project' ? !jobId || !costCategoryId : what === 'budget_request' && !officeLineId)}
          onClick={() => void send(what, requestId)}
        >
          Re-allocate
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setOpen(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="stack">
      <div className="alert warn">
        This quotation is lost. What was spent on it must be charged somewhere: a project with budget left
        {hasPurchasing ? ', the warehouse’s stock for goods bought,' : ''} or an office budget line for cash and travel.
      </div>
      {hasPurchasing && (
        <div>
          <div className="card-head">
            <h3 className="card-title">Purchasing</h3>
            {canReallocate && open !== 'purchasing' && (
              <button type="button" className="btn btn-sm" onClick={() => start('purchasing')}>
                Re-allocate…
              </button>
            )}
          </div>
          <dl className="kv">
            {pending.purchasing.requests.length > 0 && (
              <>
                <dt>Purchase requests</dt>
                <dd>
                  {pending.purchasing.requests.map((r, i) => (
                    <span key={r.id}>
                      {i > 0 && ', '}
                      <Link to={`/g-chain/purchase-requests/${r.id}`}>{r.number}</Link>
                    </span>
                  ))}{' '}
                  · {formatMoney(pending.purchasing.amount)} declared
                </dd>
              </>
            )}
            {pending.purchasing.orders.length > 0 && (
              <>
                <dt>Purchase orders</dt>
                <dd>
                  {pending.purchasing.orders.map((o, i) => (
                    <span key={o.id}>
                      {i > 0 && ', '}
                      <Link to={`/g-chain/purchase-orders/${o.id}`}>{o.number}</Link>
                    </span>
                  ))}
                </dd>
              </>
            )}
            {pending.purchasing.heldValue > 0 && (
              <>
                <dt>Goods received</dt>
                <dd className="mono">{formatMoney(pending.purchasing.heldValue)}</dd>
              </>
            )}
          </dl>
          {open === 'purchasing' && form('purchasing')}
        </div>
      )}
      {pending.cash.map((r) => (
        <div key={r.id}>
          <div className="card-head">
            <h3 className="card-title">
              {r.isTravel ? 'Travel request' : 'Budget request'} <Link to={`/g-ops/budget-requests/${r.id}`}>{r.number}</Link>{' '}
              <StatusBadge status={r.status} />
            </h3>
            {canReallocate && open !== r.id && (
              <button type="button" className="btn btn-sm" onClick={() => start(r.id)}>
                Re-allocate…
              </button>
            )}
          </div>
          <p className="muted">
            {r.reason} · <span className="mono">{formatMoney(r.amount)}</span>
          </p>
          {open === r.id && form('budget_request', r.id)}
        </div>
      ))}
    </div>
  );
}
