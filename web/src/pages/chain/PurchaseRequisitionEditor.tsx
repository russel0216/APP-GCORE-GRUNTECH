import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { ApprovalStepper, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { Meter } from '../../components/charts';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { parseDelimited, preferredFrom, prLineAmount, rowsToPrLines, type PrLineDraft } from '../../lib/prLines';

/**
 * The purchase requisition as a PAGE (2026-10-13, the owner's call: "Purchase
 * request in Project should not be popup window, it should be a full form
 * with line item and budget allocation", patterned on gasiontech G-CORE's
 * Purchase Requisition). One page for New and Modify:
 * `/g-ops/purchase-requests/new?jobId=` from a project's Purchase
 * Requisition tab, `/g-chain/purchase-requests/new` from the register, and
 * `/…/purchase-requests/:id/edit` on a draft.
 *
 * Header and lines are ONE save (`POST /purchase-requests` with `lines[]`,
 * `PUT /purchase-requests/:id/sheet`), every line checked before the number
 * is issued. Beside the lines, the project's budget by budget line as it
 * stands less what this request asks — nothing is committed until the
 * request is approved — and under them the route submitting would take, from
 * the approval engine (nobody is picked on the form).
 */

export interface Category {
  id: string;
  code: string;
  name: string;
}

export interface BudgetLine extends Category {
  budgeted: number;
  committed: number;
  incurred: number;
  available: number;
}

interface Budget {
  job: { id: string; number: string; name: string };
  lines: BudgetLine[];
  total: { budgeted: number; committed: number; incurred: number; available: number };
  blocked: boolean;
}

/** What a sales order has spent buying for itself (2026-10-21) — `salesOrderSpend` on the API. */
export interface OrderSpend {
  quoted: number;
  requested: number;
  committed: number;
  incurred: number;
  left: number;
}

interface OrderBudget {
  salesOrder: { id: string; number: string; status: string; customer: string };
  spend: OrderSpend | null;
}

interface OrderOption {
  id: string;
  number: string;
  customer: string;
  subject: string;
}

export interface Suggestion {
  id: string;
  itemId?: string | null;
  code?: string;
  partNumber: string | null;
  name: string;
  description: string;
  quantity?: number;
  unit: string;
  unitCost: number | null;
  costCategory: Category | null;
  /** The supplier the costing names on the line (costing suggestions only). */
  supplier?: string | null;
}

export interface Route {
  name: string;
  steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[];
}

interface ExistingPr {
  id: string;
  number: string;
  kind: string;
  status: string;
  purpose: string;
  neededBy: string | null;
  notes: string | null;
  preferredSupplier: string | null;
  createdAt: string;
  canEdit: boolean;
  version: string;
  job: { id: string; number: string; name: string } | null;
  salesOrder: { id: string; number: string; customer: { name: string } } | null;
  warehouse: { id: string; name: string } | null;
  requestedBy: { id: string; name: string };
  items: {
    id: string;
    name: string | null;
    partNumber: string | null;
    description: string;
    quantity: number;
    unit: string;
    estimatedCost: number;
    item: { id: string } | null;
    costCategory: { id: string } | null;
  }[];
}

interface Line extends PrLineDraft {
  key: string;
  id: string | null;
  itemId: string | null;
}

interface Header {
  kind: 'DIRECT_TO_JOB' | 'STOCK_REPLENISHMENT' | 'SALES_ORDER';
  jobId: string;
  /** The issued sales order a SALES_ORDER request buys for — no project (2026-10-21). */
  salesOrderId: string;
  warehouseId: string;
  purpose: string;
  neededBy: string;
  notes: string;
  preferredSupplier: string;
}

let nextKey = 0;
const newKey = () => `l${++nextKey}`;

const blankLine = (costCategoryId = ''): Line => ({
  key: newKey(),
  id: null,
  itemId: null,
  partNumber: '',
  name: '',
  description: '',
  unit: 'pcs',
  quantity: '1',
  estimatedCost: '',
  costCategoryId,
});

/** Today + n days as `YYYY-MM-DD` in local time, for a date input. */
function daysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const amountOf = (l: Line) => prLineAmount(Number(l.quantity) || 0, Number(l.estimatedCost) || 0);
/** A line nobody has typed into yet: the page's own blank row, never sent. */
const isBlank = (l: Line) => !l.id && !l.name.trim() && !l.description.trim() && !l.partNumber.trim() && !l.estimatedCost;

/** What the page holds, compared with what it loaded, for the unsaved-changes guard. */
const snapshot = (h: Header, lines: Line[]) =>
  JSON.stringify([h, lines.filter((l) => !isBlank(l)).map(({ key: _key, ...rest }) => rest)]);

export function PurchaseRequisitionEditor() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const base = pathname.startsWith('/g-ops') ? '/g-ops/purchase-requests' : '/g-chain/purchase-requests';
  const editing = Boolean(id);

  const [existing, setExisting] = useState<ExistingPr | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [orderBudget, setOrderBudget] = useState<OrderBudget | null>(null);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [costing, setCosting] = useState<Suggestion[] | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [costingPanel, setCostingPanel] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const presetJobId = params.get('jobId');
  // Opened from a sales order's "Request purchase" (2026-10-21): bought for it, no project.
  const presetSalesOrderId = params.get('salesOrder');
  const [header, setHeader] = useState<Header>({
    kind: presetSalesOrderId ? 'SALES_ORDER' : 'DIRECT_TO_JOB',
    jobId: presetJobId ?? '',
    salesOrderId: presetSalesOrderId ?? '',
    warehouseId: '',
    purpose: '',
    // A week out: most requests are wanted soon, and a blank date is the one nobody chases.
    neededBy: daysFromToday(7),
    notes: '',
    preferredSupplier: '',
  });
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [saved, setSaved] = useState<string | null>(null);

  // ── Loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [cats, whs] = await Promise.all([
          api.get<Category[]>('/reference/cost-categories'),
          api.get<{ id: string; name: string }[]>('/warehouses').catch(() => []),
        ]);
        if (!live) return;
        const active = cats.filter((c) => (c as Category & { isActive?: boolean }).isActive !== false);
        setCategories(active);
        setWarehouses(whs);
        let h = header;
        let ls = lines;
        if (id) {
          const pr = await api.get<ExistingPr>(`/purchase-requests/${id}`);
          if (!live) return;
          setExisting(pr);
          h = {
            kind: pr.kind === 'STOCK_REPLENISHMENT' || pr.kind === 'SALES_ORDER' ? pr.kind : 'DIRECT_TO_JOB',
            jobId: pr.job?.id ?? '',
            salesOrderId: pr.salesOrder?.id ?? '',
            warehouseId: pr.warehouse?.id ?? '',
            purpose: pr.purpose,
            neededBy: pr.neededBy ? pr.neededBy.slice(0, 10) : '',
            notes: pr.notes ?? '',
            preferredSupplier: pr.preferredSupplier ?? '',
          };
          ls = pr.items.map((i) => ({
            key: newKey(),
            id: i.id,
            itemId: i.item?.id ?? null,
            partNumber: i.partNumber ?? '',
            name: i.name ?? i.description,
            description: i.name && i.description !== i.name ? i.description : '',
            unit: i.unit,
            quantity: String(i.quantity),
            estimatedCost: String(i.estimatedCost),
            costCategoryId: i.costCategory?.id ?? '',
          }));
          if (!ls.length) ls = [blankLine()];
          setHeader(h);
          setLines(ls);
        }
        setSaved(snapshot(h, ls));
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // Loaded once per page; the header and lines are the page's from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const direct = header.kind === 'DIRECT_TO_JOB';
  const forOrder = header.kind === 'SALES_ORDER';
  // The project is fixed when the page was opened from one (or the draft names one).
  const jobFixed = Boolean(presetJobId) || (editing && Boolean(existing?.job));
  // So is the sales order, opened from its page.
  const orderFixed = Boolean(presetSalesOrderId);

  useEffect(() => {
    if (orderFixed || !forOrder) return;
    api
      .get<OrderOption[]>('/purchase-requests/sales-orders')
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [orderFixed, forOrder]);

  // The sales order's cost position and its lines, whenever the order changes.
  useEffect(() => {
    setOrderBudget(null);
    if (!forOrder || !header.salesOrderId) return;
    let live = true;
    api
      .get<OrderBudget>(`/purchase-requests/budget${qs({ salesOrderId: header.salesOrderId })}`)
      .then((b) => live && setOrderBudget(b))
      .catch(() => {});
    api
      .get<{ salesOrder: Suggestion[] }>(`/purchase-requests/suggest${qs({ salesOrderId: header.salesOrderId })}`)
      .then((r) => live && setCosting(r.salesOrder))
      .catch(() => live && setCosting([]));
    return () => {
      live = false;
    };
  }, [forOrder, header.salesOrderId]);

  useEffect(() => {
    if (jobFixed || !direct) return;
    api
      .get<typeof jobs>(`/jobs/lookup${qs({ includeClosed: 'true' })}`)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [jobFixed, direct]);

  // The project's budget and its costing, whenever the project changes.
  useEffect(() => {
    setBudget(null);
    if (!forOrder) setCosting(null);
    if (!direct || !header.jobId) return;
    let live = true;
    api
      .get<Budget>(`/purchase-requests/budget${qs({ jobId: header.jobId })}`)
      .then((b) => live && setBudget(b))
      .catch(() => {});
    api
      .get<{ costing: Suggestion[] }>(`/purchase-requests/suggest${qs({ jobId: header.jobId })}`)
      .then((r) => live && setCosting(r.costing))
      .catch(() => live && setCosting([]));
    return () => {
      live = false;
    };
  }, [direct, header.jobId]);

  const total = useMemo(() => Math.round(lines.reduce((s, l) => s + amountOf(l) * 100, 0)) / 100, [lines]);

  // The route submitting would take, as the request stands.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(
          `/purchase-requests/route${qs({ amount: String(total), jobId: direct ? header.jobId : '', requestId: id ?? '' })}`,
        )
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [total, direct, header.jobId, id]);

  const dirty = saved !== null && snapshot(header, lines) !== saved;
  useUnsavedChanges(dirty && !busy);

  const projectName = budget?.job ?? existing?.job ?? jobs.find((j) => j.id === header.jobId) ?? null;
  const orderName =
    orderBudget?.salesOrder ??
    (existing?.salesOrder ? { ...existing.salesOrder, customer: existing.salesOrder.customer.name } : null) ??
    orders.find((o) => o.id === header.salesOrderId) ??
    null;
  useBackLink(
    editing && existing
      ? `${base}/${existing.id}`
      : presetJobId
        ? `/g-ops/projects/${presetJobId}?tab=procurement`
        : presetSalesOrderId
          ? `/g-ops/sales-orders/${presetSalesOrderId}`
          : null,
    editing && existing
      ? existing.number
      : projectName
        ? `${projectName.number} Purchase Requisition`
        : presetSalesOrderId && orderName
          ? orderName.number
          : null,
  );

  // ── Lines ──────────────────────────────────────────────────────────────────

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((ls) => {
      const rest = ls.filter((l) => l.key !== key);
      return rest.length ? rest : [blankLine()];
    });
  /** New lines go after the last one typed into; the page's blank row is replaced, never kept in front. */
  const appendLines = (more: Line[]) => setLines((ls) => [...ls.filter((l) => !isBlank(l)), ...more]);
  const lastCategory = () => [...lines].reverse().find((l) => l.costCategoryId)?.costCategoryId ?? '';

  function fromSuggestion(key: string, sg: Suggestion) {
    setLine(key, {
      itemId: sg.itemId ?? (sg.code ? sg.id : null),
      partNumber: sg.partNumber ?? '',
      name: sg.name,
      description: sg.description,
      unit: sg.unit || 'pcs',
      ...(sg.unitCost != null ? { estimatedCost: String(sg.unitCost) } : {}),
      ...(sg.costCategory ? { costCategoryId: sg.costCategory.id } : {}),
    });
    takeSupplier([sg.supplier]);
  }

  /** An empty "Preferred supplier" takes the supplier the costing names. */
  function takeSupplier(names: (string | null | undefined)[]) {
    setHeader((h) => {
      const next = preferredFrom(h.preferredSupplier, names);
      return next === h.preferredSupplier ? h : { ...h, preferredSupplier: next };
    });
  }

  function importRows(text: string, replaceKey?: string) {
    const { lines: parsed, skipped: refused } = rowsToPrLines(parseDelimited(text), categories);
    setSkipped(refused);
    if (!parsed.length) {
      toast('error', refused.length ? 'No row could be read — see the note under the lines' : 'Nothing to add');
      return;
    }
    const fallback = lastCategory();
    const made = parsed.map((p) => ({ ...p, key: newKey(), id: null, itemId: null, costCategoryId: p.costCategoryId || fallback }));
    setLines((ls) => {
      const at = replaceKey ? ls.findIndex((l) => l.key === replaceKey) : -1;
      if (at >= 0 && isBlank(ls[at])) return [...ls.slice(0, at), ...made, ...ls.slice(at + 1)].filter((l, _i, all) => !isBlank(l) || all.length === 1);
      return [...ls.filter((l) => !isBlank(l)), ...made];
    });
    toast('ok', `${made.length} line${made.length === 1 ? '' : 's'} added${refused.length ? ` — ${refused.length} row(s) skipped` : ''}`);
  }

  async function onFile(file: File) {
    try {
      importRows(await file.text());
    } catch (err) {
      setError(err);
    }
  }

  // ── Checking and saving ────────────────────────────────────────────────────

  const sent = lines.filter((l) => !isBlank(l));
  const lineProblem = (l: Line): string | null => {
    if (isBlank(l)) return null;
    if (!l.name.trim() && !l.description.trim()) return 'Say what is needed';
    if (!(Number(l.quantity) > 0)) return 'Quantity must be more than zero';
    if (direct && !l.costCategoryId) return 'Choose its budget line';
    return null;
  };
  const problems: string[] = [];
  if (header.purpose.trim().length < 3) problems.push('Say what this request is for (Purpose)');
  if (direct && !header.jobId) problems.push('Choose the project');
  if (forOrder && !header.salesOrderId) problems.push('Choose the sales order');
  if (header.kind === 'STOCK_REPLENISHMENT' && !header.warehouseId) problems.push('Choose the warehouse');
  sent.forEach((l, i) => {
    const p = lineProblem(l);
    if (p) problems.push(`Line ${i + 1}: ${p}`);
  });

  function body() {
    return {
      kind: header.kind,
      jobId: direct ? header.jobId || null : null,
      salesOrderId: forOrder ? header.salesOrderId || null : null,
      warehouseId: header.warehouseId || null,
      purpose: header.purpose.trim(),
      neededBy: header.neededBy || null,
      notes: header.notes.trim() || null,
      preferredSupplier: header.preferredSupplier.trim() || null,
      lines: sent.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        costCategoryId: l.costCategoryId || null,
        partNumber: l.partNumber.trim() || null,
        name: l.name.trim() || null,
        description: l.description.trim() || null,
        quantity: Number(l.quantity),
        unit: l.unit.trim() || 'pcs',
        estimatedCost: Number(l.estimatedCost) || 0,
      })),
      ...(existing ? { version: existing.version } : {}),
    };
  }

  /** Saves header and lines in one request; then, for "Submit for approval", submits. */
  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    if (submit && !sent.length) {
      setError(new Error('Add at least one line before submitting'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/purchase-requests/${existing.id}/sheet`, body())).id
        : (await api.post<{ id: string; number: string }>('/purchase-requests', body())).id;
      setSaved(snapshot(header, lines));
      if (submit) {
        try {
          await api.post(`/purchase-requests/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          // Saved, but the submit was refused (the budget guard, a route nobody holds):
          // the request's page says why and offers Submit again.
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Purchase requisition saved');
      navigate(`${base}/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Purchase request not found')} />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status !== 'DRAFT'
            ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} and holds still. A pending request is pulled back to draft from ⋯ on its page.`
            : 'Only the person who raised this request, or someone who may edit every request, can change it.'}
        </p>
      </div>
    );
  }

  const asked = new Map<string, number>();
  for (const l of sent) if (l.costCategoryId) asked.set(l.costCategoryId, (asked.get(l.costCategoryId) ?? 0) + amountOf(l));
  const budgetRows = (budget?.lines ?? []).filter((b) => b.budgeted > 0 || asked.has(b.id));
  const over = budgetRows.filter((b) => b.available - (asked.get(b.id) ?? 0) < -0.004);
  const mayCreate = can('gchain.purchase_requests.create');
  const costingHas = new Set(lines.map((l) => `${l.costCategoryId}|${l.name.trim().toLowerCase()}`));

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {mayCreate && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="prq-heading">
        <div className="qe-head">
          <div>
            <h1 id="prq-heading" className="qe-heading">
              {existing ? `Modify purchase requisition ${existing.number}` : 'New purchase requisition'}
            </h1>
            <p className="muted qe-lead">
              {direct && projectName ? (
                <>
                  For <Link to={`/g-ops/projects/${projectName.id}`}>{projectName.number} — {projectName.name}</Link>.{' '}
                </>
              ) : null}
              {forOrder && orderName ? (
                <>
                  For sales order <Link to={`/g-ops/sales-orders/${orderName.id}`}>{orderName.number} — {orderName.customer}</Link>, no
                  project.{' '}
                </>
              ) : null}
              {existing
                ? 'Change what you need and Save — the header and the lines are saved together.'
                : 'The header and the lines are saved together; the number is issued on the first save.'}
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

      <div className={`prq-grid${direct || forOrder ? '' : ' prq-grid-solo'}`}>
        <div className="prq-main">
          {/* ── Details ─────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="prq-details">
            <h2 id="prq-details" className="card-title">Purchase requisition details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              {!jobFixed && !orderFixed ? (
                <Field label="Kind">
                  <select
                    value={header.kind}
                    onChange={(e) => {
                      const kind = e.target.value as Header['kind'];
                      setCosting(null);
                      setHeader((h) => ({
                        ...h,
                        kind,
                        jobId: kind === 'DIRECT_TO_JOB' ? h.jobId : '',
                        salesOrderId: kind === 'SALES_ORDER' ? h.salesOrderId : '',
                      }));
                    }}
                  >
                    <option value="DIRECT_TO_JOB">Direct to project (charged to its budget)</option>
                    <option value="SALES_ORDER">For a sales order (no project)</option>
                    <option value="STOCK_REPLENISHMENT">Warehouse stock (charged when issued)</option>
                  </select>
                </Field>
              ) : (
                <Field label="Kind">
                  <div className="qe-static">{orderFixed ? 'For a sales order' : 'Direct to project'}</div>
                </Field>
              )}
              {forOrder && !orderFixed && (
                <Field label="Sales order" required error={attempted && !header.salesOrderId ? 'Choose the sales order' : null}>
                  <select
                    value={header.salesOrderId}
                    required
                    onChange={(e) => setHeader((h) => ({ ...h, salesOrderId: e.target.value }))}
                  >
                    <option value="">— choose an issued order —</option>
                    {existing?.salesOrder && !orders.some((o) => o.id === existing.salesOrder!.id) && (
                      <option value={existing.salesOrder.id}>
                        {existing.salesOrder.number} — {existing.salesOrder.customer.name}
                      </option>
                    )}
                    {orders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.number} — {o.customer}
                        {o.subject ? ` · ${o.subject}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {direct && !jobFixed && (
                <Field label="Project" required error={attempted && !header.jobId ? 'Choose the project' : null}>
                  <select value={header.jobId} required onChange={(e) => setHeader((h) => ({ ...h, jobId: e.target.value }))}>
                    <option value="">— choose —</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.number} — {j.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label={direct || forOrder ? 'Deliver to warehouse' : 'Warehouse'}
                required={header.kind === 'STOCK_REPLENISHMENT'}
                error={attempted && header.kind === 'STOCK_REPLENISHMENT' && !header.warehouseId ? 'Choose the warehouse' : null}
              >
                <select value={header.warehouseId} onChange={(e) => setHeader((h) => ({ ...h, warehouseId: e.target.value }))}>
                  <option value="">{direct ? '— straight to site —' : forOrder ? '— straight to the customer —' : '— choose —'}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Needed by">
                <input type="date" value={header.neededBy} onChange={(e) => setHeader((h) => ({ ...h, neededBy: e.target.value }))} />
              </Field>
              <Field label="Purpose" required error={attempted && header.purpose.trim().length < 3 ? 'Say what this is for' : null}>
                <input
                  value={header.purpose}
                  maxLength={300}
                  required
                  autoFocus={!editing}
                  placeholder="e.g. PMS (1st year, 1st quarter)"
                  onChange={(e) => setHeader((h) => ({ ...h, purpose: e.target.value }))}
                />
              </Field>
              <Field label="Preferred supplier">
                <input
                  value={header.preferredSupplier}
                  maxLength={200}
                  placeholder="Optional — purchasing canvasses"
                  onChange={(e) => setHeader((h) => ({ ...h, preferredSupplier: e.target.value }))}
                />
              </Field>
            </div>
            <div className="qe-rows">
              <Field label="Notes" hint="Printed on the request">
                <textarea rows={2} value={header.notes} placeholder="Anything purchasing should know" onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
            <p className="prq-hint">
              {direct
                ? 'Each line is charged to a budget line (cost category) of the project. Only an approved request commits the budget; receiving incurs it.'
                : forOrder
                  ? "This buys for the sales order — no project is needed. What it costs is measured against the order's quoted cost; received into a warehouse, the goods are held for the order until they go out."
                  : 'This buys for the warehouse. No project is charged until the stock is issued to one.'}
            </p>
          </section>

          {/* ── Lines ───────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="prq-lines">
            <div className="card-head">
              <h2 id="prq-lines" className="card-title">Lines</h2>
              {(direct || forOrder) && costing && costing.length > 0 && (
                <span className="muted prq-source">
                  From this {forOrder ? 'sales order' : "project's costing"} · {costing.length} lines
                </span>
              )}
              {(direct || forOrder) && costing && costing.length > 0 && (
                <button type="button" className="btn btn-sm" aria-expanded={costingPanel} onClick={() => setCostingPanel((v) => !v)}>
                  {forOrder ? 'Add from sales order…' : 'Add from costing…'}
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                Import CSV
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void onFile(file);
                }}
              />
              <button type="button" className="btn btn-sm" onClick={() => appendLines([blankLine(lastCategory())])}>
                + Add line
              </button>
            </div>

            {costingPanel && costing && (
              <CostingPanel
                rows={costing}
                source={forOrder ? 'order' : 'costing'}
                onList={(sg) => costingHas.has(`${sg.costCategory?.id ?? ''}|${sg.name.trim().toLowerCase()}`)}
                onCancel={() => setCostingPanel(false)}
                onAdd={(picked) => {
                  appendLines(
                    picked.map((sg) => ({
                      ...blankLine(sg.costCategory?.id ?? ''),
                      itemId: sg.itemId ?? null,
                      partNumber: sg.partNumber ?? '',
                      name: sg.name,
                      description: sg.description,
                      unit: sg.unit || 'pcs',
                      quantity: String(sg.quantity ?? 1),
                      estimatedCost: sg.unitCost != null ? String(sg.unitCost) : '',
                    })),
                  );
                  takeSupplier(picked.map((sg) => sg.supplier));
                  setCostingPanel(false);
                  toast('ok', `${picked.length} line${picked.length === 1 ? '' : 's'} added from the ${forOrder ? 'sales order' : 'costing'}`);
                }}
              />
            )}

            <div className="table-wrap qe-table-wrap">
              <table className="data prq-lines">
                <colgroup>
                  <col className="prq-col-no" />
                  <col className="prq-col-cat" />
                  <col className="prq-col-part" />
                  <col />
                  <col className="prq-col-unit" />
                  <col className="prq-col-qty" />
                  <col className="prq-col-cost" />
                  <col className="prq-col-amount" />
                  <col className="prq-col-remove" />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Budget line</th>
                    <th>Part No.</th>
                    <th>Item and description</th>
                    <th>Unit</th>
                    <th className="right">Qty</th>
                    <th className="right">Est. unit cost</th>
                    <th className="right">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const problem = attempted ? lineProblem(l) : null;
                    return (
                      <tr key={l.key}>
                        <td className="mono">{i + 1}</td>
                        <td>
                          <select
                            aria-label={`Line ${i + 1} budget line`}
                            aria-invalid={problem === 'Choose its budget line' || undefined}
                            value={l.costCategoryId}
                            onChange={(e) => setLine(l.key, { costCategoryId: e.target.value })}
                          >
                            <option value="">{direct ? '— choose —' : '— none —'}</option>
                            {categories.map((c, n) => (
                              <option key={c.id} value={c.id}>
                                {n + 1} {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            aria-label={`Line ${i + 1} part number`}
                            value={l.partNumber}
                            maxLength={120}
                            placeholder="Part No."
                            onChange={(e) => setLine(l.key, { partNumber: e.target.value })}
                          />
                        </td>
                        <td>
                          <ItemCell
                            n={i + 1}
                            line={l}
                            jobId={direct ? header.jobId : ''}
                            salesOrderId={forOrder ? header.salesOrderId : ''}
                            invalid={problem === 'Say what is needed'}
                            onChange={(patch) => setLine(l.key, patch)}
                            onPick={(sg) => fromSuggestion(l.key, sg)}
                            onPasteRows={(text) => importRows(text, l.key)}
                          />
                          {problem && <div className="field-error">{problem}</div>}
                        </td>
                        <td>
                          <input
                            aria-label={`Line ${i + 1} unit`}
                            value={l.unit}
                            maxLength={40}
                            onChange={(e) => setLine(l.key, { unit: e.target.value })}
                          />
                        </td>
                        <td>
                          <NumberInput
                            kind="quantity"
                            aria-label={`Line ${i + 1} quantity`}
                            aria-invalid={problem === 'Quantity must be more than zero' || undefined}
                            value={l.quantity}
                            onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                          />
                        </td>
                        <td>
                          <NumberInput
                            kind="money"
                            aria-label={`Line ${i + 1} estimated unit cost`}
                            value={l.estimatedCost}
                            min={0}
                            onChange={(e) => setLine(l.key, { estimatedCost: e.target.value })}
                          />
                        </td>
                        <td className="right mono">{formatMoney(amountOf(l))}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            aria-label={`Remove line ${i + 1}`}
                            title="Remove"
                            onClick={() => removeLine(l.key)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {skipped.length > 0 && (
              <div className="alert info prq-skipped">
                Skipped from the file: {skipped.join('; ')}.{' '}
                <button type="button" className="btn btn-sm" onClick={() => setSkipped([])}>
                  Dismiss
                </button>
              </div>
            )}
            <p className="prq-hint">
              Type in Item to search {direct ? "this project's costing and " : forOrder ? "the sales order's lines and " : ''}the item master — a pick fills the part
              no., unit, cost and budget line, all still editable. Paste rows from a spreadsheet into an empty Item box
              (Part No., Item, Description, Unit, Qty, Est. unit cost) or Import CSV with those headings.
            </p>
          </section>

          {/* ── Summary ─────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="prq-summary">
            <h2 id="prq-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{sent.length}</dd>
              <dt className="prq-total-big">Request total</dt>
              <dd className="prq-total-big mono">{formatMoney(total)}</dd>
            </dl>
          </section>

          {/* ── Approval ────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="prq-approval">
            <h2 id="prq-approval" className="card-title">Approval</h2>
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
              <p className="muted">No approval route covers this request — Submit for approval will say what is missing.</p>
            )}
            <p className="prq-hint">
              Requested by {existing?.requestedBy.name ?? 'you'}. The approvers come from the approval route (Admin ›
              Approval Workflows), never picked on the form.
            </p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>

        {/* ── The sales order's cost, live ──────────────────────────────────── */}
        {forOrder && (
          <aside className="card prq-budget" aria-labelledby="prq-order-budget">
            <div className="card-head">
              <h2 id="prq-order-budget" className="card-title">Sales order cost — live</h2>
              <span className="muted prq-source">as you type</span>
            </div>
            {!header.salesOrderId ? (
              <p className="muted">Choose the sales order to see its cost.</p>
            ) : !orderBudget ? (
              <Loading />
            ) : (
              <OrderSpendPanel spend={orderBudget.spend} asked={total} />
            )}
          </aside>
        )}

        {/* ── Budget, live ──────────────────────────────────────────────────── */}
        {direct && (
          <aside className="card prq-budget" aria-labelledby="prq-budget">
            <div className="card-head">
              <h2 id="prq-budget" className="card-title">Budget — live</h2>
              <span className="muted prq-source">as you type</span>
            </div>
            {!header.jobId ? (
              <p className="muted">Choose the project to see its budget.</p>
            ) : !budget ? (
              <Loading />
            ) : (
              <>
                <p className="prq-hint">A draft charges nothing; the budget is committed when the request is approved.</p>
                {budgetRows.length === 0 && <p className="muted">This project has no budget lines yet.</p>}
                {budgetRows.map((b) => {
                  const mine = asked.get(b.id) ?? 0;
                  const left = Math.round((b.available - mine) * 100) / 100;
                  const used = b.budgeted > 0 ? ((b.budgeted - left) / b.budgeted) * 100 : 100;
                  const n = categories.findIndex((c) => c.id === b.id) + 1;
                  return (
                    <div key={b.id} className="prq-bud">
                      <div className="prq-bud-top">
                        <span>
                          {n > 0 ? `${n} · ` : ''}
                          {b.name}
                        </span>
                        <strong className={left < 0 ? 'prq-over' : undefined}>{formatMoney(left)}</strong>
                      </div>
                      <Meter pct={used} tone={left < 0 ? 'danger' : used > 85 ? 'warn' : undefined} />
                      <div className="prq-bud-sub">
                        <span>{mine ? `this request ${formatMoney(mine)}` : 'not touched'}</span>
                        <span>{left < 0 ? 'over by ' + formatMoney(-left) : 'left after'}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="prq-bud prq-bud-total">
                  <div className="prq-bud-top">
                    <strong>Project — overall left</strong>
                    <strong>{formatMoney(Math.round((budget.total.available - total) * 100) / 100)}</strong>
                  </div>
                </div>
                {over.length > 0 && (
                  <div className="alert error">
                    Over what is left on {over.map((b) => b.name).join(', ')}.{' '}
                    {budget.blocked
                      ? 'Submitting will be refused — raise a budget request first, or reduce the quantities.'
                      : 'Over-budget requests are allowed by the procurement setting, but the approver will see it.'}
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * The Item cell: the bold name with its suggestions as it is typed (the
 * project's costing first, then the item master), the description under it.
 * A block pasted from a spreadsheet into an empty name becomes rows.
 */
export function ItemCell({
  n,
  line,
  jobId,
  salesOrderId = '',
  suggestPath = '/purchase-requests/suggest',
  invalid,
  onChange,
  onPick,
  onPasteRows,
}: {
  n: number;
  line: Pick<Line, 'name' | 'description'>;
  jobId: string;
  /** A sales order's purchase: its lines come first (2026-10-21). */
  salesOrderId?: string;
  /** The suggestion endpoint — the requisition's, or the order's twin behind the order's rights. */
  suggestPath?: string;
  invalid: boolean;
  onChange: (patch: { name?: string; description?: string; itemId?: string | null }) => void;
  onPick: (sg: Suggestion) => void;
  onPasteRows: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<(Suggestion & { source: 'costing' | 'order' | 'item' })[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const term = line.name.trim();

  useEffect(() => {
    if (!open || term.length < 2) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .get<{ costing: Suggestion[]; salesOrder?: Suggestion[]; items: Suggestion[] }>(`${suggestPath}${qs({ q: term, jobId, salesOrderId })}`)
        .then((r) => {
          if (!live) return;
          setMatches([
            ...(r.salesOrder ?? []).map((s) => ({ ...s, source: 'order' as const })),
            ...r.costing.map((s) => ({ ...s, source: 'costing' as const })),
            ...r.items.map((s) => ({ ...s, source: 'item' as const })),
          ].slice(0, 20));
        })
        .catch(() => live && setMatches([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, term, jobId, salesOrderId, suggestPath]);

  const buttons = () => Array.from(menuRef.current?.querySelectorAll('button') ?? []);

  return (
    <div
      className="lookup"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        className="prq-name"
        aria-label={`Line ${n} item`}
        aria-invalid={invalid || undefined}
        aria-autocomplete="list"
        aria-expanded={open && matches.length > 0}
        autoComplete="off"
        placeholder="Item"
        maxLength={300}
        value={line.name}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange({ name: e.target.value, itemId: null });
          setOpen(true);
        }}
        onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
          const text = e.clipboardData.getData('text');
          if (!line.name && /[\t\n]/.test(text.trim())) {
            e.preventDefault();
            onPasteRows(text);
          }
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Escape' && open) {
            e.preventDefault();
            setOpen(false);
          }
          if (e.key === 'ArrowDown' && matches.length) {
            e.preventDefault();
            buttons()[0]?.focus();
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="lookup-menu qe-suggest" ref={menuRef}>
          {matches.map((sg) => (
            <li key={`${sg.source}-${sg.id}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(sg);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setOpen(false);
                    inputRef.current?.focus();
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const list = buttons();
                    const next = list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
                    if (next) next.focus();
                    else if (e.key === 'ArrowUp') inputRef.current?.focus();
                  }
                }}
              >
                <span className="qe-suggest-name">{sg.name}</span>
                <span className="faint qe-suggest-meta">
                  {sg.source === 'costing' ? 'Costing' : sg.source === 'order' ? 'Sales order' : `Item ${sg.code ?? ''}`}
                  {sg.partNumber ? ` · ${sg.partNumber}` : ''}
                  {sg.costCategory ? ` · ${sg.costCategory.name}` : ''}
                  {sg.unitCost != null ? ` · ${formatMoney(sg.unitCost)} / ${sg.unit}` : ` · ${sg.unit}`}
                </span>
                {sg.description && <span className="faint qe-suggest-desc">{sg.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="prq-desc"
        aria-label={`Line ${n} description`}
        placeholder="Description (optional)"
        maxLength={4000}
        value={line.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
    </div>
  );
}

/** "Add from costing…": the project's costing lines by budget line, ticked and added — in the page, never a dialog. */
function CostingPanel({
  rows,
  source = 'costing',
  onList,
  onAdd,
  onCancel,
}: {
  rows: Suggestion[];
  /** Whose lines: the project's costing, or the sales order's (2026-10-21). */
  source?: 'costing' | 'order';
  onList: (sg: Suggestion) => boolean;
  onAdd: (picked: Suggestion[]) => void;
  onCancel: () => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const groups = new Map<string, Suggestion[]>();
  for (const r of rows) {
    const k = r.costCategory?.name ?? (source === 'order' ? 'Sold on the sales order' : 'No budget line');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const toggle = (id: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="prq-panel">
      <p className="prq-hint">
        {source === 'order'
          ? 'Tick the sales order lines to buy. Each comes with its quantity, unit and — where you may see it — the cost the quotation carried; change any of them after.'
          : 'Tick the costing lines to request. Each comes with its quantity, unit, budget line and — where you may see it — its cost; change any of them after.'}
      </p>
      <div className="prq-panel-list">
        {[...groups.entries()].map(([name, list]) => (
          <fieldset key={name}>
            <legend>{name}</legend>
            {list.map((r) => (
              <label key={r.id} className="prq-pick">
                <input type="checkbox" checked={ticked.has(r.id)} onChange={() => toggle(r.id)} />
                <span>
                  <strong>{r.name}</strong>
                  <span className="faint">
                    {' '}
                    · {r.quantity} {r.unit}
                    {r.unitCost != null ? ` · ${formatMoney(r.unitCost)}` : ''}
                    {onList(r) ? ' · already on this request' : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="row prq-panel-foot">
        <button type="button" className="btn btn-sm" onClick={() => setTicked(new Set(rows.map((r) => r.id)))}>
          Tick all
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!ticked.size}
          onClick={() => onAdd(rows.filter((r) => ticked.has(r.id)))}
        >
          Add {ticked.size || ''} line{ticked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

/**
 * A sales order's cost as it stands (2026-10-21): the quoted cost against
 * what is requested, committed and received, with what `asked` — the request
 * on the page — would leave. Over it is said, never refused: the deal's cost
 * guards no budget the way a project's does.
 */
export function OrderSpendPanel({ spend, asked }: { spend: OrderSpend | null; asked?: number }) {
  if (!spend) return <p className="muted">Its cost is shown to whoever may see the sales order's cost.</p>;
  const after = Math.round((spend.left - spend.requested - (asked ?? 0)) * 100) / 100;
  const used = spend.quoted > 0 ? ((spend.quoted - after) / spend.quoted) * 100 : 100;
  return (
    <>
      <dl className="kv prq-spend">
        <dt>Quoted cost</dt>
        <dd className="mono">{formatMoney(spend.quoted)}</dd>
        <dt>Committed</dt>
        <dd className="mono">{formatMoney(spend.committed)}</dd>
        <dt>Received</dt>
        <dd className="mono">{formatMoney(spend.incurred)}</dd>
        {spend.requested > 0 && (
          <>
            <dt>Awaiting approval</dt>
            <dd className="mono">{formatMoney(spend.requested)}</dd>
          </>
        )}
        {asked !== undefined && (
          <>
            <dt>This request</dt>
            <dd className="mono">{formatMoney(asked)}</dd>
          </>
        )}
      </dl>
      <div className="prq-bud prq-bud-total">
        <div className="prq-bud-top">
          <strong>Left of the quoted cost</strong>
          <strong className={after < 0 ? 'prq-over' : undefined}>{formatMoney(after)}</strong>
        </div>
        <Meter pct={used} tone={after < 0 ? 'danger' : used > 85 ? 'warn' : undefined} />
      </div>
      {after < 0 && (
        <div className="alert warn">
          Over the order's quoted cost by {formatMoney(-after)} — the margin it was sold at shrinks. Submitting is allowed; the approver will see it.
        </div>
      )}
    </>
  );
}
