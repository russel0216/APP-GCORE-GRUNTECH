import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ActivityLog } from '../../components/ActivityLog';
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
  humanise,
  useToast,
} from '../../components/ui';
import { CustomerForm, IndustryLabel, type CustomerRow } from './Customers';

/**
 * Customer 360 (model §3).
 *
 * One record workspace instead of menu-hopping: the customer, their people,
 * their sites, and everything the business has done with them — leads,
 * quotations, projects, job orders, service cover, installed equipment,
 * service reports, invoices and payments — each reachable without leaving the
 * page, and each a link to the record itself.
 *
 * Every collection arrives from the server behind the permission of the
 * screen it comes from. A collection the caller cannot see comes back empty,
 * which reads the same as having none: this page is a window onto those
 * modules, never a way around them.
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

interface LeadLine {
  id: string;
  number: string;
  status: string;
  description: string | null;
  estimatedValue: number | null;
  expectedClosing: string | null;
  nextActionDate: string | null;
  createdAt: string;
  assignedTo: { id: string; name: string } | null;
}

interface AssetLine {
  id: string;
  code: string;
  name: string;
  status: string;
  manufacturer: string | null;
  model: string | null;
  serialNo: string | null;
  warrantyEndsAt: string | null;
  site: { id: string; name: string } | null;
}

interface ReportLine {
  id: string;
  number: string;
  kind: string;
  status: string;
  performedAt: string | null;
  billable: boolean;
  underWarranty: boolean;
  asset: { id: string; name: string } | null;
  performedBy: { id: string; name: string } | null;
}

interface PaymentLine {
  id: string;
  number: string;
  kind: string;
  method: string;
  paymentDate: string;
  amount: number;
  reference: string | null;
  clearedAt: string | null;
}

interface JobOrderLine {
  id: string;
  number: string;
  status: string;
  kind: string;
  title: string;
  urgent: boolean;
  chargeBasis: string;
  requestedFor: string;
  amount: number | null;
  assignedTo: { id: string; name: string } | null;
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
  // Optional so a response from before these collections existed still renders.
  leads?: LeadLine[];
  installedAssets?: AssetLine[];
  serviceReports?: ReportLine[];
  payments?: PaymentLine[];
  jobOrders?: JobOrderLine[];
}

interface HistoryRow {
  id: string;
  action: string;
  summary: string | null;
  actorName: string | null;
  at: string;
}

/** Audit verbs are not statuses — every one of them is neutral. */
const ACTION_TONES = { CREATED: '', UPDATED: '', DELETED: '', EXPORTED: '', APPROVED: '', REJECTED: '' } as const;

const REPORT_KIND: Record<string, string> = {
  COMMISSIONING: 'Commissioning',
  PREVENTIVE_MAINTENANCE: 'Preventive maintenance',
  INSPECTION: 'Inspection',
  CORRECTIVE: 'Corrective',
};

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
  const [history, setHistory] = useState<HistoryRow[]>([]);

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
      .get<HistoryRow[]>(`/audit/customer/${id}`)
      .then(setHistory)
      .catch(() => setHistory([]));
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

  const leads = customer.leads ?? [];
  const installedAssets = customer.installedAssets ?? [];
  const serviceReports = customer.serviceReports ?? [];
  const payments = customer.payments ?? [];
  const jobOrders = customer.jobOrders ?? [];
  const forCustomer = `new=1&customerId=${encodeURIComponent(customer.id)}`;

  // Handoffs: start the next document already pointed at this customer.
  const shortcuts: { to: string; label: string }[] = [
    ...(can('gops.leads.create') ? [{ to: `/g-ops/leads?${forCustomer}`, label: 'New lead' }] : []),
    ...(can('gops.quotations.create') ? [{ to: `/g-ops/quotations?${forCustomer}`, label: 'New quotation' }] : []),
    ...(can('gops.costing.create') ? [{ to: `/g-ops/costing?${forCustomer}`, label: 'New costing' }] : []),
    ...(can('gops.job_orders.create')
      ? [{ to: `/g-ops/job-orders?${forCustomer}`, label: 'Request job order' }]
      : []),
  ];

  const subtitle = [customer.legalName && customer.legalName !== customer.name ? customer.legalName : null]
    .filter(Boolean)
    .join(' · ');

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
            <IndustryLabel industry={customer.industry} />
            {subtitle && <span className="muted"> · {subtitle}</span>}
            {!customer.isActive && (
              <span className="m-inline">
                <StatusBadge status="INACTIVE" extra={{ INACTIVE: 'danger' }} />
              </span>
            )}
          </p>
        </div>
        <div className="row m-shortcuts">
          {shortcuts.map((s) => (
            <Link key={s.to} className="btn btn-sm" to={s.to}>
              {s.label}
            </Link>
          ))}
          {mayEdit && (
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
          )}
          {mayEdit && can('gops.customers.delete') && (
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="stack">
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">Company</h3>
            <dl className="m-details">
              <Detail label="Code" value={<span className="mono">{customer.code}</span>} />
              <Detail label="Registered name" value={customer.legalName} />
              <Detail label="TIN" value={customer.tin} />
              <Detail label="Industry" value={<IndustryLabel industry={customer.industry} />} />
              <Detail label="Phone" value={customer.phone} />
              <Detail label="Email" value={customer.email} />
              <Detail label="Website" value={customer.website} />
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Commercial</h3>
            <dl className="m-details">
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
            <div className="card m-span-all">
              <h3 className="card-title">Notes</h3>
              <div className="m-prewrap">{customer.notes}</div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="m-card-head">
            <h3 className="card-title">Contacts</h3>
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
                    {mayEdit && <th className="m-col-action" />}
                  </tr>
                </thead>
                <tbody>
                  {customer.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.isPrimary && <span className="badge ok m-inline">primary</span>}
                      </td>
                      <td>{c.position ?? '—'}</td>
                      <td className="mono">{c.email ?? '—'}</td>
                      <td>{c.phone ?? '—'}</td>
                      <td>{c.mobile ?? '—'}</td>
                      {mayEdit && (
                        <td className="m-col-action">
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
          <div className="m-card-head">
            <h3 className="card-title">Sites</h3>
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
                    {mayEdit && <th className="m-col-action" />}
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
                        <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                      </td>
                      {mayEdit && (
                        <td className="m-col-action">
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

        {/* Leads ARE the opportunities — there is no separate Opportunity record. */}
        <Collection
          title="Leads"
          count={leads.length}
          empty="No leads recorded for this customer."
          head={['Number', 'Enquiry', 'Assigned to', 'Est. value', 'Expected closing', 'Status']}
        >
          {leads.map((l) => (
            <tr key={l.id}>
              <td>
                <Link className="mono" to={`/g-ops/leads/${l.id}`}>
                  {l.number}
                </Link>
              </td>
              <td>{l.description ?? '—'}</td>
              <td>{l.assignedTo?.name ?? <span className="faint">unassigned</span>}</td>
              <td className="num">{l.estimatedValue === null ? '—' : formatMoney(l.estimatedValue)}</td>
              <td>{formatDate(l.expectedClosing)}</td>
              <td>
                <StatusBadge status={l.status} />
              </td>
            </tr>
          ))}
        </Collection>

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
              <td>{q.revisionNo === null ? '—' : `Rev ${q.revisionNo} · ${humanise(q.revisionStatus ?? '')}`}</td>
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
          title="Job orders"
          count={jobOrders.length}
          empty="No service work has been requested for this customer."
          head={['Number', 'Work', 'Needed by', 'Charged as', 'Engineer', 'Status']}
        >
          {jobOrders.map((j) => (
            <tr key={j.id}>
              <td>
                <Link className="mono" to={`/g-ops/job-orders/${j.id}`}>
                  {j.number}
                </Link>
              </td>
              <td>
                {j.title}
                <span className="m-subname">
                  {REPORT_KIND[j.kind] ?? humanise(j.kind)}
                  {j.urgent ? ' · urgent' : ''}
                </span>
              </td>
              <td>{formatDate(j.requestedFor)}</td>
              <td>
                {humanise(j.chargeBasis)}
                {j.amount !== null && <span className="m-subname">{formatMoney(j.amount)}</span>}
              </td>
              <td>{j.assignedTo?.name ?? <span className="faint">unassigned</span>}</td>
              <td>
                <StatusBadge status={j.status} />
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

        <Collection
          title="Installed base"
          count={installedAssets.length}
          empty="No equipment of ours is recorded at this customer."
          head={['Code', 'Equipment', 'Make / model', 'Site', 'Warranty until', 'Status']}
        >
          {installedAssets.map((a) => (
            <tr key={a.id}>
              <td>
                <Link className="mono" to={`/g-ops/installed-base/${a.id}`}>
                  {a.code}
                </Link>
              </td>
              <td>
                {a.name}
                {a.serialNo && <span className="m-subname mono">S/N {a.serialNo}</span>}
              </td>
              <td>{[a.manufacturer, a.model].filter(Boolean).join(' ') || '—'}</td>
              <td>{a.site?.name ?? '—'}</td>
              <td>{formatDate(a.warrantyEndsAt)}</td>
              <td>
                <StatusBadge status={a.status} extra={{ INACTIVE: 'warn', DECOMMISSIONED: '' }} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Service reports"
          count={serviceReports.length}
          empty="No service reports filed for this customer."
          head={['Number', 'Kind', 'Equipment', 'Performed', 'By', 'Status']}
        >
          {serviceReports.map((r) => (
            <tr key={r.id}>
              <td>
                <Link className="mono" to={`/g-ops/service-reports/${r.id}`}>
                  {r.number}
                </Link>
              </td>
              <td>
                {REPORT_KIND[r.kind] ?? humanise(r.kind)}
                {r.underWarranty && <span className="m-subname">under warranty</span>}
              </td>
              <td>{r.asset?.name ?? '—'}</td>
              <td>{formatDate(r.performedAt)}</td>
              <td>{r.performedBy?.name ?? '—'}</td>
              <td>
                <StatusBadge status={r.status} />
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
          title="Payments"
          count={payments.length}
          empty="No payments recorded from this customer."
          head={['Number', 'Date', 'Method', 'Reference', 'Amount', 'Cleared']}
        >
          {payments.map((p) => (
            <tr key={p.id}>
              <td>
                <Link className="mono" to={`/g-fin/payments?payment=${encodeURIComponent(p.id)}`}>
                  {p.number}
                </Link>
              </td>
              <td>{formatDate(p.paymentDate)}</td>
              <td>{humanise(p.method)}</td>
              <td>{p.reference ?? '—'}</td>
              <td className="num">{formatMoney(p.amount)}</td>
              <td>
                {p.clearedAt ? (
                  formatDate(p.clearedAt)
                ) : (
                  <StatusBadge status="UNCLEARED" extra={{ UNCLEARED: 'warn' }} label="Not cleared" />
                )}
              </td>
            </tr>
          ))}
        </Collection>

        {can('gops.calendar.view_all') && (
          <div className="card">
            <h3 className="card-title">Activity</h3>
            <ActivityLog customerId={customer.id} />
          </div>
        )}

        <div className="card">
          <h3 className="card-title">History</h3>
          {history.length === 0 ? (
            <p className="collection-empty">No recorded changes.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Who</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((a) => (
                    <tr key={a.id}>
                      <td className="muted">{formatDateTime(a.at)}</td>
                      <td>
                        <StatusBadge status={a.action} extra={ACTION_TONES} />
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
 * One collection of the customer's history. Same card, same table, same empty
 * line, so the page reads as one document rather than nine screens stacked.
 */
export function Collection({
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
  children: ReactNode;
}) {
  return (
    <div className="card">
      <h3 className="card-title">
        {title}
        {count > 0 && <span className="badge">{count}</span>}
      </h3>
      {count === 0 ? (
        /* One faint line, not a full empty state: nine of those stacked turned
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

export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || <span className="faint">—</span>}</dd>
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
