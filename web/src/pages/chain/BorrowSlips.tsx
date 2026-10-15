import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';

/**
 * Borrow slips (2026-10-14, the owner's call: "anyone can request to borrow;
 * approval by the Team Leader / Technical Manager they report to or within
 * the team; the warehouse processes it, with its reports-to's approval").
 *
 * A request is saved as a draft, submitted for approval, and RELEASED by the
 * warehouse once approved — nothing leaves the shelf before. The list, the
 * request page (`/new`, `/:id/edit` on a draft) and the record page live
 * here; the API is `routes/warehouse.ts`.
 */

/** Out and late read amber and red; back reads green; a request waiting reads amber. */
export const BORROW_TONES = {
  RETURNED: 'ok',
  APPROVED: 'info',
  PENDING_APPROVAL: 'warn',
  OUT: 'warn',
  PARTIALLY_RETURNED: 'warn',
  OVERDUE: 'danger',
} as const;

/** The borrowing types and return verdicts, as the API prints them (the owner's form). */
const BORROW_TYPE_OPTIONS = [
  { value: 'INTERNAL_OFFICE', label: 'Internal / office use' },
  { value: 'ON_SITE_PROJECT', label: 'On-site project / customer site' },
  { value: 'PERSONAL', label: 'Personal request' },
  { value: 'RND_TESTING', label: 'R&D / testing' },
];
const RETURN_CONDITION_OPTIONS = [
  { value: 'COMPLETE_GOOD', label: 'Complete / good' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'MISSING_PARTS', label: 'Missing parts' },
];
/** The conditions a tool usually leaves and comes back in; anything else may be typed. */
const CONDITIONS = ['Good', 'Fair', 'Damaged', 'Missing parts'];

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved — to release' },
  { value: 'OUT', label: 'Out' },
  { value: 'PARTIALLY_RETURNED', label: 'Partly back' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface BorrowRow {
  id: string;
  number: string;
  status: string;
  borrowType: string | null;
  borrowTypeLabel: string | null;
  siteLocation: string | null;
  borrowerName: string;
  requestedBy: { id: string; name: string } | null;
  purpose: string;
  neededOn: string | null;
  borrowedAt: string;
  dueAt: string;
  returnedAt: string | null;
  released: boolean;
  itemCount: number;
  outstandingQty: number;
  isOverdue: boolean;
  daysOverdue: number;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
}

interface BorrowSummary {
  awaitingApproval?: number;
  toRelease?: number;
  onLoan?: number;
  overdue?: number;
}

export function BorrowSlips() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const warehouse = can('gchain.borrow_slips.view_all');

  const columns: Column<BorrowRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (b) => <span className="mono">{b.number}</span> },
    {
      key: 'borrower',
      label: 'Borrower',
      render: (b) => (
        <div>
          <div>{b.borrowerName}</div>
          <div className="faint">
            {b.purpose}
            {b.requestedBy && b.requestedBy.name !== b.borrowerName ? ` · asked by ${b.requestedBy.name}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'warehouse', label: 'Warehouse', render: (b) => b.warehouse.name },
    { key: 'job', label: 'Project', render: (b) => b.job?.number ?? <span className="faint">—</span> },
    { key: 'borrowType', label: 'Type', render: (b) => b.borrowTypeLabel ?? <span className="faint">—</span>, optional: true },
    {
      key: 'neededOn',
      label: 'Needed / out',
      sortKey: 'neededOn',
      render: (b) =>
        b.released ? formatDate(b.borrowedAt) : b.neededOn ? <span className="faint">needed {formatDate(b.neededOn)}</span> : <span className="faint">—</span>,
    },
    {
      key: 'dueAt',
      label: 'Due back',
      sortKey: 'dueAt',
      render: (b) => (
        <span className={b.isOverdue ? 'proc-over' : undefined}>
          {formatDate(b.dueAt)}
          {b.isOverdue && <div className="faint">{b.daysOverdue}d overdue</div>}
        </span>
      ),
    },
    { key: 'items', label: 'Items', align: 'right', render: (b) => b.itemCount },
    { key: 'outstanding', label: 'Still out', align: 'right', render: (b) => b.outstandingQty || <span className="faint">—</span> },
    {
      key: 'status',
      label: 'Status',
      render: (b) => <StatusBadge status={b.isOverdue ? 'OVERDUE' : b.status} extra={BORROW_TONES} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Borrow Slips</h1>
        </div>
      </div>

      <DataList<BorrowRow>
        listKey="borrow-slips"
        endpoint="/borrow-slips"
        printPath="/api/borrow-slips/pdf"
        reportPath="/g-chain/reports?kind=borrow"
        columns={columns}
        rowKey={(b) => b.id}
        searchPlaceholder="Search number, borrower, purpose…"
        onRowClick={(b) => navigate(`/g-chain/borrow-slips/${b.id}`)}
        emptyTitle="Nothing borrowed"
        emptyHint="Ask for a tool with + New borrow request — your Team Leader approves it and the warehouse releases it. A borrow slip charges no job cost."
        scoped={warehouse}
        defaultScope={warehouse ? 'all' : 'mine'}
        selectable
        filters={[
          { key: 'borrowType', label: 'Borrowing type', options: BORROW_TYPE_OPTIONS },

          { key: 'status', label: 'Status', options: STATUS_OPTIONS },
          { key: 'overdue', label: 'Overdue', options: [{ value: 'true', label: 'Overdue only' }] },
        ]}
        summary={(raw) => {
          const sum = raw as BorrowSummary;
          return (
            <>
              <Stat label="Waiting for approval" value={sum.awaitingApproval ?? 0} to="/g-chain/borrow-slips?status=PENDING_APPROVAL" />
              <Stat
                label="To release"
                value={sum.toRelease ?? 0}
                sub="approved, still on the shelf"
                accent={sum.toRelease ? 'info' : 'quiet'}
                to="/g-chain/borrow-slips?status=APPROVED"
              />
              <Stat label="On loan" value={sum.onLoan ?? 0} to="/g-chain/borrow-slips?status=OUT" />
              <Stat
                label="Overdue"
                value={sum.overdue ?? 0}
                sub={sum.overdue ? 'past their return date' : 'everything back on time'}
                accent={sum.overdue ? 'danger' : 'quiet'}
                to="/g-chain/borrow-slips?overdue=true"
              />
            </>
          );
        }}
        actions={
          can('gchain.borrow_slips.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/g-chain/borrow-slips/new')}>
              + New borrow request
            </button>
          ) : null
        }
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE REQUEST PAGE
// ════════════════════════════════════════════════════════════════════

interface Options {
  warehouses: { id: string; code: string; name: string }[];
  jobs: { id: string; number: string; name: string }[];
  items: { id: string; code: string; name: string; unit: string; available: number }[];
  mayNameBorrower: boolean;
}

interface Line {
  itemId: string;
  quantity: string;
  serialNo: string;
  conditionOut: string;
}

const blank = (): Line => ({ itemId: '', quantity: '1', serialNo: '', conditionOut: 'Good' });

/**
 * One page for a new borrow request and a draft one being modified: the
 * warehouse, the items from what it holds AVAILABLE now, quantities, needed
 * on, due back, what for and the project if any. The warehouse may write it
 * for somebody else (a walk-in borrower). Save takes the person to the slip,
 * where Submit for approval sends it to their Team Leader.
 */
export function BorrowRequestEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const [options, setOptions] = useState<Options | null>(null);
  const [existing, setExisting] = useState<Record<string, unknown> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState({
    warehouseId: '',
    jobId: '',
    borrowerId: '',
    borrowerName: '',
    borrowType: '',
    siteLocation: '',
    contactNo: '',
    neededOn: '',
    dueAt: '',
    purpose: '',
    notes: '',
  });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const { people } = usePeople();

  useBackLink(editing && id ? `/g-chain/borrow-slips/${id}` : '/g-chain/borrow-slips', editing ? (existing ? String(existing.number) : 'the slip') : 'Borrow Slips');
  useUnsavedChanges(dirty && !busy);

  // The options, and on Modify the draft itself.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const slip = editing ? await api.get<Record<string, unknown>>(`/borrow-slips/${id}`) : null;
        const warehouseId = slip ? String((slip.warehouse as { id: string }).id) : '';
        const opts = await api.get<Options>(`/borrow-slips/options${qs({ warehouseId: warehouseId || undefined })}`);
        if (!live) return;
        setOptions(opts);
        if (slip) {
          setExisting(slip);
          setForm({
            warehouseId,
            jobId: (slip.job as { id: string } | null)?.id ?? '',
            borrowerId: typeof slip.borrowerId === 'string' ? slip.borrowerId : '',
            borrowerName: String(slip.borrowerName ?? ''),
            borrowType: typeof slip.borrowType === 'string' ? slip.borrowType : '',
            siteLocation: typeof slip.siteLocation === 'string' ? slip.siteLocation : '',
            contactNo: typeof slip.contactNo === 'string' ? slip.contactNo : '',
            neededOn: typeof slip.neededOn === 'string' ? slip.neededOn.slice(0, 10) : '',
            dueAt: String(slip.dueAt ?? '').slice(0, 10),
            purpose: String(slip.purpose ?? ''),
            notes: typeof slip.notes === 'string' ? slip.notes : '',
          });
          const items = slip.items as { item: { id: string }; quantity: number; serialNo: string | null; conditionOut: string | null }[];
          setLines(
            items.length
              ? items.map((i) => ({ itemId: i.item.id, quantity: String(i.quantity), serialNo: i.serialNo ?? '', conditionOut: i.conditionOut ?? '' }))
              : [blank()],
          );
        } else if (opts.warehouses.length === 1) {
          setForm((f) => ({ ...f, warehouseId: opts.warehouses[0].id }));
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
  }, [editing, id]);

  // A warehouse chosen: what it holds available now.
  useEffect(() => {
    if (!form.warehouseId || !options) return;
    let live = true;
    api
      .get<Options>(`/borrow-slips/options${qs({ warehouseId: form.warehouseId })}`)
      .then((o) => live && setOptions((prev) => (prev ? { ...prev, items: o.items } : o)))
      .catch(() => {});
    return () => {
      live = false;
    };
    // options itself is not a trigger: only a change of warehouse is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.warehouseId]);

  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const setLine = (i: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const items = options?.items ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const sent = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
  const problems: string[] = [];
  if (!form.warehouseId) problems.push('choose the warehouse');
  if (!form.borrowType) problems.push('say what kind of borrowing it is');
  if (!form.dueAt) problems.push('say when it comes back');
  if (form.purpose.trim().length < 3) problems.push('say what it is for');
  if (!sent.length) problems.push('add at least one item');
  for (const l of sent) {
    const it = byId.get(l.itemId);
    if (it && Number(l.quantity) > it.available + 0.0005) problems.push(`only ${it.available} ${it.unit} of ${it.name} is available`);
  }
  if (options?.mayNameBorrower && !form.borrowerId && form.borrowerName.trim().length > 0 && form.borrowerName.trim().length < 2) {
    problems.push('name the borrower');
  }

  async function save() {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      warehouseId: form.warehouseId,
      jobId: form.jobId || null,
      borrowerId: options?.mayNameBorrower ? form.borrowerId || null : null,
      borrowerName: options?.mayNameBorrower ? form.borrowerName.trim() || null : null,
      borrowType: form.borrowType || null,
      siteLocation: form.siteLocation.trim() || null,
      contactNo: form.contactNo.trim() || null,
      neededOn: form.neededOn || null,
      dueAt: form.dueAt,
      purpose: form.purpose.trim(),
      notes: form.notes.trim() || null,
      items: sent.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), serialNo: l.serialNo.trim() || null, conditionOut: l.conditionOut.trim() || null })),
    };
    try {
      if (editing && existing) {
        await api.put(`/borrow-slips/${id}/sheet`, { ...body, version: existing.updatedAt });
        setDirty(false);
        toast('ok', `${String(existing.number)} saved`);
        navigate(`/g-chain/borrow-slips/${id}`);
      } else {
        const created = await api.post<{ id: string; number: string; needsApproval: boolean; status: string }>('/borrow-slips', body);
        setDirty(false);
        toast(
          'ok',
          created.needsApproval
            ? `${created.number} saved — submit it for approval`
            : created.status === 'OUT'
              ? `${created.number} lent out`
              : `${created.number} saved — the warehouse releases it`,
        );
        navigate(`/g-chain/borrow-slips/${created.id}`);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (!options) return <ErrorBox error={error ?? new Error('The form could not be loaded')} />;
  if (editing && existing && existing.canEditSheet !== true) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status === 'PENDING_APPROVAL'
            ? `${String(existing.number)} is waiting for approval — pull it back from ⋯ on its page to change it.`
            : `${String(existing.number)} is no longer a draft request.`}
        </p>
      </div>
    );
  }

  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="bs-heading">
        <div className="qe-head">
          <div>
            <h1 id="bs-heading" className="qe-heading">
              {editing && existing ? `Modify borrow request ${String(existing.number)}` : 'New borrow request'}
            </h1>
            <p className="muted qe-lead">
              {options.mayNameBorrower
                ? 'Your Team Leader approves it, then the warehouse releases it. Write it for someone else by naming the borrower.'
                : 'Save, then submit it for approval — your Team Leader approves it, and the warehouse releases it to you.'}
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

      <section className="card" aria-labelledby="bs-details">
        <h2 id="bs-details" className="card-title">
          What you need
        </h2>
        <div className="qe-header qe-rows prq-rows">
          <Field label="Warehouse" required error={attempted && !form.warehouseId ? 'Choose the warehouse' : null}>
            <select
              value={form.warehouseId}
              required
              onChange={(e) => {
                set({ warehouseId: e.target.value });
                setLines([blank()]);
              }}
            >
              <option value="">— choose —</option>
              {options.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For project" hint="Optional — recorded, never charged">
            <select value={form.jobId} onChange={(e) => set({ jobId: e.target.value })}>
              <option value="">— none —</option>
              {options.jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.number} — {j.name}
                </option>
              ))}
            </select>
          </Field>
          {options.mayNameBorrower ? (
            <>
              <Field label="Borrower" hint="Leave both empty to borrow it yourself">
                <PersonSelect
                  value={form.borrowerId}
                  people={people}
                  placeholder="— a person with a login —"
                  onChange={(v) => set({ borrowerId: v, borrowerName: v ? (people.find((p) => p.id === v)?.name ?? '') : form.borrowerName })}
                />
              </Field>
              <Field label="Or a name" hint="Someone with no login">
                <input value={form.borrowerName} onChange={(e) => set({ borrowerName: e.target.value, borrowerId: '' })} maxLength={120} />
              </Field>
            </>
          ) : (
            <Field label="Borrower">
              <div className="qe-static">{me?.user.name ?? 'You'}</div>
            </Field>
          )}
          <Field label="Borrowing type" required error={attempted && !form.borrowType ? 'What kind of borrowing is it?' : null}>
            <select value={form.borrowType} required onChange={(e) => set({ borrowType: e.target.value })}>
              <option value="">— choose —</option>
              {BORROW_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contact no." hint={options.mayNameBorrower ? 'For a borrower with no login; a login’s own number prints otherwise' : 'Leave blank to print the number on your account'}>
            <input value={form.contactNo} maxLength={80} onChange={(e) => set({ contactNo: e.target.value })} />
          </Field>
          <Field label="Site location" hint="Where it goes — the customer site, the office, the lab">
            <input value={form.siteLocation} maxLength={300} onChange={(e) => set({ siteLocation: e.target.value })} />
          </Field>
          <Field label="Needed on">
            <input type="date" value={form.neededOn} onChange={(e) => set({ neededOn: e.target.value })} />
          </Field>
          <Field label="Due back" required error={attempted && !form.dueAt ? 'When does it come back?' : null}>
            <input type="date" value={form.dueAt} required onChange={(e) => set({ dueAt: e.target.value })} />
          </Field>
          <Field label="Purpose" required error={attempted && form.purpose.trim().length < 3 ? 'Say what it is for' : null}>
            <input
              value={form.purpose}
              maxLength={300}
              required
              autoFocus={!editing}
              placeholder="e.g. Pressure test at the customer's plant"
              onChange={(e) => set({ purpose: e.target.value })}
            />
          </Field>
        </div>
        <div className="qe-rows">
          <Field label="Notes">
            <textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
      </section>

      <section className="card" aria-labelledby="bs-items">
        <div className="card-head">
          <h2 id="bs-items" className="card-title">
            Items
          </h2>
          <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls, blank()])} disabled={!form.warehouseId}>
            + Add item
          </button>
        </div>
        {!form.warehouseId ? (
          <Empty title="Choose the warehouse first" hint="The items it holds, and how many are free to lend, appear here." />
        ) : items.length === 0 ? (
          <Empty title="Nothing to lend here" hint="This warehouse holds nothing available right now." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">Available</th>
                  <th className="right proc-col-input">Quantity</th>
                  <th>Asset / serial no.</th>
                  <th>Condition out</th>
                  <th className="proc-col-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const it = byId.get(l.itemId);
                  return (
                    <tr key={i}>
                      <td>
                        <select aria-label={`Item ${i + 1}`} value={l.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })}>
                          <option value="">— choose —</option>
                          {items.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.code} — {s.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="right mono">{it ? `${it.available} ${it.unit}` : <span className="faint">—</span>}</td>
                      <td>
                        <NumberInput
                          kind="quantity"
                          className="mono proc-cell-input"
                          step="0.001"
                          aria-label={`Quantity of item ${i + 1}`}
                          value={l.quantity}
                          max={it?.available}
                          onChange={(e) => setLine(i, { quantity: e.target.value })}
                        />
                      </td>
                      <td>
                        <input aria-label={`Serial number of item ${i + 1}`} value={l.serialNo} maxLength={120} onChange={(e) => setLine(i, { serialNo: e.target.value })} />
                      </td>
                      <td className="inc-unit-cell">
                        <input
                          aria-label={`Condition of item ${i + 1} as it leaves`}
                          list="borrow-conditions"
                          value={l.conditionOut}
                          maxLength={80}
                          onChange={(e) => setLine(i, { conditionOut: e.target.value })}
                        />
                      </td>
                      <td>
                        <div className="proc-row-actions">
                          {/* An unsaved row of this form: nothing on record is lost, so no question. */}
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Remove item ${i + 1}`}
                            onClick={() => {
                              setLines((ls) => (ls.length === 1 ? [blank()] : ls.filter((_, n) => n !== i)));
                              setDirty(true);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <datalist id="borrow-conditions">
        {CONDITIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="page-foot">{saveButton}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SLIP
// ════════════════════════════════════════════════════════════════════

interface SlipItem {
  id: string;
  quantity: number;
  returnedQty: number;
  outstandingQty: number;
  serialNo: string | null;
  conditionOut: string | null;
  conditionBack: string | null;
  item: { id: string; code: string; partNumber: string | null; brand: string | null; name: string; unit: string };
}

export function BorrowSlipDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [slip, setSlip] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [returns, setReturns] = useState<Record<string, string>>({});
  const [backConditions, setBackConditions] = useState<Record<string, string>>({});
  const [verdict, setVerdict] = useState('COMPLETE_GOOD');
  const [returnNote, setReturnNote] = useState('');
  const [modifying, setModifying] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const s = await api.get<Record<string, unknown>>(`/borrow-slips/${id}`);
      setSlip(s);
      const items = s.items as SlipItem[];
      setReturns(Object.fromEntries(items.map((i) => [i.id, i.outstandingQty ? String(i.outstandingQty) : ''])));
      setBackConditions(Object.fromEntries(items.map((i) => [i.id, i.conditionBack ?? (i.outstandingQty ? 'Good' : '')])));
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

  const items = slip.items as SlipItem[];
  const job = slip.job as { id: string; number: string } | null;
  const warehouse = slip.warehouse as { id: string; name: string };
  const requestedBy = slip.requestedBy as { id: string; name: string } | null;
  const issuedBy = slip.issuedBy as { id: string; name: string } | null;
  const status = String(slip.status);
  const number = String(slip.number);
  const isDraft = status === 'DRAFT';
  const route = (slip.approvalRoute ?? null) as PreviewRoute | null;
  const notes = typeof slip.notes === 'string' && slip.notes ? slip.notes : null;
  const canReturn = slip.canReturn === true;
  const neededOn = typeof slip.neededOn === 'string' ? slip.neededOn : null;
  const text = (k: string) => (typeof slip[k] === 'string' && slip[k] ? (slip[k] as string) : null);
  const inspectedBy = slip.inspectedBy as { id: string; name: string } | null;

  /** Asked in the confirm bar, which shows a refusal — so these throw rather than catching. */
  async function submit() {
    setSlip(await api.post<Record<string, unknown>>(`/borrow-slips/${id}/submit`));
    setReload((n) => n + 1);
    toast('ok', `${number} submitted for approval`);
  }
  async function withdraw() {
    setSlip(await api.post<Record<string, unknown>>(`/borrow-slips/${id}/withdraw`));
    setReload((n) => n + 1);
    toast('ok', `${number} pulled back to a draft`);
  }
  async function cancel(reason: string) {
    await api.post(`/borrow-slips/${id}/cancel`, { reason });
    toast('ok', `${number} cancelled`);
    await load();
  }
  async function release() {
    setSlip(await api.post<Record<string, unknown>>(`/borrow-slips/${id}/release`, {}));
    toast('ok', `${number} released to ${String(slip!.borrowerName)}`);
    await load();
  }
  async function receiveBack() {
    try {
      await api.post(`/borrow-slips/${id}/return`, {
        items: items
          .filter((i) => Number(returns[i.id]) > 0)
          .map((i) => ({ itemId: i.id, quantity: Number(returns[i.id]), conditionBack: backConditions[i.id]?.trim() || null })),
        returnedCondition: verdict || null,
        note: returnNote.trim() || null,
      });
      setReturnNote('');
      toast('ok', 'Returned to stock');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  const primary = isDraft && slip.needsApproval === true ? (
    <button
      className="btn btn-primary"
      disabled={slip.canSubmit !== true}
      onClick={() =>
        confirm.ask({
          title: `Submit ${number} for approval?`,
          body: `Nothing leaves ${warehouse.name} until it is approved and the warehouse releases it.`,
          confirmLabel: 'Submit for approval',
          tone: 'primary',
          onConfirm: submit,
        })
      }
    >
      Submit for approval
    </button>
  ) : slip.canRelease === true ? (
    <button
      className="btn btn-primary"
      onClick={() =>
        confirm.ask({
          title: `Release ${number} to ${String(slip.borrowerName)}?`,
          body: `The items leave ${warehouse.name}'s available stock until they come back, due ${formatDate(String(slip.dueAt))}. No project is charged.`,
          confirmLabel: 'Release',
          tone: 'primary',
          onConfirm: release,
        })
      }
    >
      Release
    </button>
  ) : null;

  return (
    <div>
      <RecordHeader
        type="Borrow Slip"
        code={number}
        title={String(slip.borrowerName)}
        status={slip.isOverdue === true ? 'OVERDUE' : status}
        statusExtra={BORROW_TONES}
        meta={
          <>
            {String(slip.purpose)} · {warehouse.name}
            {job && (
              <>
                {' '}
                · <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link>
              </>
            )}
            {neededOn && !issuedBy ? ` · needed ${formatDate(neededOn)}` : ''} · due back {formatDate(String(slip.dueAt))}
            {requestedBy && requestedBy.name !== slip.borrowerName ? ` · asked by ${requestedBy.name}` : ''}
          </>
        }
        actions={primary}
        print={`/api/borrow-slips/${id}/pdf`}
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
            label: 'Cancel request',
            danger: true,
            confirm: {
              title: `Cancel ${number}?`,
              body:
                status === 'APPROVED'
                  ? 'Nothing has left the shelf. Who asked for it is told why — say it here (for example, not on the shelf).'
                  : 'Nothing has left the shelf. The reason is kept on the slip.',
              confirmLabel: 'Cancel request',
              reason: 'required',
              minReason: 3,
              onConfirm: cancel,
            },
          },
        ]}
        modify={
          slip.canEditSheet === true
            ? `/g-chain/borrow-slips/${id}/edit`
            : slip.canEdit === true
              ? () => setModifying(true)
              : undefined
        }
        confirm={confirm}
      />

      {isDraft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="borrow_slip" documentId={String(id)} reloadToken={reload} />
      {status !== 'DRAFT' && status !== 'CANCELLED' && requestedBy && (
        <DocumentApproval documentType="borrow_slip" documentId={String(id)} reloadToken={reload} />
      )}

      <ErrorBox error={error} />

      {isDraft && <div className="alert info">A request. Nothing leaves the shelf until it is approved and the warehouse releases it.</div>}
      {status === 'PENDING_APPROVAL' && <div className="alert info">Waiting for approval. Nothing has left {warehouse.name} yet.</div>}
      {status === 'APPROVED' && (
        <div className="alert info">Approved — the warehouse releases it. Nothing has left {warehouse.name} yet.</div>
      )}
      {status === 'CANCELLED' && typeof slip.cancelReason === 'string' && (
        <div className="alert warn">Cancelled — {slip.cancelReason}</div>
      )}

      <div className="card">
        <h3 className="card-title">Borrower's details</h3>
        <dl className="kv">
          <dt>Borrower</dt>
          <dd>
            {String(slip.borrowerName)}
            {requestedBy && requestedBy.name !== slip.borrowerName ? <span className="muted"> · asked by {requestedBy.name}</span> : null}
          </dd>
          <dt>Borrowing type</dt>
          <dd>{text('borrowTypeLabel') ?? '—'}</dd>
          <dt>Contact no.</dt>
          <dd>{text('contactNo') ?? <span className="muted">on their account</span>}</dd>
          <dt>Project / customer</dt>
          <dd>{job ? <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link> : '—'}</dd>
          <dt>Site location</dt>
          <dd>{text('siteLocation') ?? '—'}</dd>
          <dt>Purpose</dt>
          <dd>{String(slip.purpose)}</dd>
          {notes && (
            <>
              <dt>Notes</dt>
              <dd className="activity-notes">{notes}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card">
        <h3 className="card-title">{issuedBy ? 'Items on loan' : 'Items asked for'}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Condition out</th>
                <th className="right">{issuedBy ? 'Lent' : 'Asked'}</th>
                {issuedBy && <th className="right">Back</th>}
                {issuedBy && <th>Condition back</th>}
                {issuedBy && <th className="right">Still out</th>}
                {canReturn && <th className="right proc-col-input">Returning now</th>}
                {canReturn && <th>As it comes back</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>{i.item.name}</div>
                    <div className="faint mono">
                      {i.item.partNumber ?? i.item.code}
                      {i.item.brand ? ` · ${i.item.brand}` : ''}
                      {i.serialNo ? ` · ${i.serialNo}` : ''}
                    </div>
                  </td>
                  <td>{i.conditionOut ?? <span className="faint">—</span>}</td>
                  <td className="right mono">
                    {i.quantity} {i.item.unit}
                  </td>
                  {issuedBy && <td className="right mono faint">{i.returnedQty || '—'}</td>}
                  {issuedBy && <td>{i.conditionBack ?? <span className="faint">—</span>}</td>}
                  {issuedBy && <td className="right mono">{i.outstandingQty || '—'}</td>}
                  {canReturn && (
                    <td>
                      <NumberInput
                        kind="quantity"
                        className="mono proc-cell-input"
                        step="0.001"
                        max={i.outstandingQty}
                        aria-label="Quantity returning now"
                        value={returns[i.id] ?? ''}
                        onChange={(e) => setReturns({ ...returns, [i.id]: e.target.value })}
                      />
                    </td>
                  )}
                  {canReturn && (
                    <td className="inc-unit-cell">
                      <input
                        aria-label={`Condition of ${i.item.name} as it comes back`}
                        list="borrow-conditions"
                        value={backConditions[i.id] ?? ''}
                        maxLength={80}
                        onChange={(e) => setBackConditions({ ...backConditions, [i.id]: e.target.value })}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The return clearance (the owner's form): the custodian's verdict and note, then the card's own act at its foot. */}
        {canReturn && (
          <div className="qe-rows proc-card-note">
            <Field label="Returned condition" hint="The custodian's verdict on what is coming back now">
              <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                {RETURN_CONDITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Inspection note" hint="What was damaged or missing, if anything">
              <input value={returnNote} maxLength={2000} onChange={(e) => setReturnNote(e.target.value)} />
            </Field>
            <datalist id="borrow-conditions">
              {CONDITIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        )}
        {canReturn && (
          <div className="proc-row-actions proc-card-note">
            <button className="btn btn-sm btn-primary" onClick={receiveBack}>
              Receive back into stock
            </button>
          </div>
        )}
        {issuedBy && (
          <p className="faint proc-card-note">
            Released by {issuedBy.name}
            {typeof slip.releasedAt === 'string' ? ` on ${formatDate(slip.releasedAt)}` : ''}
            {typeof slip.returnedAt === 'string' ? ` · everything back on ${formatDate(slip.returnedAt)}` : ''}
          </p>
        )}
      </div>

      {inspectedBy && (
        <div className="card">
          <h3 className="card-title">Return clearance</h3>
          <dl className="kv">
            <dt>Actual return date</dt>
            <dd>{typeof slip.returnedAt === 'string' ? formatDate(slip.returnedAt) : <span className="muted">part returned — the rest still out</span>}</dd>
            <dt>Returned condition</dt>
            <dd>{text('returnedConditionLabel') ?? '—'}</dd>
            <dt>Inspected by</dt>
            <dd>
              {inspectedBy.name}
              {typeof slip.inspectedAt === 'string' ? <span className="muted"> · {formatDateTime(slip.inspectedAt)}</span> : null}
            </dd>
            {text('returnNote') && (
              <>
                <dt>Note</dt>
                <dd>{text('returnNote')}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {modifying && (
        <ModifySlipModal
          slip={{
            id: String(slip.id),
            number,
            borrowerName: String(slip.borrowerName),
            dueAt: String(slip.dueAt),
            purpose: String(slip.purpose),
            notes,
            borrowType: text('borrowType') ?? '',
            siteLocation: text('siteLocation') ?? '',
            contactNo: text('contactNo') ?? '',
          }}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Modify a slip the warehouse holds — approved and waiting for release, or
 * with anything still out: who has it, when it is due back, what for, the
 * notes. The warehouse and the items are fixed: a draft request is changed
 * on its page, and a slip on loan has moved its stock.
 */
function ModifySlipModal({
  slip,
  onClose,
  onSaved,
}: {
  slip: { id: string; number: string; borrowerName: string; dueAt: string; purpose: string; notes: string | null; borrowType: string; siteLocation: string; contactNo: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    borrowerName: slip.borrowerName,
    dueAt: slip.dueAt.slice(0, 10),
    purpose: slip.purpose,
    notes: slip.notes ?? '',
    borrowType: slip.borrowType,
    siteLocation: slip.siteLocation,
    contactNo: slip.contactNo,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/borrow-slips/${slip.id}`, {
        borrowerName: form.borrowerName.trim(),
        dueAt: form.dueAt,
        purpose: form.purpose.trim(),
        notes: form.notes.trim() || null,
        borrowType: form.borrowType || null,
        siteLocation: form.siteLocation.trim() || null,
        contactNo: form.contactNo.trim() || null,
      });
      toast('ok', `${slip.number} updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify borrow slip ${slip.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.borrowerName.trim().length < 2 || !form.dueAt || form.purpose.trim().length < 3}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="alert info">The warehouse and the items are fixed on an approved or released slip.</div>
      <div className="grid grid-2">
        <Field label="Borrower">
          <input value={form.borrowerName} onChange={(e) => setForm({ ...form, borrowerName: e.target.value })} />
        </Field>
        <Field label="Due back">
          <input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Borrowing type">
          <select value={form.borrowType} onChange={(e) => setForm({ ...form, borrowType: e.target.value })}>
            <option value="">— not said —</option>
            {BORROW_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact no.">
          <input value={form.contactNo} maxLength={80} onChange={(e) => setForm({ ...form, contactNo: e.target.value })} />
        </Field>
      </div>
      <Field label="Site location">
        <input value={form.siteLocation} maxLength={300} onChange={(e) => setForm({ ...form, siteLocation: e.target.value })} />
      </Field>
      <Field label="Purpose">
        <input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}
