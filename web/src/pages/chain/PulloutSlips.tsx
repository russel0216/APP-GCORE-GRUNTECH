import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';

/**
 * Pull-out slips (2026-10-14, the owner's call: "Pull-out Slip — approved
 * Sales Order, or from Purchase Request"; "if no project was created, the
 * sales order is enough"). Stock leaves a warehouse against an issued sales
 * order (the customer's delivery) or an approved project request (taken from
 * the shelf instead of bought). The list, the slip page (`/new?salesOrder=`
 * or `?request=`, `/:id/edit` on a draft) and the record page; the API is
 * `routes/pullouts.ts`.
 */

export const PULLOUT_TONES = { PULLED_OUT: 'ok', PENDING_APPROVAL: 'warn' } as const;

interface PulloutRow {
  id: string;
  number: string;
  kind: 'SALES_ORDER' | 'PURCHASE_REQUEST';
  status: string;
  pulloutDate: string;
  receivedByName: string | null;
  salesOrder: { id: string; number: string; customer: { name: string } } | null;
  request: { id: string; number: string } | null;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
  preparedBy: { id: string; name: string };
  lineCount: number;
  quantity: number;
}

export function PulloutSlips() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const columns: Column<PulloutRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'against',
      label: 'Against',
      render: (r) =>
        r.salesOrder ? (
          <div>
            <div className="mono">{r.salesOrder.number}</div>
            <div className="faint">{r.salesOrder.customer.name}</div>
          </div>
        ) : (
          <div>
            <div className="mono">{r.request?.number}</div>
            <div className="faint">Purchase request</div>
          </div>
        ),
    },
    { key: 'job', label: 'Project', render: (r) => r.job?.number ?? <span className="faint">—</span> },
    { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse.name },
    { key: 'pulloutDate', label: 'Date', sortKey: 'pulloutDate', render: (r) => formatDate(r.pulloutDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'receivedBy', label: 'Received by', render: (r) => r.receivedByName ?? <span className="faint">—</span> },
    { key: 'preparedBy', label: 'Prepared by', render: (r) => r.preparedBy.name, optional: true },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={PULLOUT_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Pull-out Slips</h1>
        </div>
      </div>
      <DataList<PulloutRow>
        listKey="pullout-slips"
        endpoint="/pullout-slips"
        printPath="/api/pullout-slips/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, sales order, customer, request…"
        onRowClick={(r) => navigate(`/g-chain/pullout-slips/${r.id}`)}
        emptyTitle="No pull-out slips yet"
        emptyHint="Raise one from an issued sales order or an approved project request."
        selectable
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'PULLED_OUT', label: 'Pulled out' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
          {
            key: 'kind',
            label: 'Against',
            options: [
              { value: 'SALES_ORDER', label: 'Sales orders' },
              { value: 'PURCHASE_REQUEST', label: 'Purchase requests' },
            ],
          },
        ]}
        summary={(raw, total) => {
          const sum = raw as { pending?: number; pulledOut?: number; drafts?: number };
          return (
            <>
              <Stat label="Pull-out slips" value={total} />
              <Stat label="Waiting for approval" value={sum.pending ?? 0} to="/g-chain/pullout-slips?status=PENDING_APPROVAL" />
              <Stat label="Pulled out" value={sum.pulledOut ?? 0} to="/g-chain/pullout-slips?status=PULLED_OUT" />
              <Stat label="Drafts" value={sum.drafts ?? 0} accent="quiet" to="/g-chain/pullout-slips?status=DRAFT" />
            </>
          );
        }}
        actions={
          can('gchain.pullout_slips.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/g-chain/pullout-slips/new')}>
              + New pull-out slip
            </button>
          ) : null
        }
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SLIP PAGE
// ════════════════════════════════════════════════════════════════════

interface SourceLine {
  id: string;
  title: string;
  description: string;
  partNumber: string | null;
  unit: string;
  quantity: number;
  left: number;
  itemId: string | null;
}

interface SourceData {
  source: {
    kind: 'SALES_ORDER' | 'PURCHASE_REQUEST';
    salesOrderId: string | null;
    requestId: string | null;
    number: string;
    label: string;
    job: { id: string; number: string; name: string } | null;
    lines: SourceLine[];
  };
  warehouses: { id: string; code: string; name: string }[];
  items: { id: string; code: string; partNumber: string | null; name: string; unit: string; available: number }[];
}

interface Pick {
  include: boolean;
  itemId: string;
  quantity: string;
}

/** Asks which document a new slip pulls against, when the link named none. */
function PickSource({ onPick }: { onPick: (kind: 'SALES_ORDER' | 'PURCHASE_REQUEST', id: string) => void }) {
  const [kind, setKind] = useState<'SALES_ORDER' | 'PURCHASE_REQUEST'>('SALES_ORDER');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<{ id: string; number: string; label: string; date: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<typeof rows>(`/pullout-slips/sources${qs({ kind, q: term.trim() || undefined })}`)
        .then((r) => live && setRows(r))
        .catch((err) => live && setError(err));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [kind, term]);
  return (
    <section className="card" aria-labelledby="po-pick">
      <h2 id="po-pick" className="card-title">
        What does it pull out against?
      </h2>
      <div className="scope-switch" role="group" aria-label="Against">
        <button type="button" className={kind === 'SALES_ORDER' ? 'active' : ''} aria-pressed={kind === 'SALES_ORDER'} onClick={() => setKind('SALES_ORDER')}>
          An issued sales order
        </button>
        <button type="button" className={kind === 'PURCHASE_REQUEST' ? 'active' : ''} aria-pressed={kind === 'PURCHASE_REQUEST'} onClick={() => setKind('PURCHASE_REQUEST')}>
          An approved project request
        </button>
      </div>
      <div className="qe-rows">
        <Field label="Find">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={kind === 'SALES_ORDER' ? 'Order number, customer or PO no.' : 'Request number, project or purpose'} />
        </Field>
      </div>
      <ErrorBox error={error} />
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Nothing to pull out against" hint={kind === 'SALES_ORDER' ? 'Only an issued sales order is pulled out against.' : 'Only an approved project request not yet wholly ordered.'} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.number}</td>
                  <td>{r.label}</td>
                  <td>{formatDate(r.date)}</td>
                  <td className="right">
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => onPick(kind, r.id)}>
                      Choose
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

/**
 * One page for a new slip and a draft one being modified: the warehouse, the
 * date, who receives it and — for each line of the source still to pull out
 * — the item from what that warehouse holds and the quantity. Save takes the
 * person to the slip, where it is submitted for approval (or, with the route
 * switched off, pulled out).
 */
export function PulloutEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const salesOrderParam = params.get('salesOrder');
  const requestParam = params.get('request');
  const [existing, setExisting] = useState<Record<string, unknown> | null>(null);
  const [data, setData] = useState<SourceData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [form, setForm] = useState({ warehouseId: '', pulloutDate: '', receivedByName: '', notes: '' });
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  useBackLink(editing ? `/g-chain/pullout-slips/${id}` : '/g-chain/pullout-slips', editing ? (existing ? String(existing.number) : 'the slip') : 'Pull-out Slips');
  useUnsavedChanges(dirty && !busy);

  // The slip being modified, then its source; or the source the link names.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let slip: Record<string, unknown> | null = null;
        let soId = salesOrderParam;
        let prId = requestParam;
        let warehouseId = '';
        if (editing) {
          slip = await api.get<Record<string, unknown>>(`/pullout-slips/${id}`);
          soId = (slip.salesOrderId as string | null) ?? null;
          prId = (slip.requestId as string | null) ?? null;
          warehouseId = (slip.warehouse as { id: string }).id;
        }
        if (!soId && !prId) return;
        const loaded = await api.get<SourceData>(
          `/pullout-slips/source${qs({ salesOrderId: soId ?? undefined, requestId: prId ?? undefined, slipId: editing ? id : undefined })}`,
        );
        if (!live) return;
        warehouseId = warehouseId || (loaded.warehouses.length === 1 ? loaded.warehouses[0].id : '');
        const withStock = warehouseId
          ? await api.get<SourceData>(
              `/pullout-slips/source${qs({ salesOrderId: soId ?? undefined, requestId: prId ?? undefined, slipId: editing ? id : undefined, warehouseId })}`,
            )
          : loaded;
        if (!live) return;
        setData(withStock);
        if (slip) {
          setExisting(slip);
          setForm({
            warehouseId,
            pulloutDate: String(slip.pulloutDate).slice(0, 10),
            receivedByName: typeof slip.receivedByName === 'string' ? slip.receivedByName : '',
            notes: typeof slip.notes === 'string' ? slip.notes : '',
          });
          const items = slip.items as { sourceLineId: string | null; item: { id: string }; quantity: number }[];
          const next: Record<string, Pick> = {};
          for (const l of withStock.source.lines) next[l.id] = { include: false, itemId: l.itemId ?? '', quantity: String(l.left) };
          for (const i of items) if (i.sourceLineId) next[i.sourceLineId] = { include: true, itemId: i.item.id, quantity: String(i.quantity) };
          setPicks(next);
        } else {
          setForm((f) => ({ ...f, warehouseId }));
          setPicks(Object.fromEntries(withStock.source.lines.map((l) => [l.id, { include: l.left > 0, itemId: l.itemId ?? '', quantity: String(l.left) }])));
        }
      } catch (err) {
        if (live) setError(err);
      }
    })();
    return () => {
      live = false;
    };
  }, [editing, id, salesOrderParam, requestParam]);

  // A warehouse chosen: what it holds now.
  async function chooseWarehouse(warehouseId: string) {
    setForm((f) => ({ ...f, warehouseId }));
    setDirty(true);
    if (!data || !warehouseId) return;
    try {
      const fresh = await api.get<SourceData>(
        `/pullout-slips/source${qs({
          salesOrderId: data.source.salesOrderId ?? undefined,
          requestId: data.source.requestId ?? undefined,
          slipId: editing ? id : undefined,
          warehouseId,
        })}`,
      );
      setData(fresh);
    } catch (err) {
      setError(err);
    }
  }

  const itemById = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!editing && !salesOrderParam && !requestParam) {
    return (
      <div className="prq">
        <section className="card qe-card prq-head-card">
          <div className="qe-head">
            <div>
              <h1 className="qe-heading">New pull-out slip</h1>
              <p className="muted qe-lead">Stock out of a warehouse against an issued sales order, or an approved project request.</p>
            </div>
          </div>
        </section>
        <PickSource onPick={(kind, sid) => setParams(kind === 'SALES_ORDER' ? { salesOrder: sid } : { request: sid })} />
      </div>
    );
  }
  if (!data) return <Loading />;
  if (editing && existing && existing.canEdit !== true) {
    return (
      <div className="card">
        <p className="muted">{`${String(existing.number)} is no longer a draft — ${existing.status === 'PENDING_APPROVAL' ? 'pull it back from ⋯ on its page to change it' : 'it holds still'}.`}</p>
      </div>
    );
  }

  const { source } = data;
  const chosen = source.lines.filter((l) => picks[l.id]?.include);
  const problems: string[] = [];
  if (!form.warehouseId) problems.push('choose the warehouse');
  if (!chosen.length) problems.push('tick at least one line');
  for (const l of chosen) {
    const p = picks[l.id];
    const q = Number(p.quantity);
    if (!p.itemId) problems.push(`choose the item for "${l.title}"`);
    else if (!(q > 0)) problems.push(`give a quantity for "${l.title}"`);
    else if (q > l.left + 0.0005) problems.push(`only ${l.left} ${l.unit} of "${l.title}" is left`);
    else {
      const it = itemById.get(p.itemId);
      if (it && q > it.available + 0.0005) problems.push(`only ${it.available} ${it.unit} of ${it.name} is available`);
    }
  }

  async function save() {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      kind: source.kind,
      salesOrderId: source.salesOrderId,
      requestId: source.requestId,
      warehouseId: form.warehouseId,
      pulloutDate: form.pulloutDate || null,
      receivedByName: form.receivedByName.trim() || null,
      notes: form.notes.trim() || null,
      lines: chosen.map((l) => ({ sourceLineId: l.id, itemId: picks[l.id].itemId, quantity: Number(picks[l.id].quantity) })),
    };
    try {
      if (editing && existing) {
        await api.put(`/pullout-slips/${id}/sheet`, { ...body, version: existing.updatedAt });
        setDirty(false);
        toast('ok', `${String(existing.number)} saved`);
        navigate(`/g-chain/pullout-slips/${id}`);
      } else {
        const created = await api.post<{ id: string; number: string; needsApproval: boolean }>('/pullout-slips', body);
        setDirty(false);
        toast('ok', created.needsApproval ? `${created.number} saved — submit it for approval` : `${created.number} saved — pull it out from its page`);
        navigate(`/g-chain/pullout-slips/${created.id}`);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const setPick = (lineId: string, patch: Partial<Pick>) => {
    setPicks((ps) => ({ ...ps, [lineId]: { ...ps[lineId], ...patch } }));
    setDirty(true);
  };
  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );
  const stock = data.items.filter((i) => i.available > 0);

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="po-heading">
        <div className="qe-head">
          <div>
            <h1 id="po-heading" className="qe-heading">
              {editing && existing ? `Modify pull-out slip ${String(existing.number)}` : 'New pull-out slip'}
            </h1>
            <p className="muted qe-lead">
              Against{' '}
              {source.kind === 'SALES_ORDER' ? (
                <Link to={`/g-ops/sales-orders/${source.salesOrderId}`}>{source.label}</Link>
              ) : (
                <Link to={`/g-chain/purchase-requests/${source.requestId}`}>{source.label}</Link>
              )}
              {source.job ? (
                <>
                  {' '}
                  — {source.job.number} is charged at the warehouse's average cost
                </>
              ) : source.kind === 'SALES_ORDER' ? (
                ' — no project was built from its quotation, so the order is the whole reference'
              ) : null}
              .
            </p>
          </div>
          <div className="row qe-actions">{saveButton}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="po-details">
        <h2 id="po-details" className="card-title">
          Pull-out details
        </h2>
        <div className="qe-header qe-rows prq-rows">
          <Field label="Warehouse" required error={attempted && !form.warehouseId ? 'Choose the warehouse' : null}>
            <select value={form.warehouseId} required onChange={(e) => void chooseWarehouse(e.target.value)}>
              <option value="">— choose —</option>
              {data.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={form.pulloutDate}
              onChange={(e) => {
                setForm((f) => ({ ...f, pulloutDate: e.target.value }));
                setDirty(true);
              }}
            />
          </Field>
          <Field label="Received by" hint="Who takes it — the customer's or the project's representative">
            <input
              value={form.receivedByName}
              maxLength={200}
              onChange={(e) => {
                setForm((f) => ({ ...f, receivedByName: e.target.value }));
                setDirty(true);
              }}
            />
          </Field>
        </div>
        <div className="qe-rows">
          <Field label="Notes">
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => {
                setForm((f) => ({ ...f, notes: e.target.value }));
                setDirty(true);
              }}
            />
          </Field>
        </div>
      </section>

      <section className="card" aria-labelledby="po-lines">
        <h2 id="po-lines" className="card-title">
          Lines of {source.number}
        </h2>
        {!form.warehouseId ? (
          <Empty title="Choose the warehouse first" hint="What it holds, and how much is free, appears beside each line." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th aria-label="Pull out" />
                  <th>Line</th>
                  <th className="right">Left</th>
                  <th>Item from the shelf</th>
                  <th className="right">Available</th>
                  <th className="right proc-col-input">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {source.lines.map((l) => {
                  const p = picks[l.id] ?? { include: false, itemId: '', quantity: '' };
                  const it = itemById.get(p.itemId);
                  return (
                    <tr key={l.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Pull out ${l.title}`}
                          checked={p.include}
                          disabled={l.left <= 0 && !p.include}
                          onChange={(e) => setPick(l.id, { include: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div>{l.title}</div>
                        <div className="faint">
                          {[l.partNumber, l.description].filter(Boolean).join(' · ') || `${l.quantity} ${l.unit}`}
                        </div>
                      </td>
                      <td className="right mono">
                        {l.left} {l.unit}
                      </td>
                      <td>
                        <select
                          aria-label={`Item for ${l.title}`}
                          value={p.itemId}
                          disabled={!p.include}
                          onChange={(e) => setPick(l.id, { itemId: e.target.value })}
                        >
                          <option value="">— choose —</option>
                          {stock.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.code} — {s.name}
                              {s.partNumber ? ` (${s.partNumber})` : ''}
                            </option>
                          ))}
                          {p.itemId && !stock.some((s) => s.id === p.itemId) && <option value={p.itemId}>{it?.name ?? 'Not held in this warehouse'}</option>}
                        </select>
                      </td>
                      <td className="right mono">{it ? `${it.available} ${it.unit}` : <span className="faint">—</span>}</td>
                      <td>
                        <NumberInput
                          kind="quantity"
                          className="mono proc-cell-input"
                          step="0.001"
                          aria-label={`Quantity of ${l.title}`}
                          value={p.quantity}
                          disabled={!p.include}
                          onChange={(e) => setPick(l.id, { quantity: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="page-foot">{saveButton}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SLIP
// ════════════════════════════════════════════════════════════════════

export function PulloutDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [slip, setSlip] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setSlip(await api.get<Record<string, unknown>>(`/pullout-slips/${id}`));
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
  if (!slip) return <ErrorBox error={error ?? new Error('Not found')} />;

  const number = String(slip.number);
  const status = String(slip.status);
  const isDraft = status === 'DRAFT';
  const so = slip.salesOrder as { id: string; number: string; customer: { name: string } } | null;
  const pr = slip.request as { id: string; number: string } | null;
  const job = slip.job as { id: string; number: string; name: string } | null;
  const warehouse = slip.warehouse as { id: string; name: string };
  const releasedBy = slip.releasedBy as { name: string } | null;
  const route = (slip.approvalRoute ?? null) as PreviewRoute | null;
  const items = slip.items as {
    id: string;
    quantity: number;
    item: { id: string; code: string; partNumber: string | null; name: string; unit: string };
    sourceLine: { title: string; unit: string } | null;
  }[];

  async function submit() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/submit`));
    setReload((n) => n + 1);
    toast('ok', `${number} submitted for approval`);
  }
  async function pullOut() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/pull-out`));
    toast('ok', `${number} pulled out`);
  }
  async function withdraw() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/withdraw`));
    setReload((n) => n + 1);
    toast('ok', `${number} pulled back to a draft`);
  }
  async function cancel(reason: string) {
    await api.post(`/pullout-slips/${id}/cancel`, { reason });
    toast('ok', `${number} cancelled`);
    await load();
  }

  const charge = job ? ` ${job.number} is charged at the warehouse's average cost at that moment.` : '';

  return (
    <div>
      <RecordHeader
        type="Pull-out Slip"
        code={number}
        title={so ? so.customer.name : (job ? `${job.number} — ${job.name}` : (pr?.number ?? number))}
        status={status}
        statusExtra={PULLOUT_TONES}
        meta={
          <>
            Against {so ? <Link to={`/g-ops/sales-orders/${so.id}`}>{so.number}</Link> : pr ? <Link to={`/g-chain/purchase-requests/${pr.id}`}>{pr.number}</Link> : '—'}
            {job && so && (
              <>
                {' '}
                · <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link>
              </>
            )}{' '}
            · from {warehouse.name} · {formatDate(String(slip.pulloutDate))}
            {typeof slip.receivedByName === 'string' && slip.receivedByName ? ` · to ${slip.receivedByName}` : ''}
          </>
        }
        actions={
          slip.canSubmit === true ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Submit ${number} for approval?`,
                  body: `Nothing leaves ${warehouse.name} until it is approved.${charge}`,
                  confirmLabel: 'Submit for approval',
                  tone: 'primary',
                  onConfirm: submit,
                })
              }
            >
              Submit for approval
            </button>
          ) : slip.canPullOut === true ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Pull out ${number}?`,
                  body: `The stock leaves ${warehouse.name}.${charge} It cannot be taken back.`,
                  confirmLabel: 'Pull out',
                  tone: 'primary',
                  onConfirm: pullOut,
                })
              }
            >
              Pull out
            </button>
          ) : null
        }
        print={`/api/pullout-slips/${id}/pdf`}
        more={[
          slip.canWithdraw === true && {
            label: 'Pull back to a draft',
            hint: 'Withdraws it from the approver',
            confirm: {
              title: `Pull ${number} back to a draft?`,
              body: 'Its approval is withdrawn and the approver is told. Change it and submit it again.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
          slip.canCancel === true && {
            label: 'Cancel pull-out slip',
            danger: true,
            confirm: {
              title: `Cancel ${number}?`,
              body: 'Nothing has left the shelf. The reason is kept on the slip.',
              confirmLabel: 'Cancel pull-out slip',
              reason: 'required',
              minReason: 3,
              onConfirm: cancel,
            },
          },
        ]}
        modify={slip.canEdit === true ? `/g-chain/pullout-slips/${id}/edit` : undefined}
        confirm={confirm}
      />

      {isDraft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      {(status === 'PENDING_APPROVAL' || status === 'PULLED_OUT') && <DocumentApproval documentType="pullout_slip" documentId={String(id)} reloadToken={reload} />}

      <ErrorBox error={error} />
      {isDraft && <div className="alert info">A draft. Nothing has left {warehouse.name} yet.</div>}
      {status === 'PENDING_APPROVAL' && <div className="alert info">Waiting for approval. Nothing has left {warehouse.name} yet — its approval pulls it out.</div>}
      {status === 'CANCELLED' && typeof slip.cancelReason === 'string' && <div className="alert warn">Cancelled — {slip.cancelReason}</div>}

      <div className="card">
        <h3 className="card-title">Items</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Against</th>
                <th className="right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.item.name}</div>
                    <div className="faint mono">
                      {i.item.code}
                      {i.item.partNumber ? ` · ${i.item.partNumber}` : ''}
                    </div>
                  </td>
                  <td>{i.sourceLine?.title ?? <span className="faint">—</span>}</td>
                  <td className="right mono">
                    {i.quantity} {i.item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {releasedBy && typeof slip.releasedAt === 'string' && (
          <p className="faint proc-card-note">
            Pulled out by {releasedBy.name} on {formatDate(slip.releasedAt)}
          </p>
        )}
      </div>

      {typeof slip.notes === 'string' && slip.notes && (
        <div className="card proc-card">
          <h3 className="card-title">Notes</h3>
          <p className="activity-notes">{slip.notes}</p>
        </div>
      )}

      <Attachments
        entityType="pullout_slip"
        entityId={String(id)}
        title="Delivery receipt and documents"
        hint="The signed delivery receipt or photos of what left — printed behind the slip"
      />
    </div>
  );
}

/**
 * The pull-out slips raised against a sales order or a request — a card on
 * that document's page, for a reader of the register; hidden, never empty,
 * without it (a cross-module card's rule).
 */
export function PulloutCard({ salesOrderId, requestId }: { salesOrderId?: string; requestId?: string }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<PulloutRow[] | null>(null);
  const may = can('gchain.pullout_slips.view_all');
  useEffect(() => {
    if (!may) return;
    let live = true;
    api
      .get<{ rows: PulloutRow[] }>(`/pullout-slips${qs({ salesOrderId, requestId, pageSize: 50 })}`)
      .then((r) => live && setRows(r.rows))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [may, salesOrderId, requestId]);
  if (!may || !rows || rows.length === 0) return null;
  return (
    <div className="card">
      <h3 className="card-title">Pulled out</h3>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>Warehouse</th>
              <th>Date</th>
              <th className="right">Lines</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link className="mono" to={`/g-chain/pullout-slips/${r.id}`}>
                    {r.number}
                  </Link>
                </td>
                <td>{r.warehouse.name}</td>
                <td>{formatDate(r.pulloutDate)}</td>
                <td className="right">{r.lineCount}</td>
                <td>
                  <StatusBadge status={r.status} extra={PULLOUT_TONES} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
