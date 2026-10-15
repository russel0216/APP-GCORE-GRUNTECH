import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, formatDateTime, formatMoney, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { todayLocal } from '../../lib/day';

/**
 * OUTGOING — the internal receive proof (2026-10-15, the owner's call:
 * "Outgoing = internal receive proof to the requestor … no customer
 * involved"). Stock leaves a warehouse for a person who asked for it: the
 * slip names them, where it goes and how, the items with their serial and
 * condition, and the terms of receipt. Once issued, the person confirms in
 * G-CORE that it arrived in good order — the slip's "Received in good order
 * by", dated — or the warehouse lead records a signed paper copy for them.
 *
 * The list, the page editor (`/g-chain/outgoing/new`, `/:id/edit` on a draft)
 * and the record page.
 */

const qtyText = (n: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(n);
const cents = (n: number) => Math.round(n * 100) / 100;

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

interface IssueRow {
  id: string;
  number: string;
  status: string;
  issueDate: string;
  purpose: string;
  issuedToName: string | null;
  deliverTo: string | null;
  receivedAt: string | null;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
  lineCount: number;
  value: number;
}
interface IssueSummary {
  waiting: number;
  drafts: number;
  issued: number;
  toConfirm: number;
}

export function StockIssues() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.get<{ id: string; name: string }[]>('/warehouses').then(setWarehouses).catch(() => {});
  }, []);

  const columns: Column<IssueRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (i) => <span className="mono">{i.number}</span> },
    {
      key: 'purpose',
      label: 'Outgoing',
      render: (i) => (
        <div>
          <div>{i.purpose}</div>
          <div className="faint">{i.job ? `${i.job.number} — ${i.job.name}` : (i.deliverTo ?? 'No project')}</div>
        </div>
      ),
    },
    { key: 'issuedTo', label: 'Requested by', render: (i) => i.issuedToName ?? <span className="faint">—</span> },
    { key: 'warehouse', label: 'From', render: (i) => i.warehouse.name },
    { key: 'issueDate', label: 'Date', sortKey: 'issueDate', render: (i) => formatDate(i.issueDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (i) => i.lineCount },
    { key: 'value', label: 'Value', align: 'right', render: (i) => <span className="mono">{formatMoney(i.value)}</span> },
    { key: 'status', label: 'Status', render: (i) => <StatusBadge status={i.status} /> },
    {
      key: 'received',
      label: 'Received',
      render: (i) =>
        i.receivedAt ? (
          <span>{formatDate(i.receivedAt)}</span>
        ) : i.status === 'ISSUED' ? (
          <StatusBadge status="AWAITING" label="Not yet confirmed" extra={{ AWAITING: 'warn' }} />
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Outgoing</h1>
        </div>
      </div>

      <DataList<IssueRow>
        listKey="stock-issues"
        endpoint="/stock-issues"
        printPath="/api/stock-issues/pdf"
        reportPath="/g-chain/reports?kind=outgoing"
        columns={columns}
        rowKey={(i) => i.id}
        selectable
        searchPlaceholder="Search number, purpose, person, project…"
        onRowClick={(i) => navigate(`/g-chain/outgoing/${i.id}`)}
        emptyTitle="Nothing issued yet"
        emptyHint="An outgoing slip takes stock out of a warehouse for the person who asked for it, who confirms receiving it."
        summary={(raw) => {
          const s = raw as unknown as IssueSummary;
          return (
            <>
              <Stat
                label="Waiting for approval"
                value={s.waiting ?? 0}
                accent={s.waiting ? 'warn' : 'quiet'}
                to="/g-chain/outgoing?status=PENDING_APPROVAL"
              />
              <Stat label="Drafts" value={s.drafts ?? 0} accent="quiet" to="/g-chain/outgoing?status=DRAFT" />
              <Stat label="Issued" value={s.issued ?? 0} to="/g-chain/outgoing?status=ISSUED" />
              <Stat
                label="Not yet confirmed received"
                value={s.toConfirm ?? 0}
                sub="issued, the requestor has not confirmed"
                accent={s.toConfirm ? 'warn' : 'quiet'}
                to="/g-chain/outgoing?received=no"
              />
            </>
          );
        }}
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'ISSUED', label: 'Issued' },
            ],
          },
          {
            key: 'received',
            label: 'Received',
            options: [
              { value: 'yes', label: 'Confirmed received' },
              { value: 'no', label: 'Issued, not yet confirmed' },
            ],
          },
          { key: 'warehouseId', label: 'Warehouse', options: warehouses.map((w) => ({ value: w.id, label: w.name })) },
        ]}
        actions={
          can('gchain.stock_issuance.create') ? (
            <Link className="btn btn-primary btn-sm" to="/g-chain/outgoing/new">
              + New outgoing
            </Link>
          ) : null
        }
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  EDITOR — one page for New and Modify
// ════════════════════════════════════════════════════════════════════

interface StockOption {
  itemId: string;
  code: string;
  partNumber: string | null;
  brand: string | null;
  name: string;
  unit: string;
  available: number;
  averageCost: number;
}
interface Line {
  key: string;
  itemId: string;
  serialNo: string;
  quantity: string;
  condition: string;
  remarks: string;
}
interface Existing {
  id: string;
  number: string;
  status: string;
  updatedAt: string;
  canEdit: boolean;
  warehouseId: string;
  jobId: string | null;
  job: { id: string; number: string; name: string } | null;
  issuedToId: string | null;
  issuedTo: { id: string; name: string } | null;
  issuedToName: string | null;
  issueDate: string;
  purpose: string;
  notes: string | null;
  deliverTo: string | null;
  referenceNo: string | null;
  carrier: string | null;
  driverName: string | null;
  instructions: string | null;
  items: { itemId: string; quantity: number; serialNo: string | null; condition: string | null; remarks: string | null }[];
}

/** The conditions a line usually leaves in; anything else may be typed. */
const CONDITIONS = ['New', 'Good', 'Used — good', 'Refurbished', 'For repair'];

let keySeq = 0;
const newKey = () => `o${++keySeq}`;
const blankLine = (): Line => ({ key: newKey(), itemId: '', serialNo: '', quantity: '', condition: 'New', remarks: '' });

export function OutgoingEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const navigate = useNavigate();
  const toast = useToast();
  const { can, me } = useAuth();
  const { people } = usePeople();

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [existing, setExisting] = useState<Existing | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [stock, setStock] = useState<StockOption[]>([]);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [terms, setTerms] = useState('');
  const [notALogin, setNotALogin] = useState(false);
  const [header, setHeader] = useState({
    warehouseId: '',
    issueDate: todayLocal(),
    issuedToId: '',
    issuedToName: '',
    jobId: '',
    purpose: '',
    deliverTo: '',
    referenceNo: '',
    carrier: '',
    driverName: '',
    instructions: '',
    notes: '',
  });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [saved, setSaved] = useState<string | null>(null);
  const [route, setRoute] = useState<PreviewRoute | null>(null);

  const snapshot = (h = header, ls = lines) => JSON.stringify({ h, ls: ls.map(({ key: _k, ...rest }) => rest) });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const opts = await api.get<{ warehouses: { id: string; name: string }[]; terms: string }>('/stock-issues/options');
        if (!live) return;
        setWarehouses(opts.warehouses);
        setTerms(opts.terms);
        api.get<typeof jobs>('/jobs/lookup').then((j) => live && setJobs(j)).catch(() => {});
        if (editing) {
          const r = await api.get<Existing>(`/stock-issues/${id}`);
          if (!live) return;
          setExisting(r);
          const h = {
            warehouseId: r.warehouseId,
            issueDate: String(r.issueDate).slice(0, 10),
            issuedToId: r.issuedToId ?? '',
            issuedToName: r.issuedToId ? '' : (r.issuedToName ?? ''),
            jobId: r.jobId ?? '',
            purpose: r.purpose,
            deliverTo: r.deliverTo ?? '',
            referenceNo: r.referenceNo ?? '',
            carrier: r.carrier ?? '',
            driverName: r.driverName ?? '',
            instructions: r.instructions ?? '',
            notes: r.notes ?? '',
          };
          const ls = r.items.map((i) => ({
            key: newKey(),
            itemId: i.itemId,
            serialNo: i.serialNo ?? '',
            quantity: String(i.quantity),
            condition: i.condition ?? '',
            remarks: i.remarks ?? '',
          }));
          setNotALogin(!r.issuedToId && !!r.issuedToName);
          setHeader(h);
          setLines(ls.length ? ls : [blankLine()]);
          setSaved(snapshot(h, ls.length ? ls : [blankLine()]));
        } else {
          const h = {
            ...header,
            instructions: opts.terms,
            warehouseId: opts.warehouses.length === 1 ? opts.warehouses[0].id : '',
          };
          setHeader(h);
          setSaved(snapshot(h));
        }
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // What the chosen warehouse holds, re-read when it changes.
  useEffect(() => {
    if (!header.warehouseId) {
      setStock([]);
      return;
    }
    let live = true;
    api
      .get<{ stock: StockOption[] }>(`/stock-issues/options${qs({ warehouseId: header.warehouseId })}`)
      .then((r) => live && setStock(r.stock))
      .catch(() => live && setStock([]));
    return () => {
      live = false;
    };
  }, [header.warehouseId]);

  const stockOf = useMemo(() => new Map(stock.map((s) => [s.itemId, s])), [stock]);
  const sent = lines.filter((l) => l.itemId || l.quantity);
  const value = cents(sent.reduce((s, l) => s + (Number(l.quantity) || 0) * (stockOf.get(l.itemId)?.averageCost ?? 0), 0));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: PreviewRoute | null }>(`/stock-issues/route${qs({ amount: String(value) })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [value]);

  const dirty = saved !== null && snapshot() !== saved;
  useUnsavedChanges(dirty && !busy);
  useBackLink(existing ? `/g-chain/outgoing/${existing.id}` : null, existing ? existing.number : null);

  // ── Checking and saving ────────────────────────────────────────────────────

  const asked = new Map<string, number>();
  for (const l of sent) asked.set(l.itemId, (asked.get(l.itemId) ?? 0) + (Number(l.quantity) || 0));
  const problems: string[] = [];
  if (!header.warehouseId) problems.push('Choose the warehouse');
  if (notALogin ? !header.issuedToName.trim() : !header.issuedToId) problems.push('Say who asked for it');
  if (header.purpose.trim().length < 3) problems.push('Say what it is for');
  if (!sent.length) problems.push('Add at least one item');
  sent.forEach((l, n) => {
    const s = stockOf.get(l.itemId);
    if (!l.itemId) problems.push(`Line ${n + 1}: choose the item`);
    else if (!(Number(l.quantity) > 0)) problems.push(`Line ${n + 1}: quantity must be more than zero`);
    else if (s && (asked.get(l.itemId) ?? 0) > s.available + 0.0005) problems.push(`Line ${n + 1}: only ${qtyText(s.available)} ${s.unit} of ${s.name} available`);
  });

  function body() {
    return {
      warehouseId: header.warehouseId,
      issueDate: header.issueDate || null,
      issuedToId: notALogin ? null : header.issuedToId || null,
      issuedToName: notALogin ? header.issuedToName.trim() || null : (people.find((p) => p.id === header.issuedToId)?.name ?? existing?.issuedTo?.name ?? null),
      jobId: header.jobId || null,
      purpose: header.purpose.trim(),
      deliverTo: header.deliverTo.trim() || null,
      referenceNo: header.referenceNo.trim() || null,
      carrier: header.carrier.trim() || null,
      driverName: header.driverName.trim() || null,
      instructions: header.instructions.trim() || null,
      notes: header.notes.trim() || null,
      lines: sent.map((l) => ({
        itemId: l.itemId,
        quantity: Number(l.quantity),
        serialNo: l.serialNo.trim() || null,
        condition: l.condition.trim() || null,
        remarks: l.remarks.trim() || null,
      })),
      ...(existing ? { version: existing.updatedAt } : {}),
    };
  }

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/stock-issues/${existing.id}/sheet`, body())).id
        : (await api.post<{ id: string }>('/stock-issues', body())).id;
      setSaved(snapshot());
      if (submit) {
        try {
          await api.post(`/stock-issues/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Outgoing slip saved');
      navigate(`/g-chain/outgoing/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Outgoing slip not found')} />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status !== 'DRAFT'
            ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} — only a draft is modified.`
            : 'You cannot change this slip.'}
        </p>
      </div>
    );
  }

  const set = (k: keyof typeof header) => (e: { target: { value: string } }) => setHeader((h) => ({ ...h, [k]: e.target.value }));
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const job = jobs.find((j) => j.id === header.jobId) ?? (existing?.job && existing.job.id === header.jobId ? existing.job : null);
  const jobOptions = existing?.job && !jobs.some((j) => j.id === existing.job!.id) ? [existing.job, ...jobs] : jobs;
  const routed = !!route;

  const actions = (
    <>
      <button type="button" className={routed ? 'btn' : 'btn btn-primary'} onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {routed && can('gchain.stock_issuance.create') && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="out-heading">
        <div className="qe-head">
          <div>
            <h1 id="out-heading" className="qe-heading">
              {existing ? `Modify outgoing slip ${existing.number}` : 'New outgoing slip'}
            </h1>
            <p className="muted qe-lead">
              {existing
                ? 'Change what you need and Save — the header and the lines are saved together.'
                : 'Saved as a draft; nothing leaves the warehouse until it is issued. The number is given on the first save.'}
            </p>
          </div>
          <div className="row qe-actions">{actions}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <div className="prq-grid prq-grid-solo">
        <div className="prq-main">
          <section className="card" aria-labelledby="out-details">
            <h2 id="out-details" className="card-title">Delivery details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label="Date">
                <input type="date" value={header.issueDate} onChange={set('issueDate')} />
              </Field>
              <Field
                label="Dispatch warehouse"
                required
                hint={existing && sent.length && header.warehouseId !== existing.warehouseId ? 'The lines are re-priced at this warehouse’s average cost' : undefined}
                error={attempted && !header.warehouseId ? 'Choose the warehouse' : null}
              >
                <select value={header.warehouseId} onChange={set('warehouseId')}>
                  <option value="">— choose —</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ref / request no." hint="The request it answers — a job order, a memo, a ticket">
                <input value={header.referenceNo} maxLength={120} onChange={set('referenceNo')} />
              </Field>
              <Field
                label="Requested by"
                required
                hint={notALogin ? 'They sign the paper copy; the warehouse lead records it' : 'Who receives it — they confirm it in G-CORE'}
                error={attempted && (notALogin ? !header.issuedToName.trim() : !header.issuedToId) ? 'Say who asked for it' : null}
              >
                {notALogin ? (
                  <input value={header.issuedToName} maxLength={120} placeholder="Name" onChange={set('issuedToName')} />
                ) : (
                  <PersonSelect
                    value={header.issuedToId}
                    onChange={(v) => setHeader((h) => ({ ...h, issuedToId: v }))}
                    people={people}
                    placeholder="— choose —"
                    current={existing?.issuedTo ?? null}
                    self={me?.user.id}
                  />
                )}
              </Field>
              <Field label=" ">
                <div className="qe-static">
                  <label className="checkbox">
                    <input type="checkbox" checked={notALogin} onChange={(e) => setNotALogin(e.target.checked)} />
                    <span>No G-CORE login</span>
                  </label>
                </div>
              </Field>
              <Field label="For project" hint={job ? 'Charged to this project at the average cost' : 'Leave blank for general use — no project is charged'}>
                <select value={header.jobId} onChange={set('jobId')}>
                  <option value="">— none —</option>
                  {jobOptions.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.number} — {j.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Deliver to" hint={job ? 'Leave blank to print the project' : 'Site, office, room'}>
                <input value={header.deliverTo} maxLength={300} onChange={set('deliverTo')} />
              </Field>
              <Field label="Carrier / vehicle">
                <input value={header.carrier} maxLength={200} placeholder="e.g. Company van ABC 1234" onChange={set('carrier')} />
              </Field>
              <Field label="Delivered by" hint="The driver or messenger">
                <input value={header.driverName} maxLength={120} onChange={set('driverName')} />
              </Field>
            </div>
            <div className="qe-rows">
              <Field label="Purpose" required error={attempted && header.purpose.trim().length < 3 ? 'Say what it is for' : null}>
                <input value={header.purpose} maxLength={300} onChange={set('purpose')} />
              </Field>
              <Field label="Notes" hint="Printed on the slip">
                <textarea rows={2} value={header.notes} onChange={set('notes')} />
              </Field>
            </div>
          </section>

          <section className="card" aria-labelledby="out-lines">
            <div className="card-head">
              <h2 id="out-lines" className="card-title">Outgoing items</h2>
              <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                + Add line
              </button>
            </div>
            {!header.warehouseId ? (
              <p className="muted">Choose the dispatch warehouse — what it holds is offered here.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item</th>
                      <th>Serial / batch</th>
                      <th className="right">Qty</th>
                      <th>Unit</th>
                      <th>Condition</th>
                      <th className="right">Available</th>
                      <th className="right">Amount</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, n) => {
                      const s = stockOf.get(l.itemId);
                      return (
                        <tr key={l.key}>
                          <td>{n + 1}</td>
                          <td className="inc-item-cell">
                            <StockLookup stock={stock} value={l.itemId} onPick={(itemId) => setLine(l.key, { itemId })} />
                            <input
                              className="out-remarks"
                              aria-label={`Remarks — line ${n + 1}`}
                              placeholder="Remarks"
                              value={l.remarks}
                              maxLength={500}
                              onChange={(e) => setLine(l.key, { remarks: e.target.value })}
                            />
                          </td>
                          <td className="inc-unit-cell">
                            <input aria-label={`Serial or batch — line ${n + 1}`} value={l.serialNo} maxLength={120} onChange={(e) => setLine(l.key, { serialNo: e.target.value })} />
                          </td>
                          <td className="right inc-num-cell">
                            <NumberInput
                              kind="quantity"
                              aria-label={`Quantity — line ${n + 1}`}
                              value={l.quantity}
                              min={0}
                              max={s?.available}
                              onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                            />
                          </td>
                          <td>{s?.unit ?? <span className="faint">—</span>}</td>
                          <td className="inc-unit-cell">
                            <input
                              aria-label={`Condition — line ${n + 1}`}
                              list="out-conditions"
                              value={l.condition}
                              maxLength={80}
                              onChange={(e) => setLine(l.key, { condition: e.target.value })}
                            />
                          </td>
                          <td className="right mono">{s ? qtyText(s.available) : <span className="faint">—</span>}</td>
                          <td className="right mono">{formatMoney(cents((Number(l.quantity) || 0) * (s?.averageCost ?? 0)))}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm btn-icon"
                              aria-label={`Remove line ${n + 1}`}
                              onClick={() =>
                                setLines((ls) => {
                                  const rest = ls.filter((x) => x.key !== l.key);
                                  return rest.length ? rest : [blankLine()];
                                })
                              }
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <datalist id="out-conditions">
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            )}
            <p className="prq-hint">
              Only what this warehouse holds available can go out. The amount is at the warehouse's average cost — what a project is charged; the
              printed receipt shows no prices.
            </p>
          </section>

          <section className="card" aria-labelledby="out-terms">
            <h2 id="out-terms" className="card-title">Instructions &amp; terms of receipt</h2>
            <div className="qe-rows">
              <Field label="Printed over the sign-offs" hint={header.instructions.trim() !== terms ? 'Changed from the standard wording' : 'The standard wording'}>
                <textarea rows={3} value={header.instructions} onChange={set('instructions')} />
              </Field>
            </div>
            {header.instructions.trim() !== terms && (
              <button type="button" className="btn btn-sm" onClick={() => setHeader((h) => ({ ...h, instructions: terms }))}>
                Put the standard wording back
              </button>
            )}
          </section>

          <section className="card" aria-labelledby="out-summary">
            <h2 id="out-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{sent.length}</dd>
              <dt className="prq-total-big">Value at average cost</dt>
              <dd className="prq-total-big mono">{formatMoney(value)}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="out-approval">
            <h2 id="out-approval" className="card-title">Approval</h2>
            {route ? (
              allHeld(route) ? (
                <p className="muted">No one else's approval needed — you hold every step of the route.</p>
              ) : (
                <>
                  <p className="muted">Submit for approval sends it to:</p>
                  <ApprovalStepper steps={previewSteps(route)} />
                </>
              )
            ) : (
              <p className="muted">No approval route covers outgoing slips — the slip's page issues it once saved.</p>
            )}
            <p className="prq-hint">Attach the signed gate pass or photos on the slip's page after saving.</p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>
      </div>
    </div>
  );
}

/** What the warehouse holds, searched by code, part number, brand or name. */
function StockLookup({ stock, value, onPick }: { stock: StockOption[]; value: string; onPick: (itemId: string) => void }) {
  const chosen = stock.find((s) => s.itemId === value) ?? null;
  const label = (s: StockOption) => `${s.partNumber ?? s.code} — ${s.name}`;
  const [term, setTerm] = useState(chosen ? label(chosen) : '');
  const [open, setOpen] = useState(false);
  const shown = useRef(value);
  // The stock arrives after the line: put its label in once it is known.
  useEffect(() => {
    if (chosen && (shown.current !== value || !term)) {
      setTerm(label(chosen));
      shown.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, value]);
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = stock
    .filter((s) => {
      const hay = `${s.code} ${s.partNumber ?? ''} ${s.brand ?? ''} ${s.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 30);
  return (
    <div className="lookup" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <input
        value={term}
        autoComplete="off"
        placeholder="Search part no., code or name"
        aria-label="Item"
        aria-expanded={open}
        onFocus={() => {
          setOpen(true);
          if (chosen) setTerm('');
        }}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
      />
      {open && (
        <ul className="lookup-menu">
          {rows.map((s) => (
            <li key={s.itemId}>
              <button
                type="button"
                disabled={s.available <= 0}
                onClick={() => {
                  onPick(s.itemId);
                  setTerm(label(s));
                  shown.current = s.itemId;
                  setOpen(false);
                }}
              >
                <span className="mono">{s.partNumber ?? s.code}</span> — {s.name}
                <span className="muted">
                  {s.brand ? ` · ${s.brand}` : ''} · {qtyText(s.available)} {s.unit} available
                </span>
              </button>
            </li>
          ))}
          {!rows.length && <li className="lookup-none">This warehouse holds nothing matching “{term}”.</li>}
        </ul>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  RECORD PAGE
// ════════════════════════════════════════════════════════════════════

interface IssueRecord {
  id: string;
  number: string;
  status: string;
  issueDate: string;
  issuedAt: string | null;
  purpose: string;
  notes: string | null;
  value: number;
  deliverTo: string | null;
  referenceNo: string | null;
  carrier: string | null;
  driverName: string | null;
  instructions: string | null;
  receivedAt: string | null;
  receivedNote: string | null;
  issuedToId: string | null;
  issuedToName: string | null;
  issuedTo: { id: string; name: string; position: string | null } | null;
  receivedBy: { id: string; name: string } | null;
  issuedBy: { id: string; name: string };
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
  items: {
    id: string;
    quantity: number;
    unitCost: number;
    amount: number;
    serialNo: string | null;
    condition: string | null;
    remarks: string | null;
    item: { id: string; code: string; partNumber: string | null; brand: string | null; name: string; unit: string };
    costCategory: { name: string } | null;
    location: { code: string } | null;
  }[];
  canEdit: boolean;
  canDelete: boolean;
  needsApproval: boolean | null;
  canSubmit: boolean;
  canIssue: boolean;
  canWithdraw: boolean;
  canConfirmReceipt: boolean;
  approvalRoute: PreviewRoute | null;
}

export function StockIssueDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can, me } = useAuth();
  const [issue, setIssue] = useState<IssueRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setIssue(await api.get<IssueRecord>(`/stock-issues/${id}`));
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
  if (!issue) return <ErrorBox error={error ?? new Error('Not found')} />;

  const { job, warehouse, items, number, status } = issue;
  const isDraft = status === 'DRAFT';
  const receiver = issue.issuedTo?.name ?? issue.issuedToName;
  const mine = !!me && issue.issuedToId === me.user.id;
  const showCost = can('gchain.stock_issuance.view_all');

  /** Asked in the confirm bar, which shows a refusal — so these throw rather than catching. */
  async function commit() {
    setIssue(await api.post<IssueRecord>(`/stock-issues/${id}/issue`));
    toast('ok', job ? 'Issued — the project has been charged' : 'Issued');
    setReload((n) => n + 1);
  }
  async function submit() {
    setIssue(await api.post<IssueRecord>(`/stock-issues/${id}/submit`));
    setReload((n) => n + 1);
    toast('ok', `${number} submitted for approval`);
  }
  async function withdraw() {
    setIssue(await api.post<IssueRecord>(`/stock-issues/${id}/withdraw`));
    setReload((n) => n + 1);
    toast('ok', `${number} pulled back to a draft`);
  }
  async function remove() {
    await api.del(`/stock-issues/${id}`);
    toast('ok', `${number} deleted`);
    navigate('/g-chain/outgoing');
  }
  async function confirmReceipt(note: string) {
    setIssue(await api.post<IssueRecord>(`/stock-issues/${id}/receive`, { note: note.trim() || null }));
    toast('ok', `${number} confirmed received`);
  }

  const nextStep =
    isDraft && issue.needsApproval === true ? (
      <button
        className="btn btn-primary"
        disabled={!issue.canSubmit}
        title={items.length === 0 ? 'Add an item first' : undefined}
        onClick={() =>
          confirm.ask({
            title: `Submit ${number} for approval?`,
            body: job
              ? `Nothing leaves ${warehouse.name} until it is approved: then the stock goes out and is charged to ${job.number} at the average cost of that moment.`
              : `Nothing leaves ${warehouse.name} until it is approved.`,
            confirmLabel: 'Submit for approval',
            tone: 'primary',
            onConfirm: submit,
          })
        }
      >
        Submit for approval
      </button>
    ) : isDraft && issue.canIssue ? (
      <button
        className="btn btn-primary"
        onClick={() =>
          confirm.ask({
            title: `Issue ${number}?`,
            body: job
              ? `The stock leaves ${warehouse.name} and ${formatMoney(issue.value)} is charged to ${job.number} at the current average cost. It cannot be taken back.`
              : `The stock leaves ${warehouse.name}. No project is charged. It cannot be taken back.`,
            confirmLabel: 'Issue',
            tone: 'primary',
            onConfirm: commit,
          })
        }
      >
        Issue
      </button>
    ) : issue.canConfirmReceipt ? (
      <button
        className="btn btn-primary"
        onClick={() =>
          confirm.ask({
            title: mine ? `Confirm you received ${number}?` : `Record that ${receiver ?? 'the requestor'} received ${number}?`,
            body: mine
              ? 'Your name, the date and the time print as “Received in good order by”. Note anything missing or damaged.'
              : 'For a signed paper copy — the record says you entered it for them.',
            reason: 'optional',
            reasonLabel: 'Note on receipt (optional)',
            confirmLabel: mine ? 'Confirm received' : 'Record receipt',
            tone: 'primary',
            onConfirm: confirmReceipt,
          })
        }
      >
        {mine ? 'Confirm received' : 'Record receipt'}
      </button>
    ) : null;

  return (
    <div>
      <RecordHeader
        type="Outgoing"
        code={number}
        title={issue.purpose}
        status={status}
        amount={showCost ? formatMoney(issue.value) : undefined}
        amountLabel={isDraft ? 'Value at current cost' : 'Value issued'}
        meta={
          <>
            From {warehouse.name}
            {receiver ? ` · requested by ${receiver}` : ''}
            {job && (
              <>
                {' · '}
                <Link to={`/g-ops/projects/${job.id}`}>
                  {job.number} — {job.name}
                </Link>
              </>
            )}{' '}
            · {formatDate(issue.issueDate)}
          </>
        }
        actions={nextStep}
        print={`/api/stock-issues/${id}/pdf`}
        more={[
          issue.canWithdraw && {
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
          issue.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${number}?`,
              body: 'Nothing has left the store yet. It cannot be undone.',
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={issue.canEdit ? `/g-chain/outgoing/${id}/edit` : undefined}
        confirm={confirm}
      />

      {isDraft && issue.approvalRoute && issue.approvalRoute.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(issue.approvalRoute) ? 'No one else’s approval needed' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(issue.approvalRoute)} />
        </div>
      )}
      <DecisionNote documentType="stock_issue" documentId={String(id)} reloadToken={reload} />
      {(status === 'PENDING_APPROVAL' || status === 'ISSUED') && <DocumentApproval documentType="stock_issue" documentId={String(id)} reloadToken={reload} />}

      <ErrorBox error={error} />

      {status === 'PENDING_APPROVAL' && <div className="alert info">Waiting for approval. Nothing has left {warehouse.name} yet.</div>}
      {status === 'ISSUED' && !issue.receivedAt && (
        <div className="alert warn">
          Issued {issue.issuedAt ? formatDateTime(issue.issuedAt) : formatDate(issue.issueDate)} — {receiver ?? 'the requestor'} has not confirmed receiving it
          yet.
        </div>
      )}
      {issue.receivedAt && (
        <div className="alert ok">
          Received in good order — confirmed by {issue.receivedBy?.name ?? receiver} on {formatDateTime(issue.receivedAt)}
          {issue.receivedNote ? `. ${issue.receivedNote}` : '.'}
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Delivery details</h3>
        <dl className="kv">
          <dt>Requested by</dt>
          <dd>
            {receiver ?? '—'}
            {issue.issuedTo?.position ? <span className="muted"> · {issue.issuedTo.position}</span> : null}
          </dd>
          <dt>Ref / request no.</dt>
          <dd>{issue.referenceNo ?? '—'}</dd>
          <dt>Deliver to</dt>
          <dd>{issue.deliverTo ?? (job ? `${job.number} — ${job.name}` : '—')}</dd>
          <dt>Dispatch warehouse</dt>
          <dd>{warehouse.name}</dd>
          <dt>Carrier / vehicle</dt>
          <dd>{issue.carrier ?? '—'}</dd>
          <dt>Delivered by</dt>
          <dd>{issue.driverName ?? '—'}</dd>
          <dt>Prepared by</dt>
          <dd>{issue.issuedBy.name}</dd>
          {issue.notes && (
            <>
              <dt>Notes</dt>
              <dd>{issue.notes}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card">
        <h3 className="card-title">Outgoing items</h3>
        {items.length === 0 ? (
          <Empty title="No items yet" hint={issue.canEdit ? 'Modify the slip to add what is leaving the store.' : undefined} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item</th>
                  <th>Serial / batch</th>
                  <th className="right">Qty</th>
                  <th>Condition</th>
                  {showCost && <th>Budget line</th>}
                  {showCost && <th className="right">Unit cost</th>}
                  {showCost && <th className="right">Amount</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((i, n) => (
                  <tr key={i.id}>
                    <td>{n + 1}</td>
                    <td>
                      <div>
                        <strong>{i.item.name}</strong>
                      </div>
                      <div className="faint">
                        <span className="mono">{i.item.partNumber ?? i.item.code}</span>
                        {i.item.brand ? ` · ${i.item.brand}` : ''}
                        {i.location ? ` · bin ${i.location.code}` : ''}
                      </div>
                      {i.remarks && <div className="faint">{i.remarks}</div>}
                    </td>
                    <td>{i.serialNo ?? <span className="faint">—</span>}</td>
                    <td className="right mono">
                      {qtyText(i.quantity)} {i.item.unit}
                    </td>
                    <td>{i.condition ?? <span className="faint">—</span>}</td>
                    {showCost && <td>{i.costCategory?.name ?? <span className="faint">—</span>}</td>}
                    {showCost && <td className="right mono">{formatMoney(i.unitCost)}</td>}
                    {showCost && <td className="right mono">{formatMoney(i.amount)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {issue.instructions && (
        <div className="card">
          <h3 className="card-title">Instructions &amp; terms of receipt</h3>
          <p className="out-terms">{issue.instructions}</p>
        </div>
      )}

      <Attachments
        entityType="stock_issue"
        entityId={String(id)}
        title="Gate pass and documents"
        hint="The signed gate pass, photos of what left — printed behind the slip"
        canEdit={isDraft || status === 'PENDING_APPROVAL'}
      />
    </div>
  );
}
