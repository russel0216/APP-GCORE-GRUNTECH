import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Modal, ModalFoot, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import type { Industry, SubIndustry } from './Reference';
import { NumberInput } from '../../components/NumberInput';
import { loadPeople } from '../../components/People';

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  /** Where in the market the customer sits (2026-10-08) — optional, typed in by hand. */
  subIndustryId: string | null;
  subIndustry: { id: string; name: string } | null;
  /** The team that handles the customer (KAT, HIT, UIT, GIB, SIT) — open until somebody sets it (2026-10-09). */
  industryId: string | null;
  industry: { id: string; code: string; name: string } | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  isActive: boolean;
  contactCount: number;
  siteCount: number;
  /** Quotations still in play (open, submitted, in negotiation), and projects — list rows only. */
  openQuoteCount?: number;
  projectCount?: number;
  createdBy: { id: string; name: string } | null;
  createdAt?: string;
}

interface CustomerSummary {
  count?: number;
  inactive?: number;
}

/**
 * The sub-industry list, loaded once per screen. Any authenticated user may
 * read it — the customer form needs it under gops.customers.* alone.
 */
function useSubIndustries(activeOnly = false): SubIndustry[] | null {
  const [rows, setRows] = useState<SubIndustry[] | null>(null);
  useEffect(() => {
    api
      .get<SubIndustry[]>(`/reference/sub-industries${activeOnly ? '?active=true' : ''}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [activeOnly]);
  return rows;
}

/** The teams (the Industry master), loaded once per screen; anyone signed in may read it. */
function useTeams(): Industry[] | null {
  const [rows, setRows] = useState<Industry[] | null>(null);
  useEffect(() => {
    api
      .get<Industry[]>('/reference/industries')
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  return rows;
}

/** The team's code with its name in the title, or a faint "Open" — the customer is not yet handed to a team. */
export function TeamLabel({ industry }: { industry: CustomerRow['industry'] }) {
  if (!industry) return <span className="faint">Open</span>;
  return <span title={industry.name}>{industry.code}</span>;
}

/** The sub-industry's name, or a faint "Not stated" — never a blank cell. */
export function SubIndustryLabel({ subIndustry }: { subIndustry: CustomerRow['subIndustry'] }) {
  if (!subIndustry) return <span className="faint">Not stated</span>;
  return <span>{subIndustry.name}</span>;
}

// ── Mass actions: Set sub-industry, set team, active / inactive ─────────────

/**
 * Reclassify the ticked customers, hand them to a team, or mark them active
 * or inactive — each the ordinary PATCH /customers/:id, so the audit row and
 * the rules (a sub-industry or team must be active; a code never moves when
 * the filing does) are the PATCH's. Whatever did not change stays ticked,
 * with why.
 */
function CustomerBulkActions({
  ctx,
  subIndustries,
  teams,
}: {
  ctx: BulkContext<CustomerRow>;
  subIndustries: SubIndustry[];
  teams: Industry[];
}) {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ code: string; why: string }[]>([]);

  const industry = action.startsWith('industry:') ? subIndustries.find((i) => i.id === action.slice(9)) ?? null : null;
  const team = action.startsWith('team:') ? teams.find((t) => t.id === action.slice(5)) ?? null : null;
  const active = action === 'active' ? true : action === 'inactive' ? false : null;
  const same = (c: CustomerRow) =>
    industry ? c.subIndustryId === industry.id : team ? c.industryId === team.id : c.isActive === active;
  const already = industry ? `already ${industry.name}` : team ? `already ${team.code}` : `already ${active ? 'active' : 'inactive'}`;
  const plan = !action
    ? null
    : {
        go: ctx.rows.filter((c) => !same(c)),
        stay: ctx.rows.filter(same).map((c) => ({ row: c, why: already })),
      };
  const what = industry
    ? `filed under ${industry.name}`
    : team
      ? `handed to ${team.code}`
      : active
        ? 'marked active'
        : 'marked inactive';
  const payload = industry ? { subIndustryId: industry.id } : team ? { industryId: team.id } : { isActive: active };

  async function apply() {
    if (!plan || !plan.go.length) return;
    const failed: { row: CustomerRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let i = 0; i < plan.go.length; i++) {
      setProgress({ done: i, of: plan.go.length });
      const row = plan.go[i];
      try {
        await api.patch(`/customers/${row.id}`, payload);
        done++;
      } catch (err) {
        failed.push({ row, why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    const left = [...plan.stay, ...failed];
    toast(done > 0 ? 'ok' : 'error', `${done} customer${done === 1 ? '' : 's'} ${what}${left.length ? `; ${left.length} unchanged` : ''}`);
    setRefused(left.map((l) => ({ code: l.row.code, why: l.why })));
    setAction('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  return (
    <>
      <select
        aria-label="Reclassify, hand to a team, or mark active or inactive, the selected customers"
        value={action}
        disabled={!!progress}
        onChange={(e) => {
          setAction(e.target.value);
          setRefused([]);
        }}
      >
        <option value="">Set sub-industry, team or status…</option>
        <optgroup label="Set sub-industry">
          {subIndustries
            .filter((i) => i.isActive)
            .map((i) => (
              <option key={i.id} value={`industry:${i.id}`}>
                {i.name}
              </option>
            ))}
        </optgroup>
        <optgroup label="Set team">
          {teams
            .filter((t) => t.isActive)
            .map((t) => (
              <option key={t.id} value={`team:${t.id}`}>
                {t.code} — {t.name}
              </option>
            ))}
        </optgroup>
        <optgroup label="Status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </optgroup>
      </select>
      {plan && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!plan.go.length || !!progress}
          onClick={() => void apply()}
        >
          {progress
            ? `Working ${progress.done + 1} of ${progress.of}…`
            : plan.go.length
              ? industry
                ? `File ${plan.go.length} under ${industry.name}`
                : team
                  ? `Hand ${plan.go.length} to ${team.code}`
                  : `Mark ${plan.go.length} ${active ? 'active' : 'inactive'}`
              : 'Nothing to change'}
        </button>
      )}
      {plan && plan.stay.length > 0 && !progress && (
        <p className="list-bulk-result">
          {plan.stay.length} will stay as they are:{' '}
          {plan.stay
            .slice(0, 6)
            .map((st) => `${st.row.code} (${st.why})`)
            .join(', ')}
          {plan.stay.length > 6 ? `, and ${plan.stay.length - 6} more` : ''}.
        </p>
      )}
      {!plan && refused.length > 0 && (
        <div className="list-bulk-result" role="status">
          Still selected — these did not change:
          <ul>
            {refused.map((r) => (
              <li key={r.code}>
                <span className="mono">{r.code}</span>: {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The customer list, in the quotation list's layout (2026-10-08): summary
 * cards over the table, one Filters panel (the sub-industry among them),
 * open quotations and projects as columns, the printed list and mass
 * actions. The customer master is shared, so the list opens on All for
 * everyone; Mine is the customers you added.
 */
export function Customers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const subIndustries = useSubIndustries();
  const teams = useTeams();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  const mayEdit = can('gops.customers.edit_all');

  useEffect(() => {
    loadPeople('gops.customers.create')
      .then((rows) => setPeople(rows.map((p) => ({ value: p.id, label: p.name }))))
      .catch(() => setPeople([]));
  }, []);

  const columns: Column<CustomerRow>[] = [
    { key: 'code', label: 'Code', sortKey: 'code', width: '170px', render: (c) => <span className="mono">{c.code}</span> },
    {
      key: 'name',
      label: 'Customer',
      sortKey: 'name',
      render: (c) => (
        <div>
          <div>{c.name}</div>
          {c.legalName && c.legalName !== c.name && <div className="faint">{c.legalName}</div>}
        </div>
      ),
    },
    { key: 'subIndustry', label: 'Sub-industry', render: (c) => <SubIndustryLabel subIndustry={c.subIndustry} /> },
    { key: 'team', label: 'Team', width: '90px', render: (c) => <TeamLabel industry={c.industry} /> },
    {
      key: 'isActive',
      label: 'Status',
      render: (c) => <StatusBadge status={c.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />,
    },
    {
      key: 'contacts',
      label: 'Contacts',
      align: 'right',
      render: (c) => (c.contactCount === 0 ? <span className="faint">none</span> : c.contactCount),
    },
    {
      key: 'sites',
      label: 'Sites',
      align: 'right',
      render: (c) => (c.siteCount === 0 ? <span className="faint">none</span> : c.siteCount),
    },
    {
      key: 'openQuotes',
      label: 'Open quotes',
      align: 'right',
      render: (c) => (c.openQuoteCount ? c.openQuoteCount : <span className="faint">—</span>),
    },
    {
      key: 'projects',
      label: 'Projects',
      align: 'right',
      render: (c) => (c.projectCount ? c.projectCount : <span className="faint">—</span>),
    },
    { key: 'phone', label: 'Phone', render: (c) => c.phone ?? '—', optional: true },
    { key: 'email', label: 'Email', render: (c) => c.email ?? '—', optional: true },
    { key: 'paymentTerms', label: 'Terms', render: (c) => c.paymentTerms ?? '—', optional: true },
    {
      key: 'creditLimit',
      label: 'Credit limit',
      align: 'right',
      render: (c) => (c.creditLimit === null ? '—' : formatMoney(c.creditLimit)),
      optional: true,
    },
    { key: 'tin', label: 'TIN', render: (c) => <span className="mono">{c.tin ?? '—'}</span>, optional: true },
    {
      key: 'createdBy',
      label: 'Added by',
      sortKey: 'createdAt',
      render: (c) => (
        <div>
          <div>{c.createdBy?.name ?? '—'}</div>
          {c.createdAt && <div className="faint">{formatDate(c.createdAt)}</div>}
        </div>
      ),
    },
  ];

  const filters: FilterDef[] = [
    {
      key: 'subIndustry',
      label: 'Sub-industry',
      options: [
        ...(subIndustries ?? []).filter((i) => i.isActive).map((i) => ({ value: i.id, label: i.name })),
        { value: 'none', label: 'Not stated' },
      ],
    },
    {
      key: 'team',
      label: 'Team',
      options: [
        ...(teams ?? []).filter((t) => t.isActive).map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` })),
        { value: 'none', label: 'Open (no team yet)' },
      ],
    },
    {
      key: 'isActive',
      label: 'Status',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
    },
    { key: 'createdById', label: 'Added by', options: people },
    { key: 'createdFrom', toKey: 'createdTo', label: 'Added', type: 'dateRange' },
    {
      key: 'openQuote',
      label: 'Open quotation',
      options: [
        { value: 'yes', label: 'Has one in play' },
        { value: 'no', label: 'None in play' },
      ],
    },
    {
      key: 'project',
      label: 'Project',
      options: [
        { value: 'yes', label: 'Has a project' },
        { value: 'no', label: 'No project yet' },
      ],
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
        </div>
      </div>

      <DataList<CustomerRow>
        listKey="customers"
        endpoint="/customers"
        columns={columns}
        rowKey={(c) => c.id}
        scoped
        searchPlaceholder="Search name, code, TIN, or a contact's name…"
        reloadToken={reload}
        onRowClick={(c) => navigate(`/g-ops/customers/${c.id}`)}
        emptyTitle="No customers yet"
        emptyHint="Add the first one, or import a list you already have."
        filters={filters}
        printPath="/api/customers/pdf"
        selectable
        rowLabel={(c) => `${c.code} ${c.name}`}
        bulkActions={mayEdit ? (ctx) => <CustomerBulkActions ctx={ctx} subIndustries={subIndustries ?? []} teams={teams ?? []} /> : undefined}
        menuItems={
          can('gops.customers.create')
            ? [
                {
                  label: 'Import customers…',
                  hint: 'From a spreadsheet, checked before anything is saved',
                  onSelect: () => {
                    void loadImportSpec('customers').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []
        }
        summary={(raw, total) => {
          const sum = raw as CustomerSummary;
          return (
            <>
              <Stat label="Customers" value={total} />
              {!!sum.inactive && <Stat label="Inactive" value={sum.inactive} />}
            </>
          );
        }}
        actions={
          can('gops.customers.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New customer
            </button>
          ) : null
        }
      />

      {creating && (
        <CustomerForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`/g-ops/customers/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="customers"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

// ── New / Modify form ───────────────────────────────────────────────────────

export function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer?: CustomerRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const allSubIndustries = useSubIndustries();
  const allTeams = useTeams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    legalName: customer?.legalName ?? '',
    tin: customer?.tin ?? '',
    subIndustryId: customer?.subIndustryId ?? '',
    industryId: customer?.industryId ?? '',
    paymentTerms: customer?.paymentTerms ?? '',
    creditLimit: customer?.creditLimit?.toString() ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    website: customer?.website ?? '',
    notes: customer?.notes ?? '',
    isActive: customer?.isActive ?? true,
  });

  // Show the code the system would assign, without consuming it. The preview
  // only fills the field while it is empty or still holds the last preview —
  // a code somebody typed is theirs and is never overwritten.
  const preview = useRef('');
  useEffect(() => {
    if (customer) return;
    api
      .get<{ code: string }>('/customers/next-code')
      .then((r) =>
        setForm((f) => {
          const untouched = !f.code || f.code === preview.current;
          preview.current = r.code;
          return untouched ? { ...f, code: r.code } : f;
        }),
      )
      .catch(() => {});
  }, [customer]);

  // Offered: the active sub-industries, plus the one this customer already
  // has even if it has since been deactivated — otherwise the select would
  // show a blank and a save would silently reclassify.
  const subIndustries = (allSubIndustries ?? []).filter((i) => i.isActive || i.id === form.subIndustryId);
  const teams = (allTeams ?? []).filter((t) => t.isActive || t.id === form.industryId);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code || undefined,
        name: form.name,
        legalName: form.legalName || null,
        tin: form.tin || null,
        subIndustryId: form.subIndustryId || null,
        industryId: form.industryId || null,
        paymentTerms: form.paymentTerms || null,
        creditLimit: form.creditLimit === '' ? null : Number(form.creditLimit),
        phone: form.phone || null,
        email: form.email || null,
        website: form.website || null,
        notes: form.notes || null,
        isActive: form.isActive,
      };
      const saved = customer
        ? await api.patch<{ id: string }>(`/customers/${customer.id}`, payload)
        : await api.post<{ id: string }>('/customers', payload);
      toast('ok', `${form.name} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={customer ? `Modify customer ${customer.name}` : 'New customer'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Customer name" required>
          <input
            value={form.name}
            autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Code" hint="Auto-generated — override it if you have your own scheme">
          <input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Sub-industry" hint="Where in the market they sit — Healthcare, Government, Food and Beverage… Leave it until you know.">
          <select value={form.subIndustryId} onChange={(e) => setForm({ ...form, subIndustryId: e.target.value })}>
            <option value="">— not stated —</option>
            {subIndustries.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Team" hint="Who handles this customer — KAT, HIT, UIT, GIB or SIT. Leave it open until it is decided.">
          <select value={form.industryId} onChange={(e) => setForm({ ...form, industryId: e.target.value })}>
            <option value="">— open —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
                {t.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Registered / legal name" hint="Appears on invoices when it differs">
          <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </Field>
        <Field label="TIN">
          <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
        </Field>
        <Field label="Payment terms" hint="e.g. 30 days, or 30% down and balance on turnover">
          <input
            value={form.paymentTerms}
            onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          />
        </Field>
        <Field label="Credit limit">
          <NumberInput
            kind="money"
            value={form.creditLimit}
            onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Website">
          <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — inactive customers stay on past records but cannot be picked for new work"
      />
    </Modal>
  );
}
