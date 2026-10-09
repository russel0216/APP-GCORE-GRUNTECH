import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { Stat, noTeamNote, teamCards, type TeamShare } from '../../components/charts';
import { Attachments } from '../../components/Attachments';
import { ActivityLog } from '../../components/ActivityLog';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { QUOTATION_OUTCOME_TONES } from './Quotations';
import { NumberInput } from '../../components/NumberInput';

/** Somebody a lead can be handed to, and whether selling is their job. */
export interface Person {
  id: string;
  name: string;
  isSales: boolean;
}

/**
 * Everybody a lead can go to, with the people who can actually work one
 * marked.
 *
 * "Sells" is read off the permission that lets somebody work their own lead
 * (`gops.leads.edit_own`) rather than guessed from a department or a role
 * name — the permission is what the registry already uses to decide who may
 * touch a lead at all. Both lists come from `/users/lookup`, which any
 * signed-in user may read; the old `/users?pageSize=200` is admin-gated and
 * left a salesperson with an empty picker.
 */
export async function loadPeople(): Promise<Person[]> {
  const [everyone, sellers] = await Promise.all([
    api.get<{ id: string; name: string }[]>('/users/lookup'),
    api.get<{ id: string }[]>(`/users/lookup${qs({ holding: 'gops.leads.edit_own' })}`).catch(() => []),
  ]);
  const selling = new Set(sellers.map((u) => u.id));
  return everyone.map((u) => ({ id: u.id, name: u.name, isSales: selling.has(u.id) }));
}

export const LEAD_STATUSES = [
  { value: 'NEW', label: 'New' },
  { value: 'CONTACTED', label: 'Contacted' },
  { value: 'QUALIFIED', label: 'Qualified' },
  { value: 'SITE_VISIT', label: 'Site visit' },
  { value: 'COSTING', label: 'Costing' },
  { value: 'QUOTATION_CREATED', label: 'Quotation created' },
  { value: 'QUOTATION_SUBMITTED', label: 'Quotation submitted' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
  { value: 'ON_HOLD', label: 'On hold' },
];

/**
 * The pipeline the lead is standing in.
 *
 * A row of "move to" buttons said what you could do and never said where the
 * thing was — the status was a word in the header and the buttons beside it
 * were an undifferentiated list, so "how far along is this?" took reading and
 * counting. This answers it before you read anything: a bar that fills as the
 * lead advances, the stage names underneath, and the one it is on marked.
 *
 * Won, lost and on hold are not more of the same. Two of them are ways OUT of
 * the pipeline rather than positions in it, so they get their own treatment
 * and their own colour — a lost lead should be recognisable across the room,
 * not a grey chip among ten others.
 */
const PIPELINE = LEAD_STATUSES.filter((s) => !['LOST', 'ON_HOLD'].includes(s.value));

/**
 * Stages a lead reaches only through its quotation. The server refuses them
 * on a lead with no quotation (`assertLeadStatusChange`), so the buttons say
 * so before anybody clicks.
 */
const QUOTATION_STAGES = ['QUOTATION_CREATED', 'QUOTATION_SUBMITTED', 'NEGOTIATION', 'WON'];

function LeadProgress({
  status,
  lostReason,
  canEdit,
  hasQuotation,
  onMove,
}: {
  status: string;
  lostReason: string | null;
  canEdit: boolean;
  hasQuotation: boolean;
  onMove: (status: string) => void;
}) {
  const index = PIPELINE.findIndex((s) => s.value === status);
  const lost = status === 'LOST';
  const held = status === 'ON_HOLD';
  const won = status === 'WON';
  /*
    A lead that is lost or on hold has no position on the bar: the stage it
    was at when it stopped is not recorded anywhere, and drawing it at the
    start would say it never got going. The bar shows its state instead.
  */
  const off = lost || held;
  const pct = index >= 0 ? ((index + 1) / PIPELINE.length) * 100 : 100;
  const next = index >= 0 && index < PIPELINE.length - 1 ? PIPELINE[index + 1] : null;

  const tone = lost ? 'lost' : held ? 'held' : won ? 'won' : 'live';

  return (
    <section className="card lead-progress">
      <div className="lead-progress-head">
        <div>
          <div className="section-label">WHERE IT IS NOW</div>
          <div className="lead-now">
            <StatusBadge status={status} />
            {!off && (
              <span className="faint">
                stage {index + 1} of {PIPELINE.length}
                {next ? ` · next, ${next.label.toLowerCase()}` : ' · nothing left to do'}
              </span>
            )}
            {held && <span className="faint">paused — nothing moves until somebody picks it up</span>}
            {lost && <span className="faint">{lostReason || 'no reason recorded'}</span>}
          </div>
        </div>
        {/* Put on hold and Mark lost are in the page header's ⋯ (2026-10-09, the button standard). */}
      </div>

      <div className={`lead-track ${tone}`} role="img" aria-label={progressLabel(status, index)}>
        <div className="lead-fill" style={{ width: `${pct}%` }} />
      </div>

      <ol className="lead-stages">
        {PIPELINE.map((stage, i) => {
          const done = !off && i < index;
          const here = stage.value === status;
          const cls = `lead-stage${done ? ' done' : ''}${here ? ' here' : ''}${off ? ' dimmed' : ''}`;
          const needsQuotation = !hasQuotation && QUOTATION_STAGES.includes(stage.value);
          return (
            <li key={stage.value} className={cls}>
              {canEdit && !here ? (
                <button
                  onClick={() => onMove(stage.value)}
                  disabled={needsQuotation}
                  title={
                    needsQuotation
                      ? 'Raise a quotation first — a lead reaches this stage through its quotation'
                      : `Move to ${stage.label}`
                  }
                >
                  {stage.label}
                </button>
              ) : (
                <span aria-current={here ? 'step' : undefined}>{stage.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** What the bar would say out loud, for anyone who cannot see it. */
function progressLabel(status: string, index: number): string {
  if (status === 'LOST') return 'Lost — this lead went no further';
  if (status === 'ON_HOLD') return 'On hold';
  if (status === 'WON') return 'Won — the whole pipeline is complete';
  return `Stage ${index + 1} of ${PIPELINE.length}`;
}


interface LeadRow {
  id: string;
  number: string;
  status: string;
  companyName: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  source: string | null;
  description: string | null;
  estimatedValue: number | null;
  probability: number;
  expectedClosing: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  notes: string | null;
  lostReason: string | null;
  assignedTo: { id: string; name: string };
  /** Who recorded the enquiry; a manager often adds a lead and assigns it on. */
  createdBy: { id: string; name: string } | null;
  customer: { id: string; name: string } | null;
  quotationCount?: number;
  createdAt: string;
  /** The pipeline stage its status stands in, and the stage's name — the server's `leadStage`. */
  stage?: string;
  stageLabel?: string | null;
  /** What the mass actions plan with; the PATCH still decides. */
  canEdit?: boolean;
}

/** The board's stages a lead can stand in — the tabs, before the first answer names them. */
const LEAD_STAGE_TABS = [
  { value: 'OPPORTUNITY', label: 'Opportunity' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'CLOSING', label: 'Closing' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'LOST', label: 'Lost' },
  { value: 'HOLD', label: 'On hold' },
];

interface LeadSummary {
  count?: number;
  value?: number;
  weighted?: number;
  /** The viewer's team's share of the set; only for a viewer with a team. */
  team?: { count: number; value: number; weighted: number };
  /** The set split by the owner's team — a card per team. */
  teams?: TeamShare[];
}

// ── Mass actions: Change status, Assign to ──────────────────────────────────

/**
 * The statuses a lead is moved to by hand. The quotation stages (created,
 * submitted, negotiation, won) belong to the lead's quotation and follow it;
 * they are never offered here.
 */
const BULK_LEAD_TARGETS = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'ON_HOLD', 'LOST'];
const leadStatusLabel = (v: string) => LEAD_STATUSES.find((x) => x.value === v)?.label ?? v;

/**
 * Which ticked leads a status move would take, and why the rest stay. A lead
 * with a quotation moves with its quotation — the board's rule — so it stays;
 * the PATCH (assertLeadStatusChange) still decides every one that is sent.
 */
export function planLeadMove(rows: LeadRow[], target: string): { go: LeadRow[]; stay: { row: LeadRow; why: string }[] } {
  const go: LeadRow[] = [];
  const stay: { row: LeadRow; why: string }[] = [];
  for (const r of rows) {
    if (r.status === target) stay.push({ row: r, why: `already ${leadStatusLabel(target).toLowerCase()}` });
    else if (!r.canEdit) stay.push({ row: r, why: 'assigned to someone else' });
    else if ((r.quotationCount ?? 0) > 0) stay.push({ row: r, why: 'it moves with its quotation' });
    else go.push(r);
  }
  return { go, stay };
}

/**
 * Change status, or hand the ticked leads to somebody — each one the ordinary
 * PATCH /leads/:id, so the move rules, the stage's odds, the new owner's
 * notification and the audit row are the PATCH's. Lost asks one reason for
 * all. Whatever did not change stays ticked, with why.
 */
function LeadBulkActions({ ctx, people }: { ctx: BulkContext<LeadRow>; people: Person[] }) {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ number: string; why: string }[]>([]);

  const assigning = action.startsWith('assign:');
  const target = action.startsWith('status:') ? action.slice(7) : '';
  const assignee = assigning ? action.slice(7) : '';
  const assigneeName = people.find((p) => p.id === assignee)?.name ?? '';
  const needsReason = target === 'LOST';

  const plan = target
    ? planLeadMove(ctx.rows, target)
    : assigning
      ? {
          go: ctx.rows.filter((r) => r.canEdit && r.assignedTo.id !== assignee),
          stay: ctx.rows
            .filter((r) => !r.canEdit || r.assignedTo.id === assignee)
            .map((r) => ({ row: r, why: r.assignedTo.id === assignee ? `already ${assigneeName}'s` : 'assigned to someone else' })),
        }
      : null;

  async function apply() {
    if (!plan || !plan.go.length || (needsReason && !reason.trim())) return;
    const failed: { row: LeadRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let i = 0; i < plan.go.length; i++) {
      setProgress({ done: i, of: plan.go.length });
      const row = plan.go[i];
      const body = assigning
        ? { assignedToId: assignee }
        : needsReason
          ? { status: target, lostReason: reason.trim() }
          : { status: target };
      try {
        await api.patch(`/leads/${row.id}`, body);
        done++;
      } catch (err) {
        failed.push({ row, why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    const left = [...plan.stay, ...failed];
    const what = assigning ? `assigned to ${assigneeName}` : `moved to ${leadStatusLabel(target).toLowerCase()}`;
    toast(done > 0 ? 'ok' : 'error', `${done} lead${done === 1 ? '' : 's'} ${what}${left.length ? `; ${left.length} unchanged` : ''}`);
    setRefused(left.map((l) => ({ number: l.row.number, why: l.why })));
    setAction('');
    setReason('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  const verb = assigning ? `Assign ${plan?.go.length ?? 0} to ${assigneeName}` : `Move ${plan?.go.length ?? 0} to ${leadStatusLabel(target)}`;

  return (
    <>
      <select
        aria-label="Change status of, or assign, the selected leads"
        value={action}
        disabled={!!progress}
        onChange={(e) => {
          setAction(e.target.value);
          setRefused([]);
        }}
      >
        <option value="">Change status or assign…</option>
        <optgroup label="Change status">
          {BULK_LEAD_TARGETS.map((t) => (
            <option key={t} value={`status:${t}`}>
              {leadStatusLabel(t)}
              {t === 'LOST' ? '…' : ''}
            </option>
          ))}
        </optgroup>
        <optgroup label="Assign to">
          {people
            .filter((p) => p.isSales)
            .map((p) => (
              <option key={p.id} value={`assign:${p.id}`}>
                {p.name}
              </option>
            ))}
        </optgroup>
      </select>
      {needsReason && (
        <input
          type="text"
          className="list-bulk-reason"
          aria-label="Why were they lost? One reason for all of them"
          placeholder="Why were they lost? (one reason for all)"
          value={reason}
          disabled={!!progress}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {plan && (
        <button
          type="button"
          className={`btn btn-sm ${needsReason ? 'btn-danger' : 'btn-primary'}`}
          disabled={!plan.go.length || !!progress || (needsReason && !reason.trim())}
          onClick={() => void apply()}
        >
          {progress ? `Working ${progress.done + 1} of ${progress.of}…` : plan.go.length ? verb : 'None can change'}
        </button>
      )}
      {plan && plan.stay.length > 0 && !progress && (
        <p className="list-bulk-result">
          {plan.stay.length} will stay as they are:{' '}
          {plan.stay
            .slice(0, 6)
            .map((st) => `${st.row.number} (${st.why})`)
            .join(', ')}
          {plan.stay.length > 6 ? `, and ${plan.stay.length - 6} more` : ''}.
        </p>
      )}
      {!plan && refused.length > 0 && (
        <div className="list-bulk-result" role="status">
          Still selected — these did not change:
          <ul>
            {refused.map((r) => (
              <li key={r.number}>
                <span className="mono">{r.number}</span>: {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function Leads() {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  /*
    `?new=1&customerId=` opens the form already linked to that customer —
    Customer 360's "New lead" lands here. The URL is the hand-off, the same
    way Quotations reads it, so there is no second create form anywhere.
  */
  const presetCustomerId = params.get('customerId') ?? undefined;
  const [creating, setCreating] = useState(() => !!params.get('new') && can('gops.leads.create'));

  function closeCreate() {
    setCreating(false);
    if (params.has('new')) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of ['new', 'customerId']) next.delete(k);
          return next;
        },
        { replace: true },
      );
    }
  }
  const [reload, setReload] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    loadPeople().then(setPeople).catch(() => {});
  }, []);

  const mayEdit = can('gops.leads.edit_own') || can('gops.leads.edit_all');

  const columns: Column<LeadRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '130px', render: (l) => <span className="mono">{l.number}</span> },
    {
      key: 'company',
      label: 'Company',
      sortKey: 'companyName',
      render: (l) => (
        <div>
          <div>{l.companyName}</div>
          <div className="faint">{l.contactPerson ?? 'No contact recorded'}</div>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (l) => (
        <div>
          <StatusBadge status={l.status} />
          {l.stageLabel && <div className="faint">{l.stageLabel}</div>}
        </div>
      ),
    },
    {
      key: 'estimatedValue',
      label: 'Est. value',
      sortKey: 'estimatedValue',
      align: 'right',
      render: (l) => (l.estimatedValue == null ? '—' : <span className="mono">{formatMoney(l.estimatedValue)}</span>),
    },
    { key: 'probability', label: 'Prob.', sortKey: 'probability', align: 'right', render: (l) => `${l.probability}%` },
    {
      key: 'weighted',
      label: 'Weighted',
      align: 'right',
      render: (l) =>
        l.estimatedValue == null ? (
          '—'
        ) : (
          <span className="mono faint">{formatMoney((l.estimatedValue * l.probability) / 100)}</span>
        ),
      optional: true,
    },
    { key: 'assignedTo', label: 'Owner', render: (l) => l.assignedTo.name },
    {
      key: 'createdBy',
      label: 'Added by',
      sortKey: 'createdAt',
      render: (l) => (
        <div>
          <div>{l.createdBy?.name ?? '—'}</div>
          <div className="faint">{formatDate(l.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'nextAction',
      label: 'Next action',
      render: (l) =>
        l.nextAction ? (
          <div>
            <div>{l.nextAction}</div>
            {l.nextActionDate && <div className="faint">{formatDate(l.nextActionDate)}</div>}
          </div>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'expectedClosing',
      label: 'Expected close',
      sortKey: 'expectedClosing',
      render: (l) => formatDate(l.expectedClosing),
    },
    { key: 'source', label: 'Source', render: (l) => l.source ?? '—', optional: true },
  ];

  const personOptions = people.map((p) => ({ value: p.id, label: p.name }));
  const leadFilters: FilterDef[] = [
    { key: 'stage', label: 'Stage', options: LEAD_STAGE_TABS },
    { key: 'status', label: 'Status', options: LEAD_STATUSES },
    { key: 'assignedToId', label: 'Owner', options: personOptions },
    { key: 'createdById', label: 'Added by', options: personOptions },
    // `clientId`: this page's ?customerId= is the "new lead for this
    // customer" hand-off, and the list must never read it as a filter.
    ...(can('gops.customers.view_all')
      ? [
          {
            key: 'clientId',
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
    { key: 'createdFrom', toKey: 'createdTo', label: 'Added', type: 'dateRange' },
    { key: 'closingFrom', toKey: 'closingTo', label: 'Expected closing', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
        </div>
      </div>

      <DataList<LeadRow>
        listKey="leads"
        endpoint="/leads"
        columns={columns}
        rowKey={(l) => l.id}
        scoped
        searchPlaceholder="Search number, company, contact, customer…"
        reloadToken={reload}
        onRowClick={(l) => navigate(`/g-ops/leads/${l.id}`)}
        emptyTitle="No leads yet"
        emptyHint="Record an enquiry the moment it arrives — even a phone call worth following up."
        defaultScope={mayEdit ? 'mine' : 'all'}
        filters={leadFilters}
        // The paper matches the screen: DataList sends the list's own query.
        printPath="/api/leads/pdf"
        selectable
        rowLabel={(l) => `${l.number} ${l.companyName}`}
        bulkActions={(ctx) => <LeadBulkActions ctx={ctx} people={people} />}
        teamScope={!!me?.user.team && can('gops.leads.view_all')}
        summary={(raw, total) => {
          const sum = raw as LeadSummary;
          return (
            <>
              <Stat label="Leads" value={total} sub={noTeamNote(sum.teams)} />
              <Stat label="Estimated value" value={formatMoney(sum.value ?? 0)} figure />
              <Stat label="Weighted" value={formatMoney(sum.weighted ?? 0)} figure />
              {teamCards(sum.teams, formatMoney, 'lead')}
            </>
          );
        }}
        actions={
          <>
            {can('gops.leads.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + New lead
              </button>
            )}
          </>
        }
      />

      {creating && (
        <LeadForm
          people={people}
          presetCustomerId={params.has('new') ? presetCustomerId : undefined}
          onClose={closeCreate}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/leads/${id}`, { replace: params.has('new') });
          }}
        />
      )}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can, me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  // Another record opened in this same page (a bell, Ctrl+K) withdraws a question about the last one.
  const closeConfirm = confirm.close;
  useEffect(() => closeConfirm(), [id, closeConfirm]);

  const [lead, setLead] = useState<LeadDetailRow | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setLead(await api.get(`/leads/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    loadPeople().then(setPeople).catch(() => {});
  }, [load]);

  if (loading) return <Loading />;
  if (!lead) return <ErrorBox error={error ?? new Error('Lead not found')} />;

  async function setStatus(status: string) {
    if (!lead) return;
    try {
      await api.patch(`/leads/${lead.id}`, { status });
      toast('ok', `Moved to ${LEAD_STATUSES.find((s) => s.value === status)?.label}`);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  /**
   * Throws on refusal so the confirm bar keeps the reason and shows why. A few
   * plain words at least: Sales Analytics groups the reasons, and "no" teaches
   * nobody anything.
   */
  async function markLost(reason: string) {
    if (!lead) return;
    if (reason.length < 3) throw new Error('Say why in a few words — Sales Analytics reports the reasons.');
    await api.patch(`/leads/${lead.id}`, { status: 'LOST', lostReason: reason });
    toast('ok', `${lead.companyName} marked lost`);
    await load();
  }

  const hasQuotation = lead.quotations.length > 0;
  const closed = lead.status === 'WON' || lead.status === 'LOST';
  const latestCosting = lead.costings[0] ?? null;
  /*
    The two hand-offs out of a lead. Each carries the lead in the URL, and the
    screen it opens prefills from it: the customer, the site, the subject and
    the costing already priced, so nothing is typed twice (model 4.1).
    A quotation needs a customer on file; a costing does not, because a
    costing is often the first thing done for a company nobody has filed yet.
  */
  const quotationBlocked = !lead.customer
    ? 'Link the lead to a customer first: Modify, and pick or add the company'
    : null;

  /** Throws on refusal, so the confirm bar shows why and stays open. */
  async function remove() {
    if (!lead) return;
    await api.del(`/leads/${lead.id}`);
    toast('ok', 'Lead deleted');
    navigate('/g-ops/leads');
  }

  const won = lead.status === 'WON';
  const lost = lead.status === 'LOST';
  const held = lead.status === 'ON_HOLD';

  return (
    <div>
      <RecordHeader
        type="Lead"
        code={lead.number}
        title={lead.companyName}
        status={lead.status}
        amount={lead.estimatedValue == null ? undefined : formatMoney(lead.estimatedValue)}
        amountLabel="Estimated value"
        meta={
          <>
            {lead.contactPerson ? `${lead.contactPerson} · ` : ''}
            owned by {lead.assignedTo.name}
            {lead.source ? ` · via ${lead.source}` : ''}
            {lead.customer && (
              <>
                {' · '}
                <Link to={`/g-ops/customers/${lead.customer.id}`}>{lead.customer.name}</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {!closed && lead.canEdit && (
              <button
                type="button"
                className="btn"
                aria-expanded={assigning}
                aria-controls="assign-costing"
                onClick={() => setAssigning((v) => !v)}
              >
                Assign costing
              </button>
            )}
            {!closed &&
              can('gops.quotations.create') &&
              (quotationBlocked ? (
                <button type="button" className="btn" disabled title={quotationBlocked}>
                  Create quotation
                </button>
              ) : (
                <Link
                  className="btn btn-primary"
                  to={`/g-ops/quotations/new${qs({ leadId: lead.id, costingId: latestCosting?.id })}`}
                >
                  Create quotation
                </Link>
              ))}
          </>
        }
        print={`/api/leads/${lead.id}/pdf`}
        more={[
          lead.canEdit &&
            !won &&
            !held &&
            !lost && {
              label: 'Put on hold',
              hint: 'Paused — nothing moves until somebody picks it up',
              onSelect: () => void setStatus('ON_HOLD'),
            },
          lead.canEdit &&
            !won &&
            !lost && {
              label: 'Mark lost',
              danger: true,
              confirm: {
                title: `Mark ${lead.companyName} lost?`,
                body: 'Price, timing, went to a competitor, project shelved… Sales Analytics groups these, so a few plain words beat a paragraph.',
                confirmLabel: 'Mark lost',
                reason: 'required',
                reasonLabel: 'Why was it lost?',
                // A few plain words: markLost refuses fewer than three, as the old modal did.
                minReason: 3,
                // A lead lost before and picked up again offers the reason it was lost with.
                initialReason: lead.lostReason ?? '',
                onConfirm: (reason) => markLost(reason),
              },
            },
          lead.canEdit &&
            can('gops.leads.delete') && {
              label: 'Delete',
              danger: true,
              confirm: {
                title: `Delete ${lead.number}?`,
                body: 'It cannot be undone. A lead a quotation came from cannot be deleted.',
                confirmLabel: 'Delete',
                onConfirm: remove,
              },
            },
        ]}
        modify={lead.canEdit ? () => setEditing(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />
      {!closed && quotationBlocked && can('gops.quotations.create') && (
        <div className="alert info">A quotation is raised for a customer on file. {quotationBlocked}.</div>
      )}

      {assigning && !closed && lead.canEdit && (
        <AssignCostingPanel
          leadId={lead.id}
          onCancel={() => setAssigning(false)}
          onAssigned={async (made) => {
            setAssigning(false);
            if (made.ownerId === me?.user.id) {
              navigate(`/g-ops/costing/${made.id}/edit`);
              return;
            }
            toast('ok', `Costing ${made.number} assigned`);
            await load();
          }}
        />
      )}

      <LeadProgress
        status={lead.status}
        lostReason={lead.lostReason}
        canEdit={lead.canEdit}
        hasQuotation={hasQuotation}
        onMove={setStatus}
      />

      {/*
        Cut to the five things that decide whether this lead gets worked:
        who it is, what they asked for, who to ring, whose job it is, and what
        they sent. The commercial figures stay below because Insights reads
        them for the weighted pipeline — they are just no longer the first
        thing on the screen.
      */}
      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Customer</h3>
          <Row label="Company" value={lead.companyName} />
          <Row
            label="Customer record"
            value={
              lead.customer ? (
                <Link to={`/g-ops/customers/${lead.customer.id}`}>{lead.customer.name}</Link>
              ) : (
                <span className="faint">Not linked yet — free text until they become a customer</span>
              )
            }
          />
          <Row label="Enquiry came via" value={lead.source} />
          <Row
            label="Added by"
            value={`${lead.createdBy?.name ?? 'Unknown'}, ${formatDateTime(lead.createdAt)}`}
          />
        </div>

        <div className="card">
          <h3 className="card-title">Contact</h3>
          <Row label="Person" value={lead.contactPerson} />
          <Row
            label="Email"
            value={lead.contactEmail ? <a href={`mailto:${lead.contactEmail}`}>{lead.contactEmail}</a> : null}
          />
          <Row
            label="Phone"
            value={lead.contactPhone ? <a href={`tel:${lead.contactPhone}`}>{lead.contactPhone}</a> : null}
          />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3 className="card-title">Product inquiry</h3>
          {lead.description ? (
            <div style={{ whiteSpace: 'pre-wrap' }}>{lead.description}</div>
          ) : (
            <p className="faint">
              Nothing recorded. What did they actually ask for? This is what the quotation gets
              priced against.
            </p>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">Assigned sales</h3>
          <Row label="Owner" value={lead.assignedTo.name} />
          <Row label="Next action" value={lead.nextAction} />
          <Row label="Due" value={formatDate(lead.nextActionDate)} />
          {lead.status === 'LOST' && <Row label="Lost because" value={lead.lostReason} />}
        </div>

        <div className="card">
          <h3 className="card-title">Commercial</h3>
          <Row label="Estimated value" value={lead.estimatedValue == null ? null : formatMoney(lead.estimatedValue)} />
          <Row label="Probability" value={`${lead.probability}%`} />
          <Row
            label="Weighted"
            value={lead.estimatedValue == null ? null : formatMoney((lead.estimatedValue * lead.probability) / 100)}
          />
          <Row label="Expected close" value={formatDate(lead.expectedClosing)} />
        </div>

        {/*
          What has been priced and quoted for this enquiry. The API always
          returned the quotations and nothing drew them; a lead page that
          cannot say which quotation it became is a dead end.
        */}
        <div className="card">
          <h3 className="card-title">
            Costings
            {lead.costings.length > 0 && <span className="badge">{lead.costings.length}</span>}
          </h3>
          {lead.costings.length === 0 ? (
            <p className="faint">Nothing priced yet. Assign a costing to whoever will work out what this will take.</p>
          ) : (
            <ul className="sales-linked">
              {lead.costings.map((c) => (
                <li key={c.id}>
                  <Link to={`/g-ops/costing/${c.id}`} className="mono">
                    {c.number}
                  </Link>
                  <span className="sales-linked-title">{c.title}</span>
                  <span className="mono">{formatMoney(c.contractValue)}</span>
                  <StatusBadge status={c.status} extra={{ FINAL: 'ok' }} />
                  <span className="sales-linked-meta faint">
                    {c.assignedBy
                      ? `Assigned to ${c.owner.name} by ${c.assignedBy.name}, ${formatDateTime(c.assignedAt)}`
                      : `Prepared by ${c.owner.name}, ${formatDateTime(c.createdAt)}`}
                    {c.assignmentNote ? ` — ${c.assignmentNote}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h3 className="card-title">
            Quotations
            {lead.quotations.length > 0 && <span className="badge">{lead.quotations.length}</span>}
          </h3>
          {lead.quotations.length === 0 ? (
            <p className="faint">
              None yet. Once a quotation exists it is what moves on the pipeline, and this lead follows
              it.
            </p>
          ) : (
            <ul className="sales-linked">
              {lead.quotations.map((q) => (
                <li key={q.id}>
                  <Link to={`/g-ops/quotations/${q.id}`} className="mono">
                    {q.number}
                  </Link>
                  <span className="sales-linked-title">
                    {q.subject}
                    {q.latest && (
                      <span className="faint">
                        {' '}
                        · R{q.latest.revision} {q.latest.status.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    )}
                  </span>
                  <span className="mono">{q.latest ? formatMoney(q.latest.total) : '—'}</span>
                  <StatusBadge status={q.outcome} extra={QUOTATION_OUTCOME_TONES} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/*
          What the customer actually sent. The scope of work is the document
          every later argument refers back to — the quotation is priced from
          it, the job is delivered against it — so it belongs on the lead
          rather than in whoever's mailbox received it.
        */}
        <div style={{ gridColumn: '1 / -1' }}>
          <Attachments
            entityType="lead"
            entityId={lead.id}
            title="Documents"
            hint="Scope of work, drawings, specifications — whatever they sent. These stay with the lead and carry through to the quotation raised from it."
            canEdit={lead.canEdit}
          />
        </div>

        {/*
          The activity log, which is the point of the screen: a status says
          where a lead got to and never says who rang on Tuesday or what they
          were told. Built on SalesActivity, which already pointed at a lead.
        */}
        <div style={{ gridColumn: '1 / -1' }}>
          <ActivityLog leadId={lead.id} canEdit={lead.canEdit} />
        </div>
      </div>

      {editing && (
        <LeadForm
          lead={lead}
          people={people}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

interface LeadDetailRow extends LeadRow {
  canEdit: boolean;
  site: { id: string; name: string } | null;
  quotations: {
    id: string;
    number: string;
    subject: string;
    outcome: string;
    latest: { revision: number; status: string; total: number } | null;
  }[];
  costings: {
    id: string;
    number: string;
    title: string;
    status: string;
    contractValue: number;
    createdAt: string;
    owner: { id: string; name: string };
    assignedBy: { id: string; name: string } | null;
    assignedAt: string | null;
    assignmentNote: string | null;
  }[];
}

interface Assignable {
  id: string;
  name: string;
  position: string | null;
}

/**
 * "Assign costing", in the page — no dialog. The people offered are those who
 * may make a costing (`/users/lookup?holding=gops.costing.create`); the costing
 * is created in the chosen person's name, and they are told.
 */
function AssignCostingPanel({
  leadId,
  onCancel,
  onAssigned,
}: {
  leadId: string;
  onCancel: () => void;
  onAssigned: (made: { id: string; number: string; ownerId: string }) => void | Promise<void>;
}) {
  const { me } = useAuth();
  const [people, setPeople] = useState<Assignable[] | null>(null);
  const [assigneeId, setAssigneeId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<Assignable[]>(`/users/lookup${qs({ holding: 'gops.costing.create' })}`)
      .then((rows) => {
        setPeople(rows);
        // Yourself first when you can cost; otherwise nobody is picked for you.
        if (rows.some((p) => p.id === me?.user.id)) setAssigneeId(me!.user.id);
      })
      .catch(setError);
  }, [me]);

  async function assign() {
    if (!assigneeId) return;
    setBusy(true);
    try {
      const made = await api.post<{ id: string; number: string; ownerId: string }>('/costings/assign', {
        leadId,
        assigneeId,
        note: note.trim() || null,
      });
      await onAssigned(made);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="assign-costing" className="card sales-card-gap" aria-labelledby="assign-costing-title">
      <h3 id="assign-costing-title" className="card-title">
        Assign costing
      </h3>
      <p className="faint">
        A draft costing is made in their name from this lead — its customer, site and enquiry — and they are
        notified. Pick yourself to start it now.
      </p>
      <ErrorBox error={error} />
      {people === null ? (
        <Loading />
      ) : people.length === 0 ? (
        <p className="faint">Nobody can make costings yet. An administrator gives that right in Roles.</p>
      ) : (
        <div className="grid grid-2">
          <Field label="Who will cost it" required>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === me?.user.id ? `${p.name} (me)` : p.name}
                  {p.position ? ` — ${p.position}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" hint="What to price, what the customer said, when you need it">
            <textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      )}
      {/* [Cancel] [Assign], right — the order every form's foot keeps. */}
      <div className="panel-foot">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!assigneeId || busy} onClick={assign}>
          {busy ? 'Assigning…' : assigneeId && assigneeId === me?.user.id ? 'Start costing' : 'Assign'}
        </button>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sales-row">
      <span className="sales-row-label">{label}</span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

/** Exported so the pipeline board's "+ New" menu opens this same form. */
export function LeadForm({
  lead,
  people,
  presetCustomerId,
  onClose,
  onSaved,
}: {
  lead?: LeadRow;
  people: Person[];
  /** A new lead for a customer already on file (`?new=1&customerId=`). */
  presetCustomerId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /*
    Sales first in the picker. `people` is every user, and a lead is nearly
    always going to one of a handful of them — scrolling past the warehouse
    and the engineers to find them is the kind of small friction that ends
    with every lead assigned to whoever is at the top.
  */
  const sales = people.filter((p) => p.isSales);
  const others = people.filter((p) => !p.isSales);

  const [matches, setMatches] = useState<{ id: string; name: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [form, setForm] = useState({
    companyName: lead?.companyName ?? '',
    customerId: lead?.customer?.id ?? '',
    address: lead?.address ?? '',
    contactPerson: lead?.contactPerson ?? '',
    contactEmail: lead?.contactEmail ?? '',
    contactPhone: lead?.contactPhone ?? '',
    source: lead?.source ?? '',
    description: lead?.description ?? '',
    assignedToId: lead?.assignedTo.id ?? me?.user.id ?? '',
    estimatedValue: lead?.estimatedValue?.toString() ?? '',
    probability: lead?.probability?.toString() ?? '25',
    expectedClosing: lead?.expectedClosing?.slice(0, 10) ?? '',
    nextAction: lead?.nextAction ?? '',
    nextActionDate: lead?.nextActionDate?.slice(0, 10) ?? '',
    notes: lead?.notes ?? '',
    lostReason: lead?.lostReason ?? '',
  });

  /*
    Search as you type rather than a select of every customer.

    `/customers/lookup?q=` already searched on name and code and nothing used
    the q — the form pulled the whole list and made you scroll it. Debounced,
    because a keystroke is not a question worth asking the server.
  */
  useEffect(() => {
    const term = form.companyName.trim();
    if (!picking || term.length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ id: string; name: string }[]>(`/customers/lookup${qs({ q: term })}`)
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 180);
    return () => clearTimeout(t);
  }, [form.companyName, picking]);

  /**
   * Taking a customer's details across onto the lead.
   *
   * The primary contact and the first site, because that is what "the company
   * is already on file" is worth — and every one of them stays editable: the
   * person who sent this enquiry is often not the person on the customer
   * record, and the site is often not the one the work is for.
   */
  async function adoptCustomer(c: { id: string; name?: string }) {
    setForm((f) => ({ ...f, customerId: c.id, companyName: c.name ?? f.companyName }));
    setPicking(false);
    setMatches([]);
    try {
      const full = await api.get<{
        name: string;
        contacts: { name: string; email: string | null; phone: string | null; mobile: string | null }[];
        sites: { address: string | null; city: string | null }[];
      }>(`/customers/${c.id}`);
      if (!c.name) setForm((f) => ({ ...f, companyName: f.companyName || full.name }));
      const contact = full.contacts[0];
      const site = full.sites[0];
      setForm((f) => ({
        ...f,
        // Only fill what is empty — never overwrite something already typed.
        contactPerson: f.contactPerson || contact?.name || '',
        contactEmail: f.contactEmail || contact?.email || '',
        contactPhone: f.contactPhone || contact?.phone || contact?.mobile || '',
        address: f.address || [site?.address, site?.city].filter(Boolean).join(', '),
      }));
    } catch {
      /* the lead is still valid without the customer's details */
    }
  }

  // Arriving from Customer 360: link the customer before anything is typed.
  useEffect(() => {
    if (!lead && presetCustomerId) void adoptCustomer({ id: presetCustomerId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, presetCustomerId]);

  /**
   * No match: the enquiry is from somebody not on file yet. Filed by name
   * through the ordinary customer create; the sub-industry is typed in
   * later, on the customer (2026-10-08, the owner's call).
   */
  async function createCustomer() {
    const name = form.companyName.trim();
    if (name.length < 2) return;
    setBusy(true);
    try {
      const created = await api.post<{ id: string; name: string }>('/customers', { name });
      toast('ok', `${name} added as a customer`);
      setForm((f) => ({ ...f, customerId: created.id, companyName: created.name }));
      setPicking(false);
      setMatches([]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        companyName: form.companyName,
        customerId: form.customerId || null,
        contactPerson: form.contactPerson || null,
        contactEmail: form.contactEmail || null,
        contactPhone: form.contactPhone || null,
        address: form.address || null,
        source: form.source || null,
        description: form.description || null,
        assignedToId: form.assignedToId,
        estimatedValue: form.estimatedValue === '' ? null : Number(form.estimatedValue),
        probability: Number(form.probability),
        expectedClosing: form.expectedClosing || null,
        nextAction: form.nextAction || null,
        nextActionDate: form.nextActionDate || null,
        notes: form.notes || null,
        lostReason: form.lostReason || null,
      };
      const saved = lead
        ? await api.patch<{ id: string }>(`/leads/${lead.id}`, payload)
        : await api.post<{ id: string }>('/leads', payload);
      toast('ok', `${form.companyName} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={lead ? `Modify lead ${lead.number}` : 'New lead'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.companyName.length < 2}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      {/*
        The customer comes first and carries the rest with it. Typing searches
        the customer list; picking one fills in the contact, the numbers and
        the site address. Nothing on file yet is the normal case for a lead,
        so adding one is a button rather than a trip to another screen.
      */}
      <Field
        label="Customer"
        hint={
          form.customerId
            ? 'On file — contact and address came from the customer record, and can be changed here'
            : 'Type to search. Capitals only, so the same company is not filed three ways.'
        }
      >
        <div className="lookup">
          <input
            value={form.companyName}
            autoFocus
            autoComplete="off"
            placeholder="Start typing a company name…"
            onFocus={() => setPicking(true)}
            onChange={(e) =>
              // Capitals as they type: the same company arrives as "Amherst",
              // "AMHERST" and "amherst" otherwise, and searches find one third
              // of its own history.
              setForm({ ...form, companyName: e.target.value.toUpperCase(), customerId: '' })
            }
          />
          {form.customerId && <span className="lookup-tick" title="Linked to a customer record">linked</span>}

          {picking && form.companyName.trim().length >= 2 && (
            <ul className="lookup-menu">
              {matches.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => adoptCustomer(c)}>
                    {c.name}
                  </button>
                </li>
              ))}
              {!matches.some((m) => m.name === form.companyName.trim()) && (
                <li className="lookup-new">
                  <div className="lookup-new-row">
                    <button type="button" onClick={createCustomer} disabled={busy}>
                      {matches.length ? 'Not one of these — ' : ''}add “{form.companyName.trim()}” as a
                      new customer
                    </button>
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>
      </Field>

      <Field label="Address" hint="Where the work is. Filled from the customer's site when there is one.">
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>

      <div className="grid grid-2">
        <Field label="Contact person" hint="Whoever actually sent this enquiry">
          <input
            value={form.contactPerson}
            onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
          />
        </Field>
        <Field label="Assigned to" hint="They are notified when you hand it over">
          <select
            value={form.assignedToId}
            onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
          >
            {/* Sales first — it is a sales record, and the list is everyone. */}
            {sales.length > 0 && (
              <optgroup label="Sales">
                {sales.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={sales.length ? 'Everyone else' : 'Everyone'}>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.contactEmail}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
        </Field>
      </div>

      <Field label="Product inquiry" hint="What they actually asked for — this is what gets priced">
        <textarea
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>

      <Field label="Expected closing">
        <input
          type="date"
          value={form.expectedClosing}
          onChange={(e) => setForm({ ...form, expectedClosing: e.target.value })}
        />
      </Field>

      {/*
        The commercial read, on an existing lead only. A brand-new enquiry has
        no number on it worth recording, and these two drive the weighted
        pipeline in Insights — so they stay reachable rather than being
        dropped with the rest of the old form.
      */}
      {lead && (
        <div className="grid grid-2">
          <Field label="Estimated value">
            <NumberInput
              kind="money"
              value={form.estimatedValue}
              onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })}
            />
          </Field>
          <Field label="Probability %" hint="Drives the weighted pipeline">
            <NumberInput
              kind="percent"
              min={0}
              max={100}
              value={form.probability}
              onChange={(e) => setForm({ ...form, probability: e.target.value })}
            />
          </Field>
          <Field label="Source" hint="Referral, walk-in, exhibition…">
            <input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          </Field>
          <Field label="Next action">
            <input value={form.nextAction} onChange={(e) => setForm({ ...form, nextAction: e.target.value })} />
          </Field>
        </div>
      )}

      {lead?.status === 'LOST' && (
        <Field label="Lost because">
          <input value={form.lostReason} onChange={(e) => setForm({ ...form, lostReason: e.target.value })} />
        </Field>
      )}
    </Modal>
  );
}

