import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DocumentApproval } from '../../components/ApprovalStepper';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Empty, ErrorBox, Loading, StatusBadge, formatDate, formatDateTime, formatMoney, useToast } from '../../components/ui';
import { COSTING_TONES, MarginBadge, type CostingRow } from './Costings';
import { PlanBar, TemplateSavePanel } from './CostingSheet';

/**
 * The costing, as the estimate reads: its details, the project budgeted cost
 * in the six buckets, the cost summary, the scope of work on its working-day
 * plan, the terms, and where it has gone since. Nothing is edited here — Modify
 * opens the sheet (`/g-ops/costing/:id/edit`), a page rather than a dialog.
 *
 * Two halves that must agree: what the job COSTS and what it is SOLD as,
 * broken into scope phases. The phases are the Schedule of Values, so their
 * total has to equal the contract value — the page says so plainly rather
 * than letting it drift.
 */

interface Ref {
  id: string;
  name: string;
  code?: string;
}

export interface CostLine {
  id: string;
  code: string | null;
  rank: number | null;
  name: string | null;
  description: string;
  isHeading: boolean;
  quantity: number;
  unit: string;
  unitCost: number;
  amount: number;
  sortOrder: number;
  costCategory: { id: string; code: string; name: string; sortOrder: number };
  item: Ref | null;
}

export interface ScopeTask {
  id: string;
  name: string;
  startDay: number | null;
  durationDays: number;
  start: number;
  end: number;
}

export interface ScopeSection {
  id: string;
  kind: 'MAIN_WORK' | 'TESTING_COMMISSIONING' | 'TURNOVER' | 'OTHER';
  name: string;
  description: string | null;
  durationDays: number;
  value: number;
  sortOrder: number;
  startDay: number | null;
  endDay: number | null;
  planDays: number;
  tasks: ScopeTask[];
}

export interface CostingDetail extends Omit<CostingRow, 'status'> {
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'FINAL';
  /** The margin on the price, a fraction to six decimals. */
  marginPct: number;
  vatRate: number;
  /** Contract value − cost, from the stored figures. */
  marginAmount: number;
  vatAmount: number;
  grandTotal: number;
  validUntil: string | null;
  systemUnit: string | null;
  notes: string | null;
  terms: string | null;
  canEdit: boolean;
  approvalConfigured: boolean;
  companyVatRate: number;
  scopeTotal: number;
  planDays: number;
  updatedAt: string;
  lines: CostLine[];
  scopeSections: ScopeSection[];
  owner: { id: string; name: string; position?: string | null };
  site: (Ref & { address?: string | null; city?: string | null }) | null;
  /** The lead this costing was started from, when it was. */
  lead: { id: string; number: string; companyName: string; status: string } | null;
  /** Set when a salesperson assigned this costing from a lead. */
  assignedBy: { id: string; name: string } | null;
  assignedAt: string | null;
  assignmentNote: string | null;
  quotationRevisions: {
    id: string;
    revision: number;
    status: string;
    quotation: { id: string; number: string; subject: string };
  }[];
  /** The jobs built on this costing — a project or a service contract. */
  jobs: { id: string; number: string; name: string; status: string; type: string }[];
}

const KIND_LABEL: Record<ScopeSection['kind'], string> = {
  MAIN_WORK: 'Main work',
  TESTING_COMMISSIONING: 'Testing & commissioning',
  TURNOVER: 'Turnover',
  OTHER: 'Other',
};

const pct = (v: number) => `${Number((v * 100).toFixed(2))}%`;

export function CostingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();

  const [costing, setCosting] = useState<CostingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [templatePanel, setTemplatePanel] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const confirm = useConfirm();
  // Another record opened in this same page (a bell, Ctrl+K) withdraws a question about the last one.
  const closeConfirm = confirm.close;
  useEffect(() => closeConfirm(), [id, closeConfirm]);

  // A renewal arrives as ?renewFrom=<contract id>: the Contracts screen has
  // just duplicated the old contract's costing and sent the user here to
  // reprice it. The banner names the old contract when it can be read.
  const renewFrom = params.get('renewFrom');
  const [renewedContract, setRenewedContract] = useState<{ id: string; number: string } | null>(null);
  useEffect(() => {
    if (!renewFrom) return;
    api
      .get<{ id: string; number: string }>(`/service-contracts/${renewFrom}`)
      .then((c) => setRenewedContract({ id: c.id, number: c.number }))
      .catch(() => setRenewedContract(null));
  }, [renewFrom]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCosting(await api.get<CostingDetail>(`/costings/${id}`));
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
  if (!costing) return <ErrorBox error={error ?? new Error('Costing not found')} />;

  const isDraft = costing.status === 'DRAFT';
  const isFinal = costing.status === 'FINAL';
  const editable = costing.canEdit && isDraft;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast('ok', done);
      setReload((r) => r + 1);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** A fresh draft copy under a new number, then straight to it. */
  async function duplicate() {
    setBusy(true);
    try {
      const copy = await api.post<{ id: string; number: string }>(`/costings/${costing!.id}/duplicate`);
      toast('ok', `Copied as ${copy.number}`);
      navigate(`/g-ops/costing/${copy.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the confirm bar under the header, which shows a refusal and stays open. */
  async function remove() {
    await api.del(`/costings/${costing!.id}`);
    toast('ok', 'Costing deleted');
    navigate('/g-ops/costing');
  }

  /** Back to draft — asked first, because it needs approval again. Throws for the confirm bar. */
  async function reopen() {
    await api.patch(`/costings/${costing!.id}`, { status: 'DRAFT' });
    toast('ok', 'Costing reopened');
    setReload((r) => r + 1);
    await load();
  }

  async function saveTemplate(name: string, description: string, withPrices: boolean) {
    await api.post('/costings/templates', { name, description, withPrices, costingId: costing!.id });
    toast('ok', `Saved as template “${name}”`);
    setTemplatePanel(false);
  }

  // Cost lines grouped into the six buckets, in the model's order.
  const buckets = new Map<string, { category: CostLine['costCategory']; lines: CostLine[]; total: number }>();
  for (const line of costing.lines) {
    const b = buckets.get(line.costCategory.id) ?? { category: line.costCategory, lines: [], total: 0 };
    b.lines.push(line);
    b.total += line.amount;
    buckets.set(line.costCategory.id, b);
  }
  const ordered = [...buckets.values()];
  const scopeDrift = Math.round((costing.scopeTotal - costing.contractValue) * 100) / 100;

  // The next-step links. A project is built on a FINAL costing (the API
  // refuses one under approval), and a service contract is a job of that type
  // — so the renewal path is the project path with the type and the old
  // contract on it.
  const projectHref = renewFrom
    ? `/g-ops/projects?new=1&costingId=${costing.id}&type=SERVICE_CONTRACT&renewFrom=${renewFrom}`
    : `/g-ops/projects?new=1&costingId=${costing.id}`;
  const quotationHref = `/g-ops/quotations/new?costingId=${costing.id}`;
  const canCreateProject = can('gops.projects.create');
  const canCreateQuotation = can('gops.quotations.create');
  const location = costing.site ? [costing.site.name, costing.site.address, costing.site.city].filter(Boolean).join(', ') : null;

  return (
    <div className="costing-page">
      <RecordHeader
        type="Costing"
        code={costing.number}
        title={costing.title}
        status={costing.status}
        statusExtra={COSTING_TONES}
        amount={formatMoney(costing.contractValue)}
        amountLabel="Contract value (net of VAT)"
        meta={
          <>
            {costing.customer ? (
              can('gops.customers.view_all') ? (
                <Link to={`/g-ops/customers/${costing.customer.id}`}>{costing.customer.name}</Link>
              ) : (
                costing.customer.name
              )
            ) : (
              'No customer linked'
            )}{' '}
            · prepared by {costing.owner.name}
            {costing.lead && (
              <>
                {' '}
                · from lead <Link to={`/g-ops/leads/${costing.lead.id}`}>{costing.lead.number}</Link>
              </>
            )}
            {costing.quotationRevisions.length > 0 && (
              <>
                {' '}
                · on{' '}
                {costing.quotationRevisions.map((r, i) => (
                  <Fragment key={r.id}>
                    {i > 0 && ', '}
                    <Link to={`/g-ops/quotations/${r.quotation.id}`}>
                      {r.quotation.number} R{r.revision}
                    </Link>
                  </Fragment>
                ))}
              </>
            )}
          </>
        }
        actions={
          <>
            {editable &&
              (costing.approvalConfigured ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => act(() => api.post(`/costings/${costing.id}/submit`), 'Submitted for approval')}
                >
                  Submit for approval
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => act(() => api.patch(`/costings/${costing.id}`, { status: 'FINAL' }), 'Costing marked final')}
                >
                  Mark final
                </button>
              ))}
            {isFinal && canCreateProject && (
              <Link to={projectHref} className="btn btn-primary">
                {renewFrom ? 'Create service contract' : 'Convert to project'}
              </Link>
            )}
            {canCreateQuotation && (
              <Link to={quotationHref} className="btn">
                Create quotation
              </Link>
            )}
          </>
        }
        print={`/api/costings/${costing.id}/pdf`}
        more={[
          can('gops.costing.create') && { label: 'Duplicate', hint: 'A fresh draft copy under a new number', disabled: busy, onSelect: () => void duplicate() },
          can('gops.costing.create') && { label: 'Save as template', onSelect: () => setTemplatePanel(true) },
          costing.canEdit &&
            isFinal && {
              label: 'Reopen',
              confirm: {
                title: `Reopen ${costing.number}?`,
                body: costing.approvalConfigured
                  ? 'It goes back to draft and needs approval again before a project can be built on it.'
                  : 'It goes back to draft and must be marked final again before a project can be built on it.',
                confirmLabel: 'Reopen',
                tone: 'primary',
                onConfirm: reopen,
              },
            },
          costing.canEdit &&
            can('gops.costing.delete') &&
            isDraft && {
              label: 'Delete',
              danger: true,
              confirm: { title: `Delete ${costing.number}?`, body: 'It cannot be undone.', confirmLabel: 'Delete', onConfirm: remove },
            },
        ]}
        modify={editable ? `/g-ops/costing/${costing.id}/edit` : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />
      {templatePanel && (
        <div className="card">
          <TemplateSavePanel defaultName={costing.title} onSave={saveTemplate} onCancel={() => setTemplatePanel(false)} />
        </div>
      )}

      {renewFrom && (
        <div className="alert warn">
          Renewal of{' '}
          {renewedContract ? (
            <Link to={`/g-ops/service-contracts/${renewedContract.id}`} className="mono">
              {renewedContract.number}
            </Link>
          ) : (
            'the previous service contract'
          )}{' '}
          — copied at last year's prices. Reprice the lines, finalise the costing, then <strong>Create service contract</strong>.
        </div>
      )}
      {costing.status === 'PENDING_APPROVAL' && (
        <div className="alert info">With the approver. It holds still until they decide; a rejection brings it back to draft to rework.</div>
      )}

      {/* The headline numbers, always visible — this is what the page is for. */}
      <div className="grid grid-4 cs-stats">
        <Stat label="Project budgeted cost" value={formatMoney(costing.totalCost)} />
        <Stat label="Contract value (net of VAT)" value={formatMoney(costing.contractValue)} accent />
        <Stat label="Grand total" value={formatMoney(costing.grandTotal)} />
        <Stat label="Gross margin" value={<MarginBadge pct={costing.grossMarginPct} />} />
      </div>

      {(costing.approvalConfigured || !isDraft) && <DocumentApproval documentType="costing" documentId={costing.id} reloadToken={reload} />}

      <section className="card" aria-labelledby="cs-details">
        <h2 id="cs-details" className="card-title">
          Costing details
        </h2>
        <dl className="cs-facts">
          <Fact label="Costing No." value={<span className="mono">{costing.number}</span>} />
          <Fact label="Date" value={formatDate(costing.createdAt)} />
          <Fact label="Project / job" value={costing.title} />
          <Fact label="Valid until" value={costing.validUntil ? formatDate(`${costing.validUntil}T00:00:00`) : null} />
          <Fact
            label="Customer"
            value={
              costing.customer ? (
                can('gops.customers.view_all') ? (
                  <Link to={`/g-ops/customers/${costing.customer.id}`}>{costing.customer.name}</Link>
                ) : (
                  costing.customer.name
                )
              ) : null
            }
          />
          <Fact label="System / unit" value={costing.systemUnit} />
          <Fact label="Location" value={location} />
          <Fact label="Prepared by" value={costing.owner.name} />
          {costing.lead && (
            <Fact
              label="From lead"
              value={
                <Link to={`/g-ops/leads/${costing.lead.id}`} className="mono">
                  {costing.lead.number}
                </Link>
              }
            />
          )}
          {costing.assignedBy && (
            <Fact
              label="Assigned by"
              value={`${costing.assignedBy.name}, ${formatDateTime(costing.assignedAt)}${costing.assignmentNote ? ` — ${costing.assignmentNote}` : ''}`}
            />
          )}
          <Fact label="Last edited" value={formatDateTime(costing.updatedAt)} />
        </dl>
      </section>

      <section className="card" aria-labelledby="cs-cost">
        <h2 id="cs-cost" className="card-title">
          Project budgeted cost
        </h2>
        {costing.lines.length === 0 ? (
          <Empty title="No cost lines yet" hint="Modify the costing to add what the job will cost, in the six buckets." />
        ) : (
          <div className="table-wrap">
            <table className="data cs-view">
              <thead>
                <tr>
                  <th className="cs-col-code">Code</th>
                  <th>Description</th>
                  <th>Unit</th>
                  <th className="right">Qty</th>
                  <th className="right">Unit cost</th>
                  <th className="right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((bucket, bi) => {
                  const open = !collapsed.has(bucket.category.id);
                  return (
                    <Fragment key={bucket.category.id}>
                      <tr className="cs-cat-row">
                        <td colSpan={5}>
                          <button
                            type="button"
                            className="cs-cat-toggle"
                            aria-expanded={open}
                            onClick={() =>
                              setCollapsed((c) => {
                                const next = new Set(c);
                                if (next.has(bucket.category.id)) next.delete(bucket.category.id);
                                else next.add(bucket.category.id);
                                return next;
                              })
                            }
                          >
                            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {bucket.lines[0]?.rank ?? bi + 1} {bucket.category.name}
                          </button>
                        </td>
                        <td className="right mono">{formatMoney(bucket.total)}</td>
                      </tr>
                      {open &&
                        bucket.lines.map((line) =>
                          line.isHeading ? (
                            <tr key={line.id} className="cs-subhead">
                              <td />
                              <td colSpan={5}>
                                <strong>{line.name || line.description}</strong>
                              </td>
                            </tr>
                          ) : (
                            <tr key={line.id}>
                              <td className="mono faint">{line.code}</td>
                              <td>
                                <div className="cs-line-name">{line.name || line.description}</div>
                                {line.name && line.description && line.description !== line.name && (
                                  <div className="faint cs-line-desc">{line.description}</div>
                                )}
                                {line.item && <div className="faint mono">{line.item.code}</div>}
                              </td>
                              <td>{line.unit}</td>
                              <td className="right mono">{line.quantity}</td>
                              <td className="right mono">{formatMoney(line.unitCost)}</td>
                              <td className="right mono">{formatMoney(line.amount)}</td>
                            </tr>
                          ),
                        )}
                    </Fragment>
                  );
                })}
                <tr className="cs-strong">
                  <td colSpan={5} className="right">
                    Total project budgeted cost
                  </td>
                  <td className="right mono">{formatMoney(costing.totalCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-2">
        <section className="card" aria-labelledby="cs-summary">
          <h2 id="cs-summary" className="card-title">
            Cost summary
          </h2>
          <table className="data cs-summary">
            <tbody>
              {/* The owner's summary (2026-10-09): the margin as a share of the price; no contingency row and no discount. */}
              <SummaryRow label="Project budgeted cost" value={formatMoney(costing.totalCost)} />
              <SummaryRow label={`Margin (${pct(costing.grossMarginPct)} of the price)`} value={formatMoney(costing.marginAmount)} />
              <SummaryRow label="Subtotal (contract value)" value={formatMoney(costing.contractValue)} strong />
              <SummaryRow label={costing.vatRate > 0 ? `VAT (${pct(costing.vatRate)})` : 'VAT (zero-rated)'} value={formatMoney(costing.vatAmount)} />
              <tr className="cs-grand">
                <td>GRAND TOTAL</td>
                <td className="right mono">{formatMoney(costing.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
          <p className="faint cs-note">
            The margin is a share of the contract value, not of cost. The project budgeted cost — every line, contingency
            included — becomes the project's purchasing budget.
          </p>
        </section>

        <section className="card" aria-labelledby="cs-next">
          <h2 id="cs-next" className="card-title">
            Where this goes next
          </h2>
          <div className="section-label">QUOTATIONS</div>
          {costing.quotationRevisions.length === 0 ? (
            <p className="muted cs-tight">Not yet on a quotation. The scope phases fill the quotation's lines in one click.</p>
          ) : (
            <div className="stack cs-links">
              {costing.quotationRevisions.map((r) => (
                <Link key={r.id} to={`/g-ops/quotations/${r.quotation.id}`} className="row">
                  <span className="mono">
                    {r.quotation.number} R{r.revision}
                  </span>
                  <StatusBadge status={r.status} />
                  <span className="muted">{r.quotation.subject}</span>
                </Link>
              ))}
            </div>
          )}

          <hr className="rule" />
          <div className="section-label">PROJECTS</div>
          {costing.jobs.length === 0 ? (
            <p className="muted cs-tight">
              {isFinal
                ? 'No project built on this costing yet.'
                : costing.approvalConfigured
                  ? 'A project is built on an approved costing — submit this one for approval first.'
                  : 'A project is built on a final costing — mark this one final first.'}
            </p>
          ) : (
            <div className="stack cs-links">
              {costing.jobs.map((j) => (
                <Link key={j.id} to={`/g-ops/projects/${j.id}`} className="row">
                  <span className="mono">{j.number}</span>
                  <StatusBadge status={j.status} />
                  <span className="muted">
                    {j.name}
                    {j.type === 'SERVICE_CONTRACT' ? ' · service contract' : ''}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="cs-scope">
        <div className="row cs-block-head">
          <h2 id="cs-scope" className="card-title">
            Scope of work — schedule of values
          </h2>
          <div className="row">
            <span className="faint">
              {costing.planDays > 0 ? `${costing.planDays} working days (Mon–Fri)` : ''}
            </span>
            {editable && costing.scopeSections.length > 0 && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => act(() => api.post(`/costings/${costing.id}/sections/distribute`), 'Contract value spread across the phases')}
              >
                Spread contract value
              </button>
            )}
          </div>
        </div>
        {costing.scopeSections.length === 0 ? (
          <Empty title="No scope of work yet" hint="Typically: main works, testing & commissioning, turnover — each phase is billed against." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data cs-view cs-scope">
                <thead>
                  <tr>
                    <th>Phase / task</th>
                    <th className="right">Start</th>
                    <th className="right">End</th>
                    <th className="right">Days</th>
                    <th className="cs-col-bar">Plan</th>
                    <th className="right">Value</th>
                    <th className="right">% of contract</th>
                  </tr>
                </thead>
                <tbody>
                  {costing.scopeSections.map((s) => (
                    <Fragment key={s.id}>
                      <tr className="cs-cat-row">
                        <td>
                          <strong>{s.name}</strong> <span className="faint">· {KIND_LABEL[s.kind]}</span>
                          {s.description && <div className="faint">{s.description}</div>}
                        </td>
                        <td className="right mono">{s.startDay ? `Day ${s.startDay}` : '—'}</td>
                        <td className="right mono">{s.endDay ? `Day ${s.endDay}` : '—'}</td>
                        <td className="right mono">{s.planDays}</td>
                        <td className="cs-col-bar">
                          {s.startDay && <PlanBar start={s.startDay} days={s.planDays} total={Math.max(costing.planDays, 1)} />}
                        </td>
                        <td className="right mono">{formatMoney(s.value)}</td>
                        <td className="right mono faint">
                          {costing.contractValue > 0 ? `${((s.value / costing.contractValue) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                      {s.tasks.map((t) => (
                        <tr key={t.id}>
                          <td className="cs-task-name">{t.name}</td>
                          <td className="right mono">Day {t.start}</td>
                          <td className="right mono">Day {t.end}</td>
                          <td className="right mono">{t.durationDays}</td>
                          <td className="cs-col-bar">
                            <PlanBar start={t.start} days={t.durationDays} total={Math.max(costing.planDays, 1)} />
                          </td>
                          <td />
                          <td />
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  <tr className="cs-strong">
                    <td colSpan={5} className="right">
                      Total
                    </td>
                    <td className="right mono">{formatMoney(costing.scopeTotal)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {Math.abs(scopeDrift) > 0.009 ? (
              <div className="alert error cs-after">
                The phases total {formatMoney(costing.scopeTotal)}, but the contract value is {formatMoney(costing.contractValue)} —{' '}
                {scopeDrift > 0 ? 'over' : 'under'} by {formatMoney(Math.abs(scopeDrift))}.
                {editable && ' Use “Spread contract value” to reconcile it.'}
              </div>
            ) : (
              <div className="alert ok cs-after">The schedule of values matches the contract value. This is what progress billing will bill against.</div>
            )}
          </>
        )}
      </section>

      {(costing.terms || costing.notes) && (
        <div className="grid grid-2">
          <section className="card" aria-labelledby="cs-terms">
            <h2 id="cs-terms" className="card-title">
              Terms &amp; Conditions
            </h2>
            {costing.terms ? <div className="cs-pre">{costing.terms}</div> : <p className="muted">None — nothing prints under Terms.</p>}
          </section>
          <section className="card" aria-labelledby="cs-notes">
            <h2 id="cs-notes" className="card-title">
              Internal notes <span className="faint cs-note">· not printed</span>
            </h2>
            {costing.notes ? <div className="cs-pre">{costing.notes}</div> : <p className="muted">None.</p>}
          </section>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="cs-fact">
      <dt>{label}</dt>
      <dd>{value ?? <span className="faint">—</span>}</dd>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card cs-stat">
      <div className="faint cs-stat-label">{label.toUpperCase()}</div>
      <div className={`cs-stat-value${accent ? ' is-accent' : ''}`}>{value}</div>
    </div>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'cs-strong' : undefined}>
      <td>{label}</td>
      <td className="right mono">{value}</td>
    </tr>
  );
}
