import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';

const OUTCOMES = [
  { value: 'OPEN', label: 'Open' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'WON', label: 'Won' },
  { value: 'LOST', label: 'Lost' },
];

function outcomeTone(o: string) {
  return o === 'WON' ? 'ok' : o === 'LOST' ? 'danger' : o === 'OPEN' ? 'warn' : 'info';
}

function revisionTone(s: string) {
  return s === 'APPROVED' ? 'ok' : s === 'REJECTED' ? 'danger' : s === 'PENDING_APPROVAL' ? 'warn' : '';
}

interface QuotationRow {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  probability: number;
  customer: { id: string; name: string };
  owner: { id: string; name: string };
  createdAt: string;
  latest: { revision: number; status: string; total: number; updatedAt: string } | null;
}

export function Quotations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<QuotationRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (q) => <span className="mono">{q.number}</span> },
    {
      key: 'subject',
      label: 'Quotation',
      sortKey: 'subject',
      render: (q) => (
        <div>
          <div>{q.subject}</div>
          <div className="faint">{q.customer.name}</div>
        </div>
      ),
    },
    {
      key: 'revision',
      label: 'Revision',
      render: (q) =>
        q.latest ? (
          <span>
            R{q.latest.revision}{' '}
            <span className={`badge ${revisionTone(q.latest.status)}`}>
              {q.latest.status.toLowerCase().replace(/_/g, ' ')}
            </span>
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'total',
      label: 'Total',
      align: 'right',
      render: (q) => (q.latest ? <span className="mono">{formatMoney(q.latest.total)}</span> : '—'),
    },
    { key: 'probability', label: 'Prob.', align: 'right', render: (q) => `${q.probability}%` },
    { key: 'owner', label: 'Owner', render: (q) => q.owner.name },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (q) => formatDate(q.createdAt) },
    {
      key: 'outcome',
      label: 'Outcome',
      render: (q) => <span className={`badge ${outcomeTone(q.outcome)}`}>{q.outcome}</span>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <p>
            Revisions are preserved, never overwritten — R0 stays readable after R1 changes the
            price. Only the author can edit a quotation, and only one revision can be approved.
          </p>
        </div>
      </div>

      <DataList<QuotationRow>
        listKey="quotations"
        endpoint="/quotations"
        columns={columns}
        rowKey={(q) => q.id}
        scoped
        searchPlaceholder="Search number, subject, customer…"
        reloadToken={reload}
        onRowClick={(q) => navigate(`/g-ops/quotations/${q.id}`)}
        emptyTitle="No quotations yet"
        filters={[{ key: 'outcome', label: 'Outcome', options: OUTCOMES }]}
        actions={
          can('gops.quotations.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New quotation
            </button>
          ) : null
        }
      />

      {creating && (
        <NewQuotationModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/quotations/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

interface Item {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  sortOrder: number;
}

interface Revision {
  id: string;
  revision: number;
  status: string;
  validityDays: number;
  terms: string | null;
  notes: string | null;
  subtotal: number;
  vatAmount: number;
  total: number;
  vatRate: number;
  vatInclusive: boolean;
  approvedAt: string | null;
  createdAt: string;
  items: Item[];
  costing: { id: string; number: string; title: string; contractValue: number; totalCost: number } | null;
  approvedBy: { id: string; name: string } | null;
}

interface QuotationDetail {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  probability: number;
  lostReason: string | null;
  submittedAt: string | null;
  canEdit: boolean;
  customer: { id: string; name: string; code: string };
  contact: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  lead: { id: string; number: string; companyName: string } | null;
  owner: { id: string; name: string };
  revisions: Revision[];
}

export function QuotationDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [quotation, setQuotation] = useState<QuotationDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [itemModal, setItemModal] = useState<Item | 'new' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const q = await api.get<QuotationDetail>(`/quotations/${id}`);
      setQuotation(q);
      setSelected((prev) => prev ?? q.revisions[0]?.id ?? null);
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
  if (!quotation) return <ErrorBox error={error ?? new Error('Quotation not found')} />;

  const revision = quotation.revisions.find((r) => r.id === selected) ?? quotation.revisions[0];
  const editable = quotation.canEdit && revision?.status === 'DRAFT';

  async function act(fn: () => Promise<unknown>, message: string) {
    try {
      await fn();
      toast('ok', message);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  function printPdf() {
    if (!revision) return;
    fetch(`/api/quotations/${quotation!.id}/revisions/${revision.id}/pdf`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => r.blob())
      .then((b) => window.open(URL.createObjectURL(b), '_blank'))
      .catch(() => toast('error', 'Could not render the quotation'));
  }

  return (
    <div>
      <div className="breadcrumb">
        {quotation.lead && (
          <>
            <Link to={`/g-ops/leads/${quotation.lead.id}`}>{quotation.lead.number}</Link>
            <span className="sep">›</span>
          </>
        )}
        <Link to="/g-ops/quotations">Quotations</Link>
        <span className="sep">›</span>
        <span className="mono">
          {quotation.number}
          {revision ? ` R${revision.revision}` : ''}
        </span>
        {revision?.costing && (
          <>
            <span className="sep">›</span>
            <Link to={`/g-ops/costing/${revision.costing.id}`}>{revision.costing.number}</Link>
          </>
        )}
      </div>

      <div className="page-head">
        <div>
          <h1>{quotation.subject}</h1>
          <p>
            <Link to={`/g-ops/customers/${quotation.customer.id}`}>{quotation.customer.name}</Link>
            {quotation.site ? ` · ${quotation.site.name}` : ''} · {quotation.owner.name}
            <span className={`badge ${outcomeTone(quotation.outcome)}`} style={{ marginLeft: 8 }}>
              {quotation.outcome}
            </span>
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={printPdf} disabled={!revision}>
            Print
          </button>
          {quotation.canEdit && (
            <button className="btn" onClick={() => setSettingsOpen(true)}>
              Modify
            </button>
          )}
          {quotation.canEdit && revision?.status !== 'DRAFT' && (
            <button
              className="btn"
              onClick={() => act(() => api.post(`/quotations/${quotation.id}/revisions`), 'New revision raised')}
            >
              New revision
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {/* Every revision, newest first. Clicking one shows what was sent then. */}
      <div className="row" style={{ marginBottom: 16, gap: 7 }}>
        {quotation.revisions.map((r) => (
          <button
            key={r.id}
            className={`btn btn-sm${r.id === revision?.id ? ' btn-primary' : ''}`}
            onClick={() => setSelected(r.id)}
          >
            R{r.revision}
            <span className={`badge ${revisionTone(r.status)}`} style={{ marginLeft: 6 }}>
              {r.status.toLowerCase().replace(/_/g, ' ')}
            </span>
          </button>
        ))}
      </div>

      {revision && (
        <>
          {revision.status === 'PENDING_APPROVAL' && (
            <div className="alert info">
              Revision {revision.revision} is with the approver. It cannot be edited until they
              decide — raise a new revision if something must change.
            </div>
          )}
          {revision.status === 'APPROVED' && (
            <div className="alert ok">
              Approved{revision.approvedBy ? ` by ${revision.approvedBy.name}` : ''}
              {revision.approvedAt ? ` on ${formatDateTime(revision.approvedAt)}` : ''}. This is the
              revision a project will be created from.
            </div>
          )}
          {revision.status === 'SUPERSEDED' && (
            <div className="alert info">
              Superseded by a later revision. Kept because it is what the customer was sent.
            </div>
          )}

          <div className="grid grid-4" style={{ marginBottom: 18 }}>
            <Stat label="Subtotal" value={formatMoney(revision.subtotal)} />
            <Stat label={`VAT ${(revision.vatRate * 100).toFixed(0)}%`} value={formatMoney(revision.vatAmount)} />
            <Stat label="Total" value={formatMoney(revision.total)} accent />
            <Stat
              label="Margin"
              value={
                revision.costing ? (
                  <MarginFromCosting costing={revision.costing} />
                ) : (
                  <span className="faint" style={{ fontSize: 13 }}>
                    no costing linked
                  </span>
                )
              }
            />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 className="card-title" style={{ margin: 0 }}>
                Lines
              </h3>
              {editable && (
                <div className="row">
                  {revision.costing && (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        act(
                          () =>
                            api.post(
                              `/quotations/${quotation.id}/revisions/${revision.id}/from-costing`,
                            ),
                          'Filled from the costing scope of work',
                        )
                      }
                    >
                      Fill from costing
                    </button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={() => setItemModal('new')}>
                    + Add line
                  </button>
                </div>
              )}
            </div>

            {revision.items.length === 0 ? (
              <Empty
                title="No lines yet"
                hint={
                  revision.costing
                    ? 'Use “Fill from costing” to bring in the scope sections you already priced.'
                    : 'Link a costing under Edit, then fill the lines from its scope of work.'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>Description</th>
                      <th className="right">Qty</th>
                      <th>Unit</th>
                      <th className="right">Unit price</th>
                      <th className="right">Amount</th>
                      {editable && <th style={{ width: 60 }} />}
                    </tr>
                  </thead>
                  <tbody>
                    {revision.items.map((item, i) => (
                      <tr key={item.id}>
                        <td className="mono">{i + 1}</td>
                        <td>{item.description}</td>
                        <td className="right mono">{item.quantity}</td>
                        <td>{item.unit}</td>
                        <td className="right mono">{formatMoney(item.unitPrice)}</td>
                        <td className="right mono">{formatMoney(item.amount)}</td>
                        {editable && (
                          <td>
                            <button className="btn btn-sm" onClick={() => setItemModal(item)}>
                              Modify
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {editable && revision.items.length > 0 && (
              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="btn btn-ok"
                  onClick={() =>
                    act(
                      () =>
                        api.post(`/quotations/${quotation.id}/revisions/${revision.id}/submit`),
                      'Submitted for approval',
                    )
                  }
                >
                  Submit for approval
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-2">
            <div className="card">
              <h3 className="card-title">Commercial</h3>
              <Row label="Customer" value={quotation.customer.name} />
              <Row label="Attention" value={quotation.contact?.name} />
              <Row label="Site" value={quotation.site?.name} />
              <Row label="Valid for" value={`${revision.validityDays} days`} />
              <Row label="VAT" value={revision.vatInclusive ? 'Inclusive of VAT' : 'Exclusive — added on'} />
              <Row label="Raised" value={formatDate(revision.createdAt)} />
            </div>

            <div className="card">
              <h3 className="card-title">Outcome</h3>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                Recording the outcome here also moves the lead, so the pipeline stays honest without
                keeping two statuses in step.
              </p>
              {quotation.canEdit && (
                <div className="row">
                  {OUTCOMES.filter((o) => o.value !== quotation.outcome).map((o) => (
                    <button
                      key={o.value}
                      className="btn btn-sm"
                      onClick={() =>
                        act(
                          () => api.patch(`/quotations/${quotation.id}`, { outcome: o.value }),
                          `Marked ${o.label.toLowerCase()}`,
                        )
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              {quotation.outcome === 'WON' && (
                <div className="alert ok" style={{ marginTop: 12, marginBottom: 0 }}>
                  Won. Converting this into a project ships in Phase 4 — the approved revision's
                  costing carries the budget and the schedule of values across.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {itemModal && revision && (
        <ItemModal
          quotationId={quotation.id}
          revisionId={revision.id}
          item={itemModal === 'new' ? null : itemModal}
          onClose={() => setItemModal(null)}
          onSaved={() => {
            setItemModal(null);
            void load();
          }}
        />
      )}

      {settingsOpen && revision && (
        <QuotationSettings
          quotation={quotation}
          revision={revision}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function MarginFromCosting({ costing }: { costing: { contractValue: number; totalCost: number } }) {
  const profit = costing.contractValue - costing.totalCost;
  const pct = costing.contractValue > 0 ? profit / costing.contractValue : 0;
  const tone = pct < 0 ? 'danger' : pct < 0.1 ? 'warn' : 'ok';
  return <span className={`badge ${tone}`}>{(pct * 100).toFixed(1)}%</span>;
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card">
      <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600, color: accent ? 'var(--neon)' : 'var(--text)' }}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="faint" style={{ width: 130, flexShrink: 0, fontSize: 12 }}>
        {label}
      </span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function NewQuotationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [costings, setCostings] = useState<{ id: string; number: string; title: string }[]>([]);
  const [leads, setLeads] = useState<{ id: string; companyName: string; status: string }[]>([]);
  const [form, setForm] = useState({
    customerId: '', contactId: '', siteId: '', subject: '', costingId: '', leadId: '',
  });

  useEffect(() => {
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
    api.get<typeof costings>('/costings/lookup').then(setCostings).catch(() => {});
    /*
      Leads still open, so a quotation can say which enquiry it answers.

      This moved here from a button on the lead screen. The link is not
      decoration: a quotation's outcome writes the lead's status back, so a
      quotation raised without one leaves its lead sitting at whatever stage
      somebody last set by hand.
    */
    api
      .get<{ rows: { id: string; companyName: string; status: string }[] }>(
        '/leads?pageSize=200&status=NEW,CONTACTED,QUALIFIED,SITE_VISIT,COSTING,QUOTATION_CREATED,NEGOTIATION',
      )
      .then((r) => setLeads(r.rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setContacts([]);
      setSites([]);
      return;
    }
    api
      .get<{ contacts: { id: string; name: string }[]; sites: { id: string; name: string }[] }>(
        `/customers/${form.customerId}`,
      )
      .then((c) => {
        setContacts(c.contacts);
        setSites(c.sites);
      })
      .catch(() => {});
  }, [form.customerId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>('/quotations', {
        customerId: form.customerId,
        contactId: form.contactId || null,
        siteId: form.siteId || null,
        subject: form.subject,
        costingId: form.costingId || null,
        leadId: form.leadId || null,
      });
      toast('ok', 'Quotation created');
      onCreated(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New quotation"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={create}
            disabled={busy || !form.customerId || form.subject.length < 2}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {leads.length > 0 && (
        <Field
          label="Answering which enquiry"
          hint="Optional, but it is what keeps the lead's status in step with this quotation"
        >
          <select value={form.leadId} onChange={(e) => setForm({ ...form, leadId: e.target.value })}>
            <option value="">— none —</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.companyName}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Customer">
        <select
          value={form.customerId}
          onChange={(e) => setForm({ ...form, customerId: e.target.value, contactId: '', siteId: '' })}
        >
          <option value="">— choose —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {contacts.length > 0 && (
        <Field label="Attention">
          <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
            <option value="">— none —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {sites.length > 0 && (
        <Field label="Site">
          <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            <option value="">— none —</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Subject">
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
      </Field>
      <Field label="Costing" hint="Links the pricing to what you actually estimated">
        <select value={form.costingId} onChange={(e) => setForm({ ...form, costingId: e.target.value })}>
          <option value="">— none yet —</option>
          {costings.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number} — {c.title}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function ItemModal({
  quotationId,
  revisionId,
  item,
  onClose,
  onSaved,
}: {
  quotationId: string;
  revisionId: string;
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    description: item?.description ?? '',
    quantity: item?.quantity?.toString() ?? '1',
    unit: item?.unit ?? 'lot',
    unitPrice: item?.unitPrice?.toString() ?? '',
  });

  const amount = (Number(form.quantity) || 0) * (Number(form.unitPrice) || 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        description: form.description,
        quantity: Number(form.quantity),
        unit: form.unit,
        unitPrice: Number(form.unitPrice),
      };
      if (item) await api.patch(`/quotations/${quotationId}/revisions/${revisionId}/items/${item.id}`, payload);
      else await api.post(`/quotations/${quotationId}/revisions/${revisionId}/items`, payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try {
      await api.del(`/quotations/${quotationId}/revisions/${revisionId}/items/${item.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={item ? 'Modify line' : 'Add line'}
      onClose={onClose}
      footer={
        <>
          {item && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.description}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Description">
        <textarea
          value={form.description}
          autoFocus
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>
      <div className="grid grid-3">
        <Field label="Quantity">
          <input
            type="number"
            step="0.001"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </Field>
        <Field label="Unit price">
          <input
            type="number"
            step="0.01"
            value={form.unitPrice}
            onChange={(e) => setForm({ ...form, unitPrice: e.target.value })}
          />
        </Field>
      </div>
      <div className="alert info" style={{ marginBottom: 0 }}>
        Line amount: <strong>{formatMoney(amount)}</strong>
      </div>
    </Modal>
  );
}

function QuotationSettings({
  quotation,
  revision,
  onClose,
  onSaved,
}: {
  quotation: QuotationDetail;
  revision: Revision;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [costings, setCostings] = useState<{ id: string; number: string; title: string }[]>([]);
  const [form, setForm] = useState({
    subject: quotation.subject,
    probability: quotation.probability.toString(),
    costingId: revision.costing?.id ?? '',
    validityDays: revision.validityDays.toString(),
    terms: revision.terms ?? '',
    notes: revision.notes ?? '',
    vatInclusive: revision.vatInclusive,
  });

  useEffect(() => {
    api.get<typeof costings>('/costings/lookup').then(setCostings).catch(() => {});
  }, []);

  const editableRevision = revision.status === 'DRAFT';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/quotations/${quotation.id}`, {
        subject: form.subject,
        probability: Number(form.probability),
      });
      if (editableRevision) {
        await api.patch(`/quotations/${quotation.id}/revisions/${revision.id}`, {
          costingId: form.costingId || null,
          validityDays: Number(form.validityDays),
          terms: form.terms || null,
          notes: form.notes || null,
          vatInclusive: form.vatInclusive,
        });
      }
      toast('ok', 'Saved');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Modify ${quotation.number}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {!editableRevision && (
        <div className="alert info">
          Revision {revision.revision} is {revision.status.toLowerCase().replace(/_/g, ' ')}, so its
          commercial terms are locked. Only the subject and probability can change here.
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Subject">
          <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
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
        <Field label="Costing" hint="Where the price and the margin come from">
          <select
            value={form.costingId}
            disabled={!editableRevision}
            onChange={(e) => setForm({ ...form, costingId: e.target.value })}
          >
            <option value="">— none —</option>
            {costings.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} — {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Validity (days)">
          <input
            type="number"
            disabled={!editableRevision}
            value={form.validityDays}
            onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Terms and conditions">
        <textarea
          value={form.terms}
          disabled={!editableRevision}
          onChange={(e) => setForm({ ...form, terms: e.target.value })}
        />
      </Field>
      <Field label="Notes">
        <textarea
          value={form.notes}
          disabled={!editableRevision}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>

      <Checkbox
        checked={form.vatInclusive}
        onChange={(v) => editableRevision && setForm({ ...form, vatInclusive: v })}
        label="Prices are VAT inclusive — the tax is backed out rather than added on"
      />
    </Modal>
  );
}
