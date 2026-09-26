import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
} from '../../components/ui';
import { CustomerForm, type CustomerRow } from './Customers';

/**
 * Customer 360 (model §3).
 *
 * One record workspace instead of menu-hopping: the customer, their people,
 * their sites, and — as later phases land — their quotations, projects,
 * invoices and service history, all reachable without leaving the page.
 *
 * The later tabs are rendered now, empty, with the phase that fills them. That
 * is deliberate: it shows the shape of what the system is becoming rather than
 * hiding it until the day it works.
 */

interface Contact {
  id: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  notes: string | null;
}

interface Site {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  region: string | null;
  contactId: string | null;
  contact: { id: string; name: string } | null;
  notes: string | null;
  isActive: boolean;
}

interface QuotationLine {
  id: string;
  number: string;
  subject: string;
  outcome: string;
  createdAt: string;
  revisionNo: number | null;
  revisionStatus: string | null;
  total: number | null;
}

interface ProjectLine {
  id: string;
  number: string;
  name: string;
  status: string;
  type: string;
  contractValue: number;
}

interface InvoiceLine {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  dueDate: string;
  invoiceTotal: number;
  netCollectible: number;
  amountCollected: number;
  outstanding: number;
}

interface ContractLine {
  id: string;
  number: string;
  status: string;
  startsAt: string;
  endsAt: string;
  frequencyMonths: number;
  job: { id: string; number: string; name: string };
}

interface Customer360 extends CustomerRow {
  createdAt: string;
  updatedAt: string;
  contacts: Contact[];
  sites: Site[];
  quotations: QuotationLine[];
  projects: ProjectLine[];
  invoices: InvoiceLine[];
  serviceContracts: ContractLine[];
}

export function Customer360Page() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [customer, setCustomer] = useState<Customer360 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [contactModal, setContactModal] = useState<Contact | 'new' | null>(null);
  const [siteModal, setSiteModal] = useState<Site | 'new' | null>(null);
  const [activity, setActivity] = useState<{ id: string; action: string; summary: string | null; actorName: string | null; at: string }[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setCustomer(await api.get<Customer360>(`/customers/${id}`));
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

  useEffect(() => {
    if (!id) return;
    api
      .get<typeof activity>(`/audit/customer/${id}`)
      .then(setActivity)
      .catch(() => setActivity([]));
  }, [id]);

  const mayEdit = can('gops.customers.edit_all');

  if (loading) return <Loading />;
  if (!customer) return <ErrorBox error={error ?? new Error('Customer not found')} />;

  async function remove() {
    if (!customer) return;
    try {
      await api.del(`/customers/${customer.id}`);
      toast('ok', `${customer.name} deleted`);
      navigate('/g-ops/customers');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/customers">Customers</Link>
        <span className="sep">›</span>
        <span className="mono">{customer.code}</span>
        <span className="sep">›</span>
        <span>{customer.name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{customer.name}</h1>
          <p>
            {[customer.industry, customer.legalName !== customer.name ? customer.legalName : null]
              .filter(Boolean)
              .join(' · ') || 'No industry recorded'}
            {!customer.isActive && (
              <span className="badge danger" style={{ marginLeft: 8 }}>
                Inactive
              </span>
            )}
          </p>
        </div>
        {mayEdit && (
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
            {can('gops.customers.delete') && (
              <button className="btn btn-danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      <div className="stack">
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">Company</h3>
            <dl style={{ margin: 0 }}>
              <Detail label="Code" value={<span className="mono">{customer.code}</span>} />
              <Detail label="Registered name" value={customer.legalName} />
              <Detail label="TIN" value={customer.tin} />
              <Detail label="Industry" value={customer.industry} />
              <Detail label="Phone" value={customer.phone} />
              <Detail label="Email" value={customer.email} />
              <Detail label="Website" value={customer.website} />
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Commercial</h3>
            <dl style={{ margin: 0 }}>
              <Detail label="Payment terms" value={customer.paymentTerms} />
              <Detail
                label="Credit limit"
                value={customer.creditLimit === null ? null : formatMoney(customer.creditLimit)}
              />
              <Detail label="Primary contact" value={customer.contacts.find((c) => c.isPrimary)?.name ?? null} />
              <Detail label="Sites" value={String(customer.sites.length)} />
              <Detail label="Added by" value={customer.createdBy?.name ?? null} />
              <Detail label="Added" value={formatDateTime(customer.createdAt)} />
            </dl>
          </div>

          {customer.notes && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h3 className="card-title">Notes</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{customer.notes}</div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Contacts
            </h3>
            {mayEdit && (
              <button className="btn btn-primary btn-sm" onClick={() => setContactModal('new')}>
                + Add contact
              </button>
            )}
          </div>

          {customer.contacts.length === 0 ? (
            <Empty
              title="No contacts yet"
              hint="A customer often has several — purchasing, engineering, accounts payable."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Position</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Mobile</th>
                    {mayEdit && <th style={{ width: 70 }} />}
                  </tr>
                </thead>
                <tbody>
                  {customer.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.isPrimary && (
                          <span className="badge ok" style={{ marginLeft: 7 }}>
                            primary
                          </span>
                        )}
                      </td>
                      <td>{c.position ?? '—'}</td>
                      <td className="mono">{c.email ?? '—'}</td>
                      <td>{c.phone ?? '—'}</td>
                      <td>{c.mobile ?? '—'}</td>
                      {mayEdit && (
                        <td>
                          <button className="btn btn-sm" onClick={() => setContactModal(c)}>
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
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Sites
            </h3>
            {mayEdit && (
              <button className="btn btn-primary btn-sm" onClick={() => setSiteModal('new')}>
                + Add site
              </button>
            )}
          </div>

          {customer.sites.length === 0 ? (
            <Empty
              title="No sites yet"
              hint="Projects and service contracts attach to a site, not just a customer."
            />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Address</th>
                    <th>City</th>
                    <th>Site contact</th>
                    <th>Status</th>
                    {mayEdit && <th style={{ width: 70 }} />}
                  </tr>
                </thead>
                <tbody>
                  {customer.sites.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.address ?? '—'}</td>
                      <td>{[s.city, s.region].filter(Boolean).join(', ') || '—'}</td>
                      <td>{s.contact?.name ?? '—'}</td>
                      <td>
                        <span className={`badge ${s.isActive ? 'ok' : ''}`}>
                          {s.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      {mayEdit && (
                        <td>
                          <button className="btn btn-sm" onClick={() => setSiteModal(s)}>
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
        </div>

        <Collection
          title="Quotations"
          count={customer.quotations.length}
          empty="No quotations raised for this customer."
          head={['Number', 'Subject', 'Revision', 'Value', 'Outcome']}
        >
          {customer.quotations.map((q) => (
            <tr key={q.id}>
              <td>
                <Link className="mono" to={`/g-ops/quotations/${q.id}`}>
                  {q.number}
                </Link>
              </td>
              <td>{q.subject}</td>
              <td>{q.revisionNo === null ? '—' : `Rev ${q.revisionNo} · ${q.revisionStatus}`}</td>
              <td className="num">{q.total === null ? '—' : formatMoney(q.total)}</td>
              <td>
                <StatusBadge status={q.outcome} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Projects"
          count={customer.projects.length}
          empty="Nothing has been awarded yet."
          head={['Number', 'Project', 'Kind', 'Contract value', 'Status']}
        >
          {customer.projects.map((j) => (
            <tr key={j.id}>
              <td>
                <Link className="mono" to={`/g-ops/projects/${j.id}`}>
                  {j.number}
                </Link>
              </td>
              <td>{j.name}</td>
              <td className="muted">
                {j.type === 'SERVICE_CONTRACT' ? 'Service contract' : 'Project'}
              </td>
              <td className="num">{formatMoney(j.contractValue)}</td>
              <td>
                <StatusBadge status={j.status} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Invoices"
          count={customer.invoices.length}
          empty="Nothing invoiced yet."
          head={['Number', 'Issued', 'Due', 'Invoiced', 'Collectible', 'Outstanding', 'Status']}
        >
          {customer.invoices.map((i) => (
            <tr key={i.id}>
              <td>
                <Link className="mono" to={`/g-fin/ar/${i.id}`}>
                  {i.number}
                </Link>
              </td>
              <td>{formatDate(i.invoiceDate)}</td>
              <td>{formatDate(i.dueDate)}</td>
              <td className="num">{formatMoney(i.invoiceTotal)}</td>
              <td className="num">{formatMoney(i.netCollectible)}</td>
              <td className="num">{formatMoney(i.outstanding)}</td>
              <td>
                <StatusBadge status={i.status} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Service contracts"
          count={customer.serviceContracts.length}
          empty="No service cover on record."
          head={['Number', 'Covers', 'From', 'Until', 'PM every', 'Status']}
        >
          {customer.serviceContracts.map((c) => (
            <tr key={c.id}>
              <td>
                <Link className="mono" to={`/g-ops/service-contracts/${c.id}`}>
                  {c.number}
                </Link>
              </td>
              <td>{c.job.name}</td>
              <td>{formatDate(c.startsAt)}</td>
              <td>{formatDate(c.endsAt)}</td>
              <td>{c.frequencyMonths} months</td>
              <td>
                <StatusBadge status={c.status} />
              </td>
            </tr>
          ))}
        </Collection>

        <div className="card">
          <h3 className="card-title">Activity</h3>
          {activity.length === 0 ? (
            <Empty title="No recorded activity" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 190 }}>When</th>
                    <th style={{ width: 110 }}>Action</th>
                    <th>Who</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td className="muted">{formatDateTime(a.at)}</td>
                      <td>
                        <span className="badge">{a.action}</span>
                      </td>
                      <td>{a.actorName ?? '—'}</td>
                      <td>{a.summary ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <CustomerForm
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {contactModal && (
        <ContactModal
          customerId={customer.id}
          contact={contactModal === 'new' ? null : contactModal}
          onClose={() => setContactModal(null)}
          onSaved={() => {
            setContactModal(null);
            void load();
          }}
        />
      )}

      {siteModal && (
        <SiteModal
          customerId={customer.id}
          site={siteModal === 'new' ? null : siteModal}
          contacts={customer.contacts}
          onClose={() => setSiteModal(null)}
          onSaved={() => {
            setSiteModal(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * One collection of the customer's history — quotations, projects, invoices,
 * service cover. Same card, same table, same empty line, so the page reads as
 * one document rather than four screens stacked.
 *
 * A collection the caller may not see arrives empty from the server, which is
 * the same as having none: the 360 view is a window onto those modules and
 * never a way around their permissions.
 */
function Collection({
  title,
  count,
  empty,
  head,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  head: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <h3 className="card-title">
        {title}
        {count > 0 && <span className="badge">{count}</span>}
      </h3>
      {count === 0 ? (
        /* One faint line, not a full empty state: four of those stacked turned
           a customer with no history into a page of blank panels. */
        <p className="collection-empty">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <dt className="faint" style={{ width: 150, flexShrink: 0, fontSize: 12 }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{value || <span className="faint">—</span>}</dd>
    </div>
  );
}

// ── Contact modal ────────────────────────────────────────────────────────────

function ContactModal({
  customerId,
  contact,
  onClose,
  onSaved,
}: {
  customerId: string;
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: contact?.name ?? '',
    position: contact?.position ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    mobile: contact?.mobile ?? '',
    isPrimary: contact?.isPrimary ?? false,
    notes: contact?.notes ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        position: form.position || null,
        email: form.email || null,
        phone: form.phone || null,
        mobile: form.mobile || null,
        isPrimary: form.isPrimary,
        notes: form.notes || null,
      };
      if (contact) await api.patch(`/customers/${customerId}/contacts/${contact.id}`, payload);
      else await api.post(`/customers/${customerId}/contacts`, payload);
      toast('ok', `${form.name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!contact) return;
    setBusy(true);
    try {
      await api.del(`/customers/${customerId}/contacts/${contact.id}`);
      toast('ok', `${contact.name} removed`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={contact ? `Modify ${contact.name}` : 'Add contact'}
      onClose={onClose}
      footer={
        <>
          {contact && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Position">
        <input
          value={form.position}
          placeholder="Purchasing Officer, Chief Engineer…"
          onChange={(e) => setForm({ ...form, position: e.target.value })}
        />
      </Field>
      <div className="grid grid-2">
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Mobile">
          <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
        </Field>
      </div>
      <Field label="Phone">
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <Checkbox
        checked={form.isPrimary}
        onChange={(v) => setForm({ ...form, isPrimary: v })}
        label="Primary contact — quotations default to this person"
      />
    </Modal>
  );
}

// ── Site modal ───────────────────────────────────────────────────────────────

function SiteModal({
  customerId,
  site,
  contacts,
  onClose,
  onSaved,
}: {
  customerId: string;
  site: Site | null;
  contacts: Contact[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: site?.name ?? '',
    address: site?.address ?? '',
    city: site?.city ?? '',
    region: site?.region ?? '',
    contactId: site?.contactId ?? '',
    notes: site?.notes ?? '',
    isActive: site?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        address: form.address || null,
        city: form.city || null,
        region: form.region || null,
        contactId: form.contactId || null,
        notes: form.notes || null,
        isActive: form.isActive,
      };
      if (site) await api.patch(`/customers/${customerId}/sites/${site.id}`, payload);
      else await api.post(`/customers/${customerId}/sites`, payload);
      toast('ok', `${form.name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!site) return;
    setBusy(true);
    try {
      await api.del(`/customers/${customerId}/sites/${site.id}`);
      toast('ok', `${site.name} removed`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={site ? `Modify ${site.name}` : 'Add site'}
      onClose={onClose}
      footer={
        <>
          {site && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Site name" hint="What people call it — Main Plant, Building B, Cebu Branch">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Address">
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="City">
          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Region / province">
          <input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
        </Field>
      </div>
      <Field label="Site contact" hint="Who to reach on site — often different from head office">
        <select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
          <option value="">— none —</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.position ? ` — ${c.position}` : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active"
      />
    </Modal>
  );
}
