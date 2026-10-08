import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { openAttachment } from '../../components/Attachments';
import { Stat } from '../../components/charts';
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

/**
 * G-OPS › Sales › Partners.
 *
 * The principals whose equipment Gruntech sells and services, seen from Sales.
 * Every partner IS a supplier — the company whose catalogue a salesperson
 * reads is the company procurement orders from — so this screen is a view of
 * the one supplier record, gated by gops.partners.* so Sales can open it
 * without holding any G-CHAIN permission.
 *
 * What it adds on top of the supplier: a brand, a "partner since" date, and
 * resources — catalogues, price lists and sizing tools, each a file, a link,
 * or both — plus the partner's price list, read off Item.listPrice for the
 * items that name the partner as preferred supplier. A list PRICE, never a
 * cost: the price-list route selects no cost field at all.
 */

type ResourceKind = 'CATALOGUE' | 'PRICE_LIST' | 'SIZING_APP' | 'OTHER';

const KIND_LABEL: Record<ResourceKind, string> = {
  CATALOGUE: 'Catalogue',
  PRICE_LIST: 'Price list',
  SIZING_APP: 'Sizing app',
  OTHER: 'Document',
};

/** Resource kinds are categories, not states — all neutral. */
const KIND_TONES = { CATALOGUE: '', PRICE_LIST: '', SIZING_APP: '', OTHER: '' } as const;

interface PartnerRow {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  legalName: string | null;
  category: string | null;
  website: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  partnerSince: string | null;
  contactCount: number;
  catalogues: number;
  priceLists: number;
  sizingApps: number;
  pricedItems: number;
  createdAt: string;
}

interface PartnerSummary {
  count?: number;
  withPriceList?: number;
  pricedItems?: number;
  tabs?: { value: string; label: string }[];
}

// ── Mass actions: Set what they supply ───────────────────────────────────────

/**
 * File the ticked partners under one category ("what they supply") — each
 * the ordinary PATCH /partners/:id, so the audit row is the PATCH's. The box
 * offers the categories already on file, so a new spelling is a choice, not
 * an accident. Clearing one is done on the partner's own page, never in
 * bulk. What did not change stays ticked, with why.
 */
function PartnerBulkCategory({ ctx, known }: { ctx: BulkContext<PartnerRow>; known: string[] }) {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ code: string; why: string }[]>([]);
  const clean = category.trim().replace(/\s+/g, ' ');
  const same = (p: PartnerRow) => (p.category ?? '').trim().toLowerCase() === clean.toLowerCase();
  const go = ctx.rows.filter((p) => !same(p));
  const stay = ctx.rows.filter(same);

  async function apply() {
    if (!clean) return;
    const failed: { row: PartnerRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let i = 0; i < go.length; i++) {
      setProgress({ done: i, of: go.length });
      try {
        await api.patch(`/partners/${go[i].id}`, { category: clean });
        done++;
      } catch (err) {
        failed.push({ row: go[i], why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    const left = [...stay.map((row) => ({ row, why: `already ${clean}` })), ...failed];
    toast(done > 0 ? 'ok' : 'error', `${done} partner${done === 1 ? '' : 's'} filed under ${clean}${left.length ? `; ${left.length} unchanged` : ''}`);
    setRefused(left.map((l) => ({ code: l.row.code, why: l.why })));
    setOpen(false);
    setCategory('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  if (!open) {
    return (
      <>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          Set what they supply…
        </button>
        {refused.length > 0 && (
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
  return (
    <>
      <input
        type="text"
        className="list-bulk-reason"
        list="partner-bulk-categories"
        autoFocus
        aria-label="What the selected partners supply"
        placeholder="What they supply, e.g. Compressors"
        value={category}
        disabled={!!progress}
        onChange={(e) => setCategory(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <datalist id="partner-bulk-categories">
        {known.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <button type="button" className="btn btn-sm btn-primary" disabled={!clean || !go.length || !!progress} onClick={() => void apply()}>
        {progress
          ? `Working ${progress.done + 1} of ${progress.of}…`
          : !clean
            ? 'Type what they supply'
            : go.length
              ? `File ${go.length} under ${clean}`
              : 'Nothing to change'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!!progress} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </>
  );
}

interface ResourceFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

interface Resource {
  id: string;
  kind: ResourceKind;
  title: string;
  description: string | null;
  url: string | null;
  validFrom: string | null;
  validUntil: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  attachment: ResourceFile | null;
}

interface PartnerContact {
  id: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
}

interface Partner {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  legalName: string | null;
  category: string | null;
  website: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  partnerSince: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  contacts: PartnerContact[];
  resources: Resource[];
  counts: { catalogues: number; priceLists: number; sizingApps: number; pricedItems: number };
}

interface PriceRow {
  id: string;
  code: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  unit: string;
  itemType: string;
  isActive: boolean;
  listPrice: number | null;
  listPriceCurrency: string | null;
  listPriceAsOf: string | null;
  category: { name: string } | null;
}

/** The host of a website, for a narrow column — the full URL is the link. */
function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

/** Only http(s) ever becomes an href; anything else renders as text. */
function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  return /^https?:\/\//i.test(withScheme) ? withScheme : null;
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_EXTRA = { INACTIVE: 'danger' } as const;

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

export function Partners() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);

  const count = (n: number) => (n === 0 ? <span className="faint">none</span> : n);
  // The categories on file, for the bulk box's suggestions — learnt from the
  // tabs the list's summary sends, so there is no second query for them.
  const [knownCategories, setKnownCategories] = useState<string[]>([]);

  const filters: FilterDef[] = [
    {
      key: 'isActive',
      label: 'Status',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
    },
    {
      key: 'publishes',
      label: 'Publishes',
      options: [
        { value: 'CATALOGUE', label: 'A catalogue' },
        { value: 'PRICE_LIST', label: 'A price list' },
        { value: 'SIZING_APP', label: 'A sizing app' },
      ],
    },
    {
      key: 'priced',
      label: 'Priced items',
      options: [
        { value: 'yes', label: 'Has items with a list price' },
        { value: 'no', label: 'None priced yet' },
      ],
    },
    { key: 'sinceFrom', toKey: 'sinceTo', label: 'Partner since', type: 'dateRange' },
  ];

  const columns: Column<PartnerRow>[] = [
    {
      key: 'brand',
      label: 'Brand',
      sortKey: 'brand',
      render: (p) => (
        <div>
          <div>{p.brand ?? p.name}</div>
          {p.brand && p.brand !== p.name && <span className="m-subname">{p.name}</span>}
        </div>
      ),
    },
    { key: 'code', label: 'Code', sortKey: 'code', render: (p) => <span className="mono">{p.code}</span> },
    { key: 'category', label: 'Supplies', render: (p) => p.category ?? '—' },
    { key: 'catalogues', label: 'Catalogues', align: 'right', render: (p) => count(p.catalogues) },
    { key: 'priceLists', label: 'Price lists', align: 'right', render: (p) => count(p.priceLists) },
    { key: 'sizingApps', label: 'Sizing apps', align: 'right', render: (p) => count(p.sizingApps) },
    { key: 'pricedItems', label: 'Priced items', align: 'right', render: (p) => count(p.pricedItems) },
    {
      key: 'website',
      label: 'Website',
      optional: true,
      render: (p) => {
        const href = safeHref(p.website);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {hostOf(href)} ↗
          </a>
        ) : (
          '—'
        );
      },
    },
    { key: 'since', label: 'Since', sortKey: 'partnerSince', render: (p) => formatDate(p.partnerSince) },
    { key: 'contacts', label: 'Contacts', align: 'right', optional: true, render: (p) => count(p.contactCount) },
    {
      key: 'isActive',
      label: 'Status',
      render: (p) => <StatusBadge status={p.isActive ? 'ACTIVE' : 'INACTIVE'} extra={STATUS_EXTRA} />,
    },
  ];

  const addButton = can('gops.partners.create') && (
    <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
      + Add partner
    </button>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Partners</h1>
          <p>
            The principals whose equipment we sell and service — their catalogues, price lists and
            sizing tools in one place. Each is also a supplier: procurement orders from the same
            record.
          </p>
        </div>
      </div>

      <DataList<PartnerRow>
        listKey="partners"
        endpoint="/partners"
        columns={columns}
        rowKey={(p) => p.id}
        scoped
        searchPlaceholder="Search brand, name, code, what they supply, or a contact…"
        reloadToken={reload}
        onRowClick={(p) => navigate(`/g-ops/partners/${p.id}`)}
        emptyTitle="No partners yet"
        emptyHint="Add the principals you represent, or import a list."
        emptyAction={addButton || undefined}
        tabs={{ key: 'category', label: 'What they supply', allLabel: 'All partners', options: [] }}
        filters={filters}
        printPath="/api/partners/pdf"
        selectable
        rowLabel={(p) => `${p.code} ${p.brand ?? p.name}`}
        bulkActions={can('gops.partners.edit_all') ? (ctx) => <PartnerBulkCategory ctx={ctx} known={knownCategories} /> : undefined}
        menuItems={
          can('gops.partners.create')
            ? [
                {
                  label: 'Import partners…',
                  hint: 'From a spreadsheet, checked before anything is saved',
                  onSelect: () => {
                    void loadImportSpec('partners').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []
        }
        summaryLine={(raw, total) => {
          const sum = raw as PartnerSummary;
          return (
            <>
              <span>
                <strong>{total}</strong> partner{total === 1 ? '' : 's'}
              </span>
              <span>
                <strong>{sum.withPriceList ?? 0}</strong> publish a price list
              </span>
              <span>
                <strong>{sum.pricedItems ?? 0}</strong> priced items
              </span>
            </>
          );
        }}
        onSummary={(raw) =>
          setKnownCategories(((raw as PartnerSummary).tabs ?? []).filter((t) => t.value !== 'none').map((t) => t.label))
        }
        actions={addButton || null}
      />

      {adding && (
        <PartnerForm
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            navigate(`/g-ops/partners/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="partners"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  ADD / MODIFY
// ════════════════════════════════════════════════════════════════════

function PartnerForm({
  partner,
  onClose,
  onSaved,
}: {
  partner?: Partner;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const mayPickSupplier = can('gchain.suppliers.view_all');
  const [mode, setMode] = useState<'existing' | 'new'>(mayPickSupplier && !partner ? 'existing' : 'new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [supplierQuery, setSupplierQuery] = useState('');
  const [suppliers, setSuppliers] = useState<{ id: string; code: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState('');

  const [form, setForm] = useState({
    name: partner?.name ?? '',
    brand: partner?.brand ?? '',
    code: '',
    legalName: '',
    category: partner?.category ?? '',
    website: partner?.website ?? '',
    phone: '',
    email: '',
    address: '',
    city: '',
    partnerSince: partner?.partnerSince ? partner.partnerSince.slice(0, 10) : '',
    notes: partner?.notes ?? '',
    contactName: '',
    contactPosition: '',
    contactEmail: '',
    contactMobile: '',
  });

  useEffect(() => {
    if (partner || mode !== 'existing' || !mayPickSupplier) return;
    const t = setTimeout(() => {
      api
        .get<{ id: string; code: string; name: string }[]>(
          `/suppliers/lookup${supplierQuery ? `?q=${encodeURIComponent(supplierQuery)}` : ''}`,
        )
        .then(setSuppliers)
        .catch(() => setSuppliers([]));
    }, 250);
    return () => clearTimeout(t);
  }, [supplierQuery, mode, partner, mayPickSupplier]);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let saved: { id: string };
      if (partner) {
        saved = await api.patch<{ id: string }>(`/partners/${partner.id}`, {
          name: form.name,
          brand: form.brand || null,
          category: form.category || null,
          website: form.website || null,
          partnerSince: form.partnerSince || null,
          notes: form.notes || null,
        });
      } else if (mode === 'existing') {
        saved = await api.post<{ id: string }>('/partners', {
          supplierId,
          brand: form.brand || null,
          partnerSince: form.partnerSince || null,
        });
      } else {
        saved = await api.post<{ id: string }>('/partners', {
          name: form.name,
          code: form.code || null,
          brand: form.brand || null,
          legalName: form.legalName || null,
          category: form.category || null,
          website: form.website || null,
          phone: form.phone || null,
          email: form.email || null,
          address: form.address || null,
          city: form.city || null,
          partnerSince: form.partnerSince || null,
          notes: form.notes || null,
          contact: form.contactName.trim()
            ? {
                name: form.contactName,
                position: form.contactPosition || null,
                email: form.contactEmail || null,
                mobile: form.contactMobile || null,
              }
            : null,
        });
      }
      toast('ok', partner ? 'Partner saved' : 'Partner added');
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid = partner ? form.name.trim().length >= 2 : mode === 'existing' ? !!supplierId : form.name.trim().length >= 2;

  return (
    <Modal
      wide
      title={partner ? `Modify ${partner.brand ?? partner.name}` : 'Add partner'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {!partner && mayPickSupplier && (
        <div className="scope-switch m-tabs" role="group" aria-label="Where the partner comes from">
          <button type="button" className={mode === 'existing' ? 'active' : ''} aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>
            An existing supplier
          </button>
          <button type="button" className={mode === 'new' ? 'active' : ''} aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
            A new company
          </button>
        </div>
      )}

      {partner && (
        <div className="alert info">
          Legal name, TIN, address, terms and contacts are kept on the supplier record
          {can('gchain.suppliers.view_all') ? (
            <>
              {' — '}
              <Link to={`/g-chain/suppliers/${partner.id}`}>open it in G-CHAIN</Link>.
            </>
          ) : (
            ', which procurement maintains.'
          )}
        </div>
      )}

      {!partner && mode === 'existing' ? (
        <>
          <p className="muted">
            Flag a supplier procurement already buys from. It stays one record — its purchase
            orders and bills are untouched.
          </p>
          <div className="grid grid-2">
            <Field label="Find the supplier" hint="Name or code">
              <input value={supplierQuery} autoFocus onChange={(e) => setSupplierQuery(e.target.value)} />
            </Field>
            <Field label="Supplier" required>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— choose —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Brand" hint="Trading name when it differs from the registered name">
              <input value={form.brand} onChange={set('brand')} />
            </Field>
            <Field label="Partner since">
              <input type="date" value={form.partnerSince} onChange={set('partnerSince')} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-2">
            <Field label={partner ? 'Supplier name' : 'Registered name'} required>
              <input value={form.name} autoFocus onChange={set('name')} />
            </Field>
            <Field label="Brand" hint="Atlas Copco, for Atlas Copco (Philippines) Inc.">
              <input value={form.brand} onChange={set('brand')} />
            </Field>
            {!partner && (
              <Field label="Code" hint="Leave blank to auto-generate a supplier code">
                <input className="mono" value={form.code} onChange={set('code')} />
              </Field>
            )}
            <Field label="What they supply" hint="Compressors, generators, gas plants…">
              <input value={form.category} onChange={set('category')} />
            </Field>
            <Field label="Website">
              <input value={form.website} onChange={set('website')} placeholder="https://" />
            </Field>
            <Field label="Partner since">
              <input type="date" value={form.partnerSince} onChange={set('partnerSince')} />
            </Field>
            {!partner && (
              <>
                <Field label="Legal name" hint="When it differs from the registered name above">
                  <input value={form.legalName} onChange={set('legalName')} />
                </Field>
                <Field label="Phone">
                  <input value={form.phone} onChange={set('phone')} />
                </Field>
                <Field label="Email">
                  <input type="email" value={form.email} onChange={set('email')} />
                </Field>
                <Field label="Address">
                  <input value={form.address} onChange={set('address')} />
                </Field>
                <Field label="City">
                  <input value={form.city} onChange={set('city')} />
                </Field>
              </>
            )}
          </div>

          {!partner && (
            <>
              <h4 className="m-section-head">Primary contact (optional)</h4>
              <div className="grid grid-2">
                <Field label="Name">
                  <input value={form.contactName} onChange={set('contactName')} />
                </Field>
                <Field label="Position">
                  <input value={form.contactPosition} onChange={set('contactPosition')} />
                </Field>
                <Field label="Email">
                  <input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
                </Field>
                <Field label="Mobile">
                  <input value={form.contactMobile} onChange={set('contactMobile')} />
                </Field>
              </div>
            </>
          )}

          <Field label="Notes">
            <textarea value={form.notes} onChange={set('notes')} />
          </Field>
        </>
      )}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════════════════

type Tab = 'catalogues' | 'prices' | 'sizing' | 'people' | 'notes';
const TABS: Tab[] = ['catalogues', 'prices', 'sizing', 'people', 'notes'];

export function PartnerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [resourceModal, setResourceModal] = useState<{ resource: Resource | null; kind: ResourceKind } | null>(null);
  const [importingItems, setImportingItems] = useState<{ label: string; columns: never[] } | null>(null);
  const [priceReload, setPriceReload] = useState(0);

  // The open tab lives in the URL, so a link can land on the price list.
  const tabParam = params.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'catalogues';
  function openTab(next: Tab) {
    // A fresh query string: the price list's own search and page belong to
    // that tab and should not follow the user to the next one.
    setParams(next === 'catalogues' ? {} : { tab: next }, { replace: true });
  }

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setPartner(await api.get<Partner>(`/partners/${id}`));
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

  if (loading && !partner) return <Loading />;
  if (!partner) return <ErrorBox error={error ?? new Error('Partner not found')} />;

  const mayEdit = can('gops.partners.edit_all');
  const mayDelete = can('gops.partners.delete');
  const brand = partner.brand ?? partner.name;

  const byKind = (kinds: ResourceKind[]) => partner.resources.filter((r) => kinds.includes(r.kind));
  const catalogues = byKind(['CATALOGUE']);
  const others = byKind(['OTHER']);
  const priceLists = byKind(['PRICE_LIST']);
  const sizingApps = byKind(['SIZING_APP']);

  async function removePartner() {
    if (!partner) return;
    try {
      await api.del(`/partners/${partner.id}`);
      toast('ok', `${brand} removed from partners — the supplier record is kept`);
      navigate('/g-ops/partners');
    } catch (err) {
      setError(err);
      setRemoving(false);
    }
  }

  const tabLabel: Record<Tab, string> = {
    catalogues: 'Catalogues',
    prices: 'Price list',
    sizing: 'Sizing apps',
    people: 'People',
    notes: 'Notes',
  };
  const tabCount: Partial<Record<Tab, number>> = {
    catalogues: catalogues.length + others.length,
    prices: priceLists.length,
    sizing: sizingApps.length,
    people: partner.contacts.length,
  };

  const addResource = (kind: ResourceKind, label: string) =>
    mayEdit && (
      <button className="btn btn-primary btn-sm" onClick={() => setResourceModal({ resource: null, kind })}>
        + Add {label}
      </button>
    );

  const cards = (rows: Resource[]) => (
    <div className="m-resources">
      {rows.map((r) => (
        <ResourceCard
          key={r.id}
          resource={r}
          mayEdit={mayEdit}
          onModify={() => setResourceModal({ resource: r, kind: r.kind })}
        />
      ))}
    </div>
  );

  const website = safeHref(partner.website);

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/partners">Partners</Link>
        <span className="sep">›</span>
        <span className="mono">{partner.code}</span>
        <span className="sep">›</span>
        <span>{brand}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            {brand}
            {!partner.isActive && (
              <span className="m-inline">
                <StatusBadge status="INACTIVE" extra={STATUS_EXTRA} />
              </span>
            )}
          </h1>
          <p>
            {partner.brand && partner.brand !== partner.name && <span className="m-subname">{partner.name}</span>}
            {partner.category ?? 'What they supply is not recorded yet'}
            {website && (
              <>
                {' · '}
                <a href={website} target="_blank" rel="noopener noreferrer">
                  {hostOf(website)} ↗
                </a>
              </>
            )}
          </p>
        </div>
        <div className="row">
          {can('gchain.suppliers.view_all') && (
            <Link className="btn btn-sm" to={`/g-chain/suppliers/${partner.id}`}>
              Supplier record ›
            </Link>
          )}
          {mayEdit && (
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
          )}
          {mayDelete && (
            <button className="btn btn-danger" onClick={() => setRemoving(true)}>
              Remove from partners
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="kpi-grid m-kpis">
        <Stat label="Catalogues" value={partner.counts.catalogues} sub="active, files or links" />
        <Stat label="Price lists" value={partner.counts.priceLists} sub="published documents" />
        <Stat label="Sizing apps" value={partner.counts.sizingApps} sub="the partner's own tools" />
        <Stat label="Priced items" value={partner.counts.pricedItems} sub="items with a list price" />
      </div>

      <div className="scope-switch m-tabs" role="group" aria-label="Partner sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? 'active' : ''}
            aria-pressed={tab === t}
            onClick={() => openTab(t)}
          >
            {tabLabel[t]}
            {tabCount[t] !== undefined && <span className="m-tab-count">{tabCount[t]}</span>}
          </button>
        ))}
      </div>

      {tab === 'catalogues' && (
        <div className="stack">
          <div className="m-card-head">
            <h3 className="card-title">Catalogues</h3>
            {addResource('CATALOGUE', 'catalogue')}
          </div>
          {catalogues.length === 0 ? (
            <Empty
              title="No catalogues yet"
              hint="Attach the partner's catalogue PDF, or link to their online catalogue."
            />
          ) : (
            cards(catalogues)
          )}
          {(others.length > 0 || mayEdit) && (
            <>
              <div className="m-card-head">
                <h4 className="m-section-head">Other documents</h4>
                {addResource('OTHER', 'document')}
              </div>
              {others.length === 0 ? (
                <p className="collection-empty">Brochures, certificates, manuals — anything else they publish.</p>
              ) : (
                cards(others)
              )}
            </>
          )}
        </div>
      )}

      {tab === 'prices' && (
        <div className="stack">
          <div className="m-card-head">
            <h3 className="card-title">Price list documents</h3>
            {addResource('PRICE_LIST', 'price list')}
          </div>
          {priceLists.length === 0 ? (
            <p className="collection-empty">
              No price-list document yet — attach the partner's file, or link to it.
            </p>
          ) : (
            cards(priceLists)
          )}

          <h4 className="m-section-head">Priced items</h4>
          <DataList<PriceRow>
            listKey={`partner-price-list-${partner.id}`}
            endpoint={`/partners/${partner.id}/price-list`}
            rowKey={(r) => r.id}
            reloadToken={priceReload}
            searchPlaceholder="Search code, part number, name…"
            onRowClick={
              can('gchain.items.view_all') ? (r) => navigate(`/g-chain/items/${r.id}`) : undefined
            }
            columns={[
              { key: 'code', label: 'Code', sortKey: 'code', render: (r) => <span className="mono">{r.code}</span> },
              {
                key: 'partNumber',
                label: 'Part no.',
                render: (r) => (r.partNumber ? <span className="mono">{r.partNumber}</span> : '—'),
              },
              {
                key: 'name',
                label: 'Item',
                sortKey: 'name',
                render: (r) => (
                  <div>
                    <div>{r.name}</div>
                    {r.category && <span className="m-subname">{r.category.name}</span>}
                  </div>
                ),
              },
              { key: 'unit', label: 'Unit', render: (r) => r.unit },
              {
                key: 'listPrice',
                label: 'List price',
                sortKey: 'listPrice',
                align: 'right',
                render: (r) =>
                  r.listPrice == null ? (
                    <span className="faint">—</span>
                  ) : (
                    formatMoney(r.listPrice, r.listPriceCurrency ?? 'PHP')
                  ),
              },
              {
                key: 'asOf',
                label: 'As of',
                sortKey: 'listPriceAsOf',
                render: (r) => formatDate(r.listPriceAsOf),
              },
              {
                key: 'isActive',
                label: 'Status',
                render: (r) => (
                  <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                ),
              },
            ]}
            filters={[
              { key: 'priced', label: 'Priced', options: [{ value: 'true', label: 'Priced only' }] },
              {
                key: 'isActive',
                label: 'Status',
                options: [
                  { value: 'true', label: 'Active' },
                  { value: 'false', label: 'Inactive' },
                ],
              },
            ]}
            actions={
              can('gchain.items.create') && (
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const spec = await loadImportSpec('items');
                    if (spec) setImportingItems(spec as { label: string; columns: never[] });
                  }}
                >
                  Import price list
                </button>
              )
            }
            emptyTitle="No priced items yet"
            emptyHint={`Items whose preferred supplier is this partner appear here with their list price. Bulk-load them under G-CHAIN › Item Master › Import with Preferred Supplier = "${brand}".`}
          />
        </div>
      )}

      {tab === 'sizing' && (
        <div className="stack">
          <div className="m-card-head">
            <h3 className="card-title">Sizing apps</h3>
            {addResource('SIZING_APP', 'sizing app')}
          </div>
          {sizingApps.length === 0 ? (
            <Empty
              title="No sizing apps yet"
              hint="Link the partner's online selection or sizing tool — it opens in a new tab."
            />
          ) : (
            cards(sizingApps)
          )}
        </div>
      )}

      {tab === 'people' && (
        <div className="card">
          <div className="m-card-head">
            <h3 className="card-title">People</h3>
            {can('gchain.suppliers.view_all') && (
              <Link to={`/g-chain/suppliers/${partner.id}`}>Manage on the supplier record ›</Link>
            )}
          </div>
          {partner.contacts.length === 0 ? (
            <Empty title="No contacts yet" hint="Procurement keeps the supplier's contacts." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Position</th>
                    <th>Email</th>
                    <th>Mobile</th>
                    <th>Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {partner.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.isPrimary && <span className="badge ok m-inline">primary</span>}
                      </td>
                      <td>{c.position ?? '—'}</td>
                      <td className="mono">
                        {c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}
                      </td>
                      <td>{c.mobile ?? '—'}</td>
                      <td>{c.phone ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="card">
          <h3 className="card-title">Notes</h3>
          <dl className="m-details">
            <div>
              <dt>Supplier code</dt>
              <dd className="mono">{partner.code}</dd>
            </div>
            <div>
              <dt>Registered name</dt>
              <dd>{partner.name}</dd>
            </div>
            <div>
              <dt>Partner since</dt>
              <dd>{partner.partnerSince ? formatDate(partner.partnerSince) : <span className="faint">—</span>}</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>
                {formatDateTime(partner.createdAt)}
                {partner.createdBy ? ` by ${partner.createdBy.name}` : ''}
              </dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd className="m-prewrap">{partner.notes || <span className="faint">—</span>}</dd>
            </div>
          </dl>
        </div>
      )}

      {editing && (
        <PartnerForm
          partner={partner}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {removing && (
        <Modal
          title={`Remove ${brand} from partners?`}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button className="btn" onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={removePartner}>
                Remove from partners
              </button>
            </>
          }
        >
          <p>
            {brand} stops appearing under Sales › Partners. The supplier record, its purchase
            orders and bills stay exactly as they are, and so do its catalogues and price lists —
            adding it back as a partner brings them back.
          </p>
          <p className="muted">To delete a single catalogue or link, remove that card instead.</p>
        </Modal>
      )}

      {resourceModal && (
        <ResourceModal
          partnerId={partner.id}
          resource={resourceModal.resource}
          kind={resourceModal.kind}
          onClose={() => setResourceModal(null)}
          onSaved={() => {
            setResourceModal(null);
            void load();
          }}
        />
      )}

      {importingItems && (
        <ImportModal
          entity="items"
          label={importingItems.label}
          columns={importingItems.columns}
          onClose={() => setImportingItems(null)}
          onImported={() => {
            setPriceReload((r) => r + 1);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ── One resource ─────────────────────────────────────────────────────────────

function ResourceCard({
  resource,
  mayEdit,
  onModify,
}: {
  resource: Resource;
  mayEdit: boolean;
  onModify: () => void;
}) {
  const toast = useToast();
  const today = todayKey();
  const until = resource.validUntil?.slice(0, 10) ?? null;
  const expired = until !== null && until < today;
  const href = safeHref(resource.url);

  const validity =
    resource.validFrom || resource.validUntil
      ? `Valid ${resource.validFrom ? formatDate(resource.validFrom) : 'from issue'} – ${
          resource.validUntil ? formatDate(resource.validUntil) : 'until replaced'
        }`
      : null;

  return (
    <article className={`card m-resource${resource.isActive ? '' : ' inactive'}`}>
      <div className="m-resource-head">
        <StatusBadge status={resource.kind} extra={KIND_TONES} label={KIND_LABEL[resource.kind]} />
        {expired && <StatusBadge status="EXPIRED" />}
        {!resource.isActive && <StatusBadge status="INACTIVE" extra={{ INACTIVE: '' }} />}
      </div>
      <h4 className="m-resource-title">{resource.title}</h4>
      {resource.description && <p className="m-resource-desc">{resource.description}</p>}
      {validity && <p className="m-resource-meta">{validity}</p>}
      {resource.attachment && (
        <p className="m-resource-meta">
          {resource.attachment.fileName} · {readableSize(resource.attachment.size)} · added{' '}
          {formatDate(resource.attachment.uploadedAt)}
        </p>
      )}
      {href && <p className="m-resource-meta">{hostOf(href)}</p>}
      <div className="m-resource-actions">
        {resource.attachment && (
          <button
            className="btn btn-sm"
            onClick={async () => {
              if (!(await openAttachment(resource.attachment!))) toast('error', 'That file could not be opened');
            }}
          >
            Open file
          </button>
        )}
        {href && (
          <a className="btn btn-sm" href={href} target="_blank" rel="noopener noreferrer">
            Open link ↗
          </a>
        )}
        {mayEdit && (
          <button className="btn btn-sm btn-ghost" onClick={onModify}>
            Modify
          </button>
        )}
      </div>
    </article>
  );
}

// ── Add / modify a resource ──────────────────────────────────────────────────

function ResourceModal({
  partnerId,
  resource,
  kind,
  onClose,
  onSaved,
}: {
  partnerId: string;
  resource: Resource | null;
  kind: ResourceKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<File | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [form, setForm] = useState({
    kind: resource?.kind ?? kind,
    title: resource?.title ?? '',
    description: resource?.description ?? '',
    url: resource?.url ?? '',
    validFrom: resource?.validFrom?.slice(0, 10) ?? '',
    validUntil: resource?.validUntil?.slice(0, 10) ?? '',
    isActive: resource?.isActive ?? true,
  });

  const keepsFile = !!resource?.attachment && !removeFile;
  const hasSource = form.url.trim() !== '' || !!file || keepsFile;
  const urlLooksWrong = form.url.trim() !== '' && !/^https?:\/\//i.test(form.url.trim());

  async function save() {
    if (!hasSource) {
      setError(new Error('Attach a file or give a link'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('kind', form.kind);
      body.set('title', form.title);
      body.set('description', form.description);
      body.set('url', form.url.trim());
      body.set('validFrom', form.validFrom);
      body.set('validUntil', form.validUntil);
      body.set('isActive', String(form.isActive));
      if (file) body.set('file', file);
      if (resource && removeFile && !file) body.set('removeFile', 'true');
      if (resource) await api.patch(`/partners/${partnerId}/resources/${resource.id}`, body);
      else await api.post(`/partners/${partnerId}/resources`, body);
      toast('ok', `${form.title} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!resource) return;
    setBusy(true);
    try {
      await api.del(`/partners/${partnerId}/resources/${resource.id}`);
      toast('ok', `${resource.title} removed`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={resource ? `Modify ${resource.title}` : `Add ${KIND_LABEL[kind].toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          {resource && can('gops.partners.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.title.trim().length < 2 || !hasSource || urlLooksWrong}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Kind">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ResourceKind })}>
            {(Object.keys(KIND_LABEL) as ResourceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" required>
          <input
            value={form.title}
            autoFocus
            placeholder="2026 compressor catalogue"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field
        label="Link"
        hint="http:// or https:// — opens in a new tab"
        error={urlLooksWrong ? 'Links must start with http:// or https://' : null}
      >
        <input
          type="url"
          value={form.url}
          placeholder="https://"
          onChange={(e) => setForm({ ...form, url: e.target.value })}
        />
      </Field>
      <Field
        label="File"
        hint={
          resource?.attachment && !removeFile
            ? `Current: ${resource.attachment.fileName} — choosing a new file replaces it`
            : 'PDF, spreadsheet, document or image'
        }
      >
        <input
          type="file"
          accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.png,.jpg,.jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      {resource?.attachment && !file && (
        <Checkbox checked={removeFile} onChange={setRemoveFile} label="Remove the current file" />
      )}
      {form.kind === 'PRICE_LIST' && (
        <div className="grid grid-2">
          <Field label="Valid from">
            <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </Field>
          <Field label="Valid until" hint="Blank until it is replaced">
            <input
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
            />
          </Field>
        </div>
      )}
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive resource stays on the page, dimmed, and out of the counts"
      />
    </Modal>
  );
}
