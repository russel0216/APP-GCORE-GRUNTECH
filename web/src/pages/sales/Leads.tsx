import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';

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

function statusTone(status: string) {
  if (status === 'WON') return 'ok';
  if (status === 'LOST') return 'danger';
  if (status === 'ON_HOLD') return '';
  if (status.startsWith('QUOTATION') || status === 'NEGOTIATION') return 'info';
  return 'warn';
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
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
  }, []);

  const columns: Column<LeadRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (l) => <span className="mono">{l.number}</span> },
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
        searchPlaceholder="Search company, number, contact…"
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
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(false);

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
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
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
        <span className="mono">{lead.number}</span>
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
          {lead.canEdit && can('gops.quotations.create') && (
            <button className="btn btn-primary" onClick={() => setConverting(true)}>
              Create quotation
            </button>
          )}
          {lead.canEdit && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
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

      {lead.canEdit && !['WON', 'LOST'].includes(lead.status) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
            MOVE TO
          </div>
          <div className="row">
            {LEAD_STATUSES.filter((s) => s.value !== lead.status).map((s) => (
              <button key={s.value} className="btn btn-sm" onClick={() => setStatus(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Enquiry</h3>
          <Row label="Number" value={<span className="mono">{lead.number}</span>} />
          <Row label="Customer record" value={lead.customer ? <Link to={`/g-ops/customers/${lead.customer.id}`}>{lead.customer.name}</Link> : null} />
          <Row label="Contact" value={lead.contactPerson} />
          <Row label="Email" value={lead.contactEmail} />
          <Row label="Phone" value={lead.contactPhone} />
          <Row label="Source" value={lead.source} />
          <Row label="Raised" value={formatDate(lead.createdAt)} />
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
          <Row label="Next action" value={lead.nextAction} />
          <Row label="Next action date" value={formatDate(lead.nextActionDate)} />
          {lead.status === 'LOST' && <Row label="Lost because" value={lead.lostReason} />}
        </div>

        {lead.description && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 className="card-title">What they want</h3>
            <div style={{ whiteSpace: 'pre-wrap' }}>{lead.description}</div>
          </div>
        )}

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3 className="card-title">Quotations from this lead</h3>
          {lead.quotations.length === 0 ? (
            <Empty title="None yet" hint="Create one when the scope is clear enough to price." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Subject</th>
                    <th>Latest revision</th>
                    <th className="right">Total</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {lead.quotations.map((q) => (
                    <tr key={q.id} className="clickable" onClick={() => navigate(`/g-ops/quotations/${q.id}`)}>
                      <td className="mono">{q.number}</td>
                      <td>{q.subject}</td>
                      <td>
                        {q.latest ? (
                          <>
                            R{q.latest.revision} <span className="badge">{q.latest.status}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="right mono">{q.latest ? formatMoney(q.latest.total) : '—'}</td>
                      <td>
                        <span className="badge">{q.outcome}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

      {converting && (
        <ConvertModal
          lead={lead}
          onClose={() => setConverting(false)}
          onCreated={(quotationId) => navigate(`/g-ops/quotations/${quotationId}`)}
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
  people: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { me } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    companyName: lead?.companyName ?? '',
    customerId: lead?.customer?.id ?? '',
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

  useEffect(() => {
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
  }, []);

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
      title={lead ? `Edit ${lead.number}` : 'Add lead'}
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
      <div className="grid grid-2">
        <Field label="Company" hint="Free text — link it to a customer record when one exists">
          <input
            value={form.companyName}
            autoFocus
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
          />
        </Field>
        <Field label="Customer record">
          <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
            <option value="">— not linked —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Contact person">
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
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
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
        <Field label="Source" hint="Referral, walk-in, exhibition, existing customer…">
          <input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
        </Field>
        <Field label="Estimated value">
          <input
            type="number"
            value={form.estimatedValue}
            onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })}
          />
        </Field>
        <Field label="Probability %" hint="Your read on the chance of award — drives the weighted pipeline">
          <input
            type="number"
            min={0}
            max={100}
            value={form.probability}
            onChange={(e) => setForm({ ...form, probability: e.target.value })}
          />
        </Field>
        <Field label="Expected close">
          <input
            type="date"
            value={form.expectedClosing}
            onChange={(e) => setForm({ ...form, expectedClosing: e.target.value })}
          />
        </Field>
        <Field label="Next action">
          <input value={form.nextAction} onChange={(e) => setForm({ ...form, nextAction: e.target.value })} />
        </Field>
        <Field label="Next action date">
          <input
            type="date"
            value={form.nextActionDate}
            onChange={(e) => setForm({ ...form, nextActionDate: e.target.value })}
          />
        </Field>
      </div>

      <Field label="What they want">
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      {lead?.status === 'LOST' && (
        <Field label="Lost because">
          <input value={form.lostReason} onChange={(e) => setForm({ ...form, lostReason: e.target.value })} />
        </Field>
      )}
    </Modal>
  );
}

// ── Convert to quotation ─────────────────────────────────────────────────────

function ConvertModal({
  lead,
  onClose,
  onCreated,
}: {
  lead: LeadRow;
  onClose: () => void;
  onCreated: (quotationId: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [costings, setCostings] = useState<{ id: string; number: string; title: string }[]>([]);
  const [form, setForm] = useState({
    customerId: lead.customer?.id ?? '',
    subject: lead.description?.slice(0, 120) || `Supply and installation — ${lead.companyName}`,
    costingId: '',
    probability: lead.probability.toString(),
  });

  useEffect(() => {
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
    api.get<typeof costings>('/costings/lookup').then(setCostings).catch(() => {});
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/quotations', {
        customerId: form.customerId,
        leadId: lead.id,
        subject: form.subject,
        costingId: form.costingId || null,
        probability: Number(form.probability),
      });
      toast('ok', 'Quotation created — the lead moved to Quotation created');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create quotation from lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={busy || !form.customerId}>
            {busy ? 'Creating…' : 'Create quotation'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        The customer, contact and lead reference carry over. The lead moves to{' '}
        <strong>Quotation created</strong> and follows the quotation's outcome from there.
      </p>

      <Field
        label="Customer"
        hint={lead.customer ? undefined : 'This lead has no customer record yet — pick or create one first'}
      >
        <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
          <option value="">— choose —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      {!form.customerId && (
        <div className="alert info">
          A quotation needs a real customer record. If {lead.companyName} is not in the list, add
          them under Customers first.
        </div>
      )}

      <Field label="Subject">
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </Field>
      <Field label="Costing" hint="Link one now, or attach it later from the quotation">
        <select value={form.costingId} onChange={(e) => setForm({ ...form, costingId: e.target.value })}>
          <option value="">— none yet —</option>
          {costings.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} — {c.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Probability %">
        <input
          type="number"
          min={0}
          max={100}
          value={form.probability}
          onChange={(e) => setForm({ ...form, probability: e.target.value })}
        />
      </Field>
    </Modal>
  );
}
