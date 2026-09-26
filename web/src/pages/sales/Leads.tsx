import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Attachments } from '../../components/Attachments';
import { ActivityLog } from '../../components/ActivityLog';
import {
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';

/** Somebody a lead can be handed to, and whether selling is their job. */
interface Person {
  id: string;
  name: string;
  isSales: boolean;
}

/**
 * The roles that mean "this person sells".
 *
 * Read off the user's roles rather than guessed from a department, because
 * the roles are what the permission registry already uses to decide who may
 * touch a lead at all.
 */
const SALES_ROLES = ['sales', 'sales_manager'];

async function loadPeople(): Promise<Person[]> {
  const res = await api.get<{ rows: { id: string; name: string; roles?: { key: string }[] }[] }>(
    '/users?pageSize=200',
  );
  return res.rows.map((u) => ({
    id: u.id,
    name: u.name,
    isSales: (u.roles ?? []).some((r) => SALES_ROLES.includes(r.key)),
  }));
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

import { statusTone } from '../../components/ui';

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

function LeadProgress({
  status,
  lostReason,
  canEdit,
  onMove,
}: {
  status: string;
  lostReason: string | null;
  canEdit: boolean;
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

        {canEdit && !won && (
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            {!held && !lost && (
              <button className="btn btn-sm" onClick={() => onMove('ON_HOLD')}>
                Put on hold
              </button>
            )}
            {!lost && (
              <button className="btn btn-sm btn-danger-ghost" onClick={() => onMove('LOST')}>
                Mark lost
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`lead-track ${tone}`} role="img" aria-label={progressLabel(status, index)}>
        <div className="lead-fill" style={{ width: `${pct}%` }} />
      </div>

      <ol className="lead-stages">
        {PIPELINE.map((stage, i) => {
          const done = !off && i < index;
          const here = stage.value === status;
          const cls = `lead-stage${done ? ' done' : ''}${here ? ' here' : ''}${off ? ' dimmed' : ''}`;
          return (
            <li key={stage.value} className={cls}>
              {canEdit && !here ? (
                <button onClick={() => onMove(stage.value)} title={`Move to ${stage.label}`}>
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



export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${statusTone(status)}`}>
      {LEAD_STATUSES.find((s) => s.value === status)?.label ?? status}
    </span>
  );
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
  customer: { id: string; name: string } | null;
  quotationCount?: number;
  createdAt: string;
}

export function Leads() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);

  useEffect(() => {
    loadPeople().then(setPeople).catch(() => {});
  }, []);

  const columns: Column<LeadRow>[] = [
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
    { key: 'status', label: 'Status', render: (l) => <StatusBadge status={l.status} /> },
    {
      key: 'estimatedValue',
      label: 'Est. value',
      sortKey: 'estimatedValue',
      align: 'right',
      render: (l) => (l.estimatedValue == null ? '—' : <span className="mono">{formatMoney(l.estimatedValue)}</span>),
    },
    { key: 'probability', label: 'Prob.', align: 'right', render: (l) => `${l.probability}%` },
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
      optional: true,
    },
    { key: 'source', label: 'Source', render: (l) => l.source ?? '—', optional: true },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p>
            Work in progress before it is a quotation. Assign a lead to whoever is chasing it — they
            get notified, and it shows up in their pipeline.
          </p>
        </div>
      </div>

      <DataList<LeadRow>
        listKey="leads"
        endpoint="/leads"
        columns={columns}
        rowKey={(l) => l.id}
        scoped
        searchPlaceholder="Search company or contact…"
        reloadToken={reload}
        onRowClick={(l) => navigate(`/g-ops/leads/${l.id}`)}
        emptyTitle="No leads yet"
        emptyHint="Record an enquiry the moment it arrives — even a phone call worth following up."
        filters={[
          { key: 'status', label: 'Status', options: LEAD_STATUSES },
          { key: 'assignedToId', label: 'Owner', options: people.map((p) => ({ value: p.id, label: p.name })) },
        ]}
        actions={
          can('gops.leads.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + Add lead
            </button>
          ) : null
        }
      />

      {creating && (
        <LeadForm
          people={people}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/leads/${id}`);
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
  const { can } = useAuth();
  const toast = useToast();

  const [lead, setLead] = useState<(LeadRow & { canEdit: boolean; quotations: { id: string; number: string; subject: string; outcome: string; latest: { revision: number; status: string; total: number } | null }[] }) | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);

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

  async function remove() {
    if (!lead) return;
    try {
      await api.del(`/leads/${lead.id}`);
      toast('ok', 'Lead deleted');
      navigate('/g-ops/leads');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/leads">Leads</Link>
        <span className="sep">›</span>
        <span>{lead.companyName}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{lead.companyName}</h1>
          <p>
            <StatusBadge status={lead.status} />
            <span style={{ marginLeft: 10 }}>
              {lead.assignedTo.name}
              {lead.source ? ` · via ${lead.source}` : ''}
            </span>
          </p>
        </div>
        <div className="row">
          {lead.canEdit && (
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
          )}
          {lead.canEdit && can('gops.leads.delete') && (
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      <LeadProgress
        status={lead.status}
        lostReason={lead.lostReason}
        canEdit={lead.canEdit}
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
          <Row label="First recorded" value={formatDate(lead.createdAt)} />
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="faint" style={{ width: 150, flexShrink: 0, fontSize: 12 }}>
        {label}
      </span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
  );
}

// ── Form ─────────────────────────────────────────────────────────────────────

function LeadForm({
  lead,
  people,
  onClose,
  onSaved,
}: {
  lead?: LeadRow;
  people: Person[];
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
  async function adoptCustomer(c: { id: string; name: string }) {
    setForm((f) => ({ ...f, customerId: c.id, companyName: c.name }));
    setPicking(false);
    setMatches([]);
    try {
      const full = await api.get<{
        contacts: { name: string; email: string | null; phone: string | null; mobile: string | null }[];
        sites: { address: string | null; city: string | null }[];
      }>(`/customers/${c.id}`);
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

  /** No match: the enquiry is from somebody not on file yet. */
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
      title={lead ? `Modify ${lead.number}` : 'Add lead'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.companyName.length < 2}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
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
                  <button type="button" onClick={createCustomer} disabled={busy}>
                    {matches.length ? 'Not one of these — ' : ''}add “{form.companyName.trim()}” as a
                    new customer
                  </button>
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
            <input
              type="number"
              value={form.estimatedValue}
              onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })}
            />
          </Field>
          <Field label="Probability %" hint="Drives the weighted pipeline">
            <input
              type="number"
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

