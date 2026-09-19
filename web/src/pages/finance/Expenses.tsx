import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { RecordPaymentModal, tone, label } from './Receivables';

/**
 * Expense claims — money someone spent out of their own pocket.
 *
 * The only G-FIN document that does not come from an operational one, and so
 * the only one where a person keys the amounts. That is why every line needs a
 * receipt number before it can even be submitted: finance needs an OR against
 * every peso, and finding that out at approval time wastes the approver's
 * round trip.
 */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — awaiting reimbursement' },
  { value: 'REIMBURSED', label: 'Reimbursed' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Claim {
  id: string;
  number: string;
  status: string;
  claimDate: string;
  purpose: string;
  total: number;
  amountPaid: number;
  outstanding: number;
  postedToJob: boolean;
  postedAt: string | null;
  notes: string | null;
  claimedBy: { id: string; name: string; email: string };
  job: { id: string; number: string; name: string } | null;
  costCategory: { id: string; name: string } | null;
  lines: {
    id: string;
    spentOn: string;
    description: string;
    category: string | null;
    receiptNo: string | null;
    amount: number;
  }[];
  allocations?: {
    id: string;
    amount: number;
    payment: { id: string; number: string; paymentDate: string; method: string };
  }[];
}

export function Expenses() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filing, setFiling] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<Claim>[] = [
    {
      key: 'number',
      label: 'Number',
      sortKey: 'number',
      width: '150px',
      render: (r) => <span className="mono">{r.number}</span>,
    },
    {
      key: 'claimedBy',
      label: 'Claimed by',
      render: (r) => (
        <div>
          <div>{r.claimedBy.name}</div>
          <div className="faint">{r.purpose}</div>
        </div>
      ),
    },
    {
      key: 'claimDate',
      label: 'Dated',
      sortKey: 'claimDate',
      render: (r) => formatDate(r.claimDate),
    },
    {
      key: 'job',
      label: 'Charged to',
      render: (r) =>
        r.job ? (
          <div>
            <div className="mono">{r.job.number}</div>
            <div className="faint">{r.costCategory?.name ?? '—'}</div>
          </div>
        ) : (
          <span className="faint">overheads</span>
        ),
    },
    {
      key: 'lines',
      label: 'Lines',
      align: 'right',
      render: (r) => r.lines.length,
      optional: true,
    },
    {
      key: 'total',
      label: 'Claimed',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.total)}</span>,
    },
    {
      key: 'outstanding',
      label: 'Owed back',
      align: 'right',
      render: (r) =>
        r.status === 'APPROVED' ? (
          <span className="mono warn">{formatMoney(r.outstanding)}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <span className={`badge ${tone(r.status)}`}>{label(r.status)}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Expense Claims</h1>
          <p>
            What you spent on the company's behalf, and what it is owed back. Every line needs a
            receipt number — finance needs an OR against every peso, and a claim without one
            cannot be reimbursed.
          </p>
        </div>
      </div>

      <DataList<Claim>
        listKey="expense-claims"
        endpoint="/expense-claims"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        reloadToken={reload}
        searchPlaceholder="Search number, purpose, person…"
        emptyTitle="No claims yet"
        onRowClick={(r) => navigate(`/g-fin/expenses/${r.id}`)}
        filters={[{ key: 'status', label: 'Status', options: STATUSES }]}
        actions={
          can('gfin.expenses.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + New claim
            </button>
          ) : null
        }
      />

      {filing && (
        <NewClaimModal
          onClose={() => setFiling(false)}
          onCreated={(id) => {
            setFiling(false);
            setReload((r) => r + 1);
            navigate(`/g-fin/expenses/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewClaimModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ claimDate: today, purpose: '', jobId: '', costCategoryId: '' });
  const [lines, setLines] = useState([
    { spentOn: today, description: '', category: '', receiptNo: '', amount: 0 },
  ]);

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
    api.get<{ id: string; name: string }[]>('/reference/cost-categories').then(setCategories).catch(() => {});
  }, []);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const missingReceipts = lines.filter((l) => l.description.trim() && !l.receiptNo.trim()).length;

  async function create(submitNow: boolean) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/expense-claims', {
        claimDate: form.claimDate,
        purpose: form.purpose,
        jobId: form.jobId || null,
        costCategoryId: form.jobId ? form.costCategoryId || null : null,
        lines: lines
          .filter((l) => l.description.trim() && l.amount > 0)
          .map((l) => ({
            spentOn: l.spentOn,
            description: l.description,
            category: l.category || null,
            receiptNo: l.receiptNo || null,
            amount: l.amount,
          })),
      });
      if (submitNow) await api.post(`/expense-claims/${created.id}/submit`);
      toast('ok', submitNow ? 'Filed and sent for approval' : 'Saved as a draft');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = form.purpose.trim().length >= 3 && total > 0;

  return (
    <Modal
      title="New expense claim"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={() => create(false)} disabled={busy || !valid}>
            Save draft
          </button>
          <button
            className="btn btn-primary"
            onClick={() => create(true)}
            disabled={busy || !valid || missingReceipts > 0}
          >
            {busy ? 'Filing…' : 'File and send for approval'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Date of claim">
          <input
            type="date"
            value={form.claimDate}
            onChange={(e) => setForm({ ...form, claimDate: e.target.value })}
          />
        </Field>
        <Field label="What was it for?">
          <input
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            placeholder="e.g. site visit to the Cebu plant"
          />
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="Charge to project" hint="Leave empty if it belongs to overheads">
          <select value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
            <option value="">— none —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.number} — {j.name}
              </option>
            ))}
          </select>
        </Field>
        {form.jobId && (
          <Field label="Budget line">
            <select
              value={form.costCategoryId}
              onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
            >
              <option value="">— choose —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <h4 style={{ marginTop: 18, marginBottom: 8 }}>What you spent</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Date</th>
              <th>Description</th>
              <th style={{ width: 120 }}>Kind</th>
              <th style={{ width: 130 }}>Receipt no.</th>
              <th className="right" style={{ width: 120 }}>
                Amount
              </th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const update = (patch: Partial<typeof l>) => {
                const next = [...lines];
                next[i] = { ...l, ...patch };
                setLines(next);
              };
              return (
                <tr key={i}>
                  <td>
                    <input type="date" value={l.spentOn} onChange={(e) => update({ spentOn: e.target.value })} />
                  </td>
                  <td>
                    <input
                      value={l.description}
                      onChange={(e) => update({ description: e.target.value })}
                      placeholder="Fare, meals, accommodation…"
                    />
                  </td>
                  <td>
                    <input value={l.category} onChange={(e) => update({ category: e.target.value })} />
                  </td>
                  <td>
                    <input
                      value={l.receiptNo}
                      onChange={(e) => update({ receiptNo: e.target.value })}
                      placeholder="OR / SI no."
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      value={l.amount}
                      onChange={(e) => update({ amount: Number(e.target.value) })}
                      style={{ textAlign: 'right' }}
                    />
                  </td>
                  <td className="right">
                    {lines.length > 1 && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4} className="right">
                Total
              </th>
              <th className="right mono">{formatMoney(total)}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>
      <button
        className="btn btn-sm"
        style={{ marginTop: 8 }}
        onClick={() =>
          setLines([...lines, { spentOn: today, description: '', category: '', receiptNo: '', amount: 0 }])
        }
      >
        + Add a line
      </button>

      {missingReceipts > 0 && (
        <div className="alert warn" style={{ marginTop: 14, marginBottom: 0 }}>
          {missingReceipts} line{missingReceipts === 1 ? ' has' : 's have'} no receipt number. You
          can save this as a draft, but it cannot be submitted until every peso has an OR against
          it.
        </div>
      )}
    </Modal>
  );
}

// ── One claim ────────────────────────────────────────────────────────────────

export function ExpenseClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const [row, setRow] = useState<Claim | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Claim>(`/expense-claims/${id}`));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!row) return <Loading />;

  const mine = row.claimedBy.id === me?.user.id;

  async function submit() {
    try {
      await api.post(`/expense-claims/${id}/submit`);
      toast('ok', 'Sent for approval');
      load();
    } catch (err) {
      setError(err);
    }
  }

  async function cancel() {
    try {
      await api.post(`/expense-claims/${id}/cancel`);
      toast('ok', 'Cancelled');
      load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/g-fin/expenses')}>
          ← Expense claims
        </button>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="mono">{row.number}</span>{' '}
            <span className={`badge ${tone(row.status)}`}>{label(row.status)}</span>
          </h1>
          <p>
            {row.claimedBy.name} · {row.purpose}
            {row.job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${row.job.id}`} className="mono">
                  {row.job.number}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="row">
          {row.status === 'DRAFT' && mine && (
            <button className="btn btn-primary btn-sm" onClick={submit}>
              Send for approval
            </button>
          )}
          {row.status === 'APPROVED' && can('gfin.ap.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>
              Reimburse
            </button>
          )}
          {(row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL') && mine && (
            <button className="btn btn-danger btn-sm" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {row.status === 'PENDING_APPROVAL' && (
        <div className="alert info">
          With your supervisor, then finance. Nothing is charged to a project and nothing is owed
          until both have approved.
        </div>
      )}
      {row.status === 'APPROVED' && (
        <div className="alert ok">
          Approved. {formatMoney(row.outstanding)} is owed back to {row.claimedBy.name}
          {row.postedToJob && row.job && <> and {formatMoney(row.total)} was charged to {row.job.number}</>}.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">What was spent</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Receipt</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{formatDate(l.spentOn)}</td>
                    <td>
                      <div>{l.description}</div>
                      {l.category && <div className="faint">{l.category}</div>}
                    </td>
                    <td className="mono faint">{l.receiptNo ?? '—'}</td>
                    <td className="right mono">{formatMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3} className="right">
                    Total
                  </th>
                  <th className="right mono">{formatMoney(row.total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Reimbursement</h3>
          <dl className="kv">
            <dt>Claimed</dt>
            <dd className="mono">{formatMoney(row.total)}</dd>
            <dt>Paid back</dt>
            <dd className="mono">{formatMoney(row.amountPaid)}</dd>
            <dt>Still owed</dt>
            <dd className="mono">
              <strong>{formatMoney(row.outstanding)}</strong>
            </dd>
            <dt>Charged to</dt>
            <dd>
              {row.job ? (
                <>
                  <span className="mono">{row.job.number}</span>
                  <span className="faint"> · {row.costCategory?.name ?? 'no budget line'}</span>
                </>
              ) : (
                <span className="faint">overheads — no project charged</span>
              )}
            </dd>
          </dl>

          {row.allocations && row.allocations.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data">
                <tbody>
                  {row.allocations.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <span className="mono">{a.payment.number}</span>
                        <div className="faint">{formatDate(a.payment.paymentDate)}</div>
                      </td>
                      <td className="right mono">{formatMoney(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {paying && (
        <RecordPaymentModal
          kind="DISBURSEMENT"
          party={{ id: row.claimedBy.id, name: row.claimedBy.name }}
          target={{ kind: 'claim', id: row.id, number: row.number, outstanding: row.outstanding }}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            load();
          }}
        />
      )}
    </div>
  );
}
