import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, dayKeyOf, isDayKey, parseDay, todayLocal } from '../../lib/day';
import { lineAmount, quotationTotals, type LineMargin } from '../../lib/quotationMath';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { Checkbox, ErrorBox, Field, Loading, StatusBadge, formatDate, formatDateTime, formatMoney, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import {
  CostPanelBlock,
  NEXT_OUTCOMES,
  OUTCOMES,
  QUOTATION_OUTCOME_TONES,
  type Item,
  type QuotationDetail,
  type Revision,
} from './Quotations';

/*
  SCORO's "Modify quote details", as a page rather than a dialog.

  `/g-ops/quotations/new` writes a new quotation and `/g-ops/quotations/:id/edit`
  modifies its DRAFT revision — or, when no revision is a draft, the
  quotation's own details (number, name, contact, site, closing date, status)
  while the sent revision's lines stay as they were sent. No dialog anywhere:
  appending another quote, confirming a replace and leaving unsaved all happen
  in the page. Everything is typed in place — the header in two
  columns, then the lines table with an empty row to start in, then the totals
  and the cost panel — and one Save sends it all:

    new  → POST /quotations with the header AND the lines: the number, the
           quotation, its lines and their totals in ONE transaction.
    edit → PUT …/lines (every line replaced atomically), then the revision's
           and the quotation's own PATCHes for the header.

  The figures beside the lines are computed here, live, by lib/quotationMath —
  a mirror of the server's `quotationTotals`, pinned equal to it by
  verify-sales — so what the page shows before saving is what gets stored.
*/

type ProviderKind = 'none' | 'user' | 'supplier';

interface Line {
  /** Client-side identity for React and for field ids; never sent. */
  key: string;
  /** A subheading: its title is the heading; no quantity, price or cost. */
  isHeading: boolean;
  /** SCORO's group — "Gruntech Installation", "Trading" — printed as a heading where it changes. */
  group: string;
  title: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  unitCost: string;
  providerKind: ProviderKind;
  provider: { id: string; name: string } | null;
  costNote: string;
}

interface Header {
  /** The quote number — the suggested next one, or typed by hand. */
  number: string;
  customer: CustomerRef | null;
  contactId: string;
  siteId: string;
  subject: string;
  ownerId: string;
  /** SCORO's "Comment" — the revision's notes, printed under Notes. */
  notes: string;
  /** SCORO's "Due date": the day the offer lapses, stored as validity days. */
  dueDate: string;
  expectedClosing: string;
  leadId: string;
  costingId: string;
  prNumber: string;
  delivery: string;
  paymentTerms: string;
  terms: string;
  vatInclusive: boolean;
  /** SCORO's Tax dropdown: the company's rate, or 0% for a zero-rated sale. */
  vatRate: number;
  /** SCORO's "Hide total": the PDF prints the lines without the totals. */
  hideTotal: boolean;
  discountPct: string;
  /** SCORO's Status on the Modify page (edit only); applied on Save through the same move rules. */
  outcome: string;
  lostReason: string;
}

interface Preview {
  number: string;
  /** The author's latest quotation — what the suggestion follows on from. */
  lastNumber: string | null;
  taxOptions: TaxOption[];
  employeeNo: string | null;
  linked: boolean;
  usesEmployeeDigits: boolean;
  vatRate: number;
  currency: string;
}

interface LeadForQuote {
  id: string;
  number?: string;
  companyName: string;
  description: string | null;
  contactPerson: string | null;
  expectedClosing: string | null;
  customer: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  costings: { id: string; number: string; title: string; status: string }[];
}

interface CostingLine {
  title: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

type Option = { id: string; name: string };
type TaxOption = { rate: number; label: string };

/** What /quotations/suggest offers as a product is typed. */
interface ProductSuggestion {
  title: string;
  description: string;
  unit: string;
  unitPrice: number | null;
  /** Only where the server decided this viewer may see it. */
  unitCost?: number | null;
  source: 'history' | 'item';
  uses: number;
  lastNumber?: string;
  itemCode?: string;
}

/** The shape the API takes for a quote number. */
const NUMBER_RX = /^[A-Za-z0-9][A-Za-z0-9\-/_.]{0,39}$/;
type CostingOption = { id: string; number: string; title: string };

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

function blankLine(isHeading = false): Line {
  return {
    key: nextKey(),
    isHeading,
    group: '',
    title: '',
    description: '',
    quantity: '1',
    unit: 'lot',
    unitPrice: '',
    unitCost: '',
    providerKind: 'none',
    provider: null,
    costNote: '',
  };
}

/** Nothing typed — the starter row, or one added and left empty. Not saved. */
function isBlank(l: Line): boolean {
  if (l.isHeading) return !l.title.trim();
  return (
    !l.group.trim() &&
    !l.title.trim() &&
    !l.description.trim() &&
    l.unitPrice.trim() === '' &&
    l.unitCost.trim() === '' &&
    !l.costNote.trim() &&
    !l.provider
  );
}

function fromItem(i: Item): Line {
  return {
    key: nextKey(),
    isHeading: !!i.isHeading,
    group: i.group ?? '',
    title: i.title ?? '',
    description: i.description ?? '',
    quantity: String(i.quantity),
    unit: i.unit,
    unitPrice: String(i.unitPrice),
    unitCost: i.unitCost == null ? '' : String(i.unitCost),
    providerKind: i.providerUserId ? 'user' : i.providerSupplierId ? 'supplier' : 'none',
    provider: i.providerUser
      ? { id: i.providerUser.id, name: i.providerUser.name }
      : i.providerSupplier
        ? { id: i.providerSupplier.id, name: i.providerSupplier.name }
        : null,
    costNote: i.costNote ?? '',
  };
}

/** Saved lines as the table edits them — groups, subheadings and all. */
function linesFromItems(items: Item[]): Line[] {
  return items.map(fromItem);
}

function fromCostingLine(c: CostingLine): Line {
  return { ...blankLine(), title: c.title, description: c.description, quantity: String(c.quantity), unit: c.unit, unitPrice: String(c.unitPrice) };
}

/** A typed number for the live figures: nothing, nonsense or below zero counts as 0. */
const figure = (s: string) => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 0;
};
const numberOk = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0;
const daysBetween = (from: string, to: string) => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
/** A line's amount with the tax on — SCORO's grey figure under Amount. Shown, never stored. */
const withTax = (amount: number, rate: number) => Math.round(amount * (1 + rate) * 100) / 100;

/** The mirror's view of a line — the same fields the server's arithmetic reads. */
function moneyOf(l: Line) {
  if (l.isHeading) return { amount: 0, costAmount: null, providerUserId: null, providerSupplierId: null, isHeading: true };
  const qty = figure(l.quantity);
  return {
    amount: lineAmount(qty, figure(l.unitPrice)),
    costAmount: l.unitCost.trim() === '' ? null : lineAmount(qty, figure(l.unitCost)),
    providerUserId: l.providerKind === 'user' ? (l.provider?.id ?? null) : null,
    providerSupplierId: l.providerKind === 'supplier' ? (l.provider?.id ?? null) : null,
  };
}

/** A line as the API's itemSchema takes it. */
function linePayload(l: Line) {
  if (l.isHeading) {
    return { isHeading: true, title: l.title.trim(), description: '', quantity: 0, unit: 'lot', unitPrice: 0, unitCost: null };
  }
  return {
    group: l.group.trim() || null,
    title: l.title.trim() || null,
    description: l.description,
    quantity: Number(l.quantity),
    unit: l.unit.trim() || 'lot',
    unitPrice: Number(l.unitPrice),
    unitCost: l.unitCost.trim() === '' ? null : Number(l.unitCost),
    providerUserId: l.providerKind === 'user' ? (l.provider?.id ?? null) : null,
    providerSupplierId: l.providerKind === 'supplier' ? (l.provider?.id ?? null) : null,
    costNote: l.costNote.trim() || null,
  };
}

const lineField = (key: string, field: string) => `qe-line-${key}-${field}`;

export function QuotationEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const { me, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const preset = useMemo(
    () => ({
      leadId: params.get('leadId') ?? '',
      costingId: params.get('costingId') ?? '',
      customerId: params.get('customerId') ?? '',
      // SCORO's "Duplicate": the quotation, and which of its revisions, to copy.
      duplicate: params.get('duplicate') ?? '',
      revision: params.get('revision') ?? '',
    }),
    // The preset is read once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const today = todayLocal();
  const myId = me?.user.id ?? '';
  const canPickAuthor = !editing && can('gops.quotations.edit_all');

  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [quotation, setQuotation] = useState<QuotationDetail | null>(null);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [authors, setAuthors] = useState<Option[]>([]);
  const [contacts, setContacts] = useState<Option[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [customerTerms, setCustomerTerms] = useState<string | null>(null);
  const [leads, setLeads] = useState<{ id: string; companyName: string }[]>([]);
  const [lead, setLead] = useState<LeadForQuote | null>(null);
  const [costings, setCostings] = useState<CostingOption[]>([]);
  const [pinnedCostings, setPinnedCostings] = useState<CostingOption[]>([]);
  /** The contact to pick once the customer's contacts arrive, by name (a lead's). */
  const [wantContact, setWantContact] = useState<string | null>(null);

  const [header, setHeader] = useState<Header>(() => ({
    number: '',
    customer: null,
    contactId: '',
    siteId: '',
    subject: '',
    ownerId: myId,
    notes: '',
    dueDate: addDays(today, 30),
    expectedClosing: addDays(today, 30),
    leadId: preset.leadId,
    costingId: preset.costingId,
    prNumber: '',
    delivery: '',
    paymentTerms: '',
    terms: '',
    vatInclusive: false,
    vatRate: 0.12,
    hideTotal: false,
    discountPct: '0',
    outcome: 'OPEN',
    lostReason: '',
  }));
  /** Once somebody picks a tax rate, the company rate arriving late never replaces it. */
  const vatTouched = useRef(false);
  /** Once somebody types a number, the suggestion never replaces it. */
  const numberTouched = useRef(false);
  /** Why the typed number cannot be used — said beside the box as it is typed. */
  const [numberProblem, setNumberProblem] = useState<string | null>(null);
  /** In-page confirmations, where a dialog used to ask. */
  const [confirmFill, setConfirmFill] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** Bumped to re-read the quotation (after raising a new revision here). */
  const [reloadKey, setReloadKey] = useState(0);
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [appendOpen, setAppendOpen] = useState(false);
  /** Once somebody has typed in the table, a costing never replaces it unasked. */
  const linesTouched = useRef(false);
  const termsTouched = useRef(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Ids to focus once the table has redrawn (see the layout effect below). */
  const focusAfterRender = useRef<string[] | null>(null);

  const issueDate = editing && revision ? dayKeyOf(new Date(revision.createdAt)) : today;
  const showCost = editing ? !!quotation?.canSeeCost : true;
  const vatRate = header.vatRate;
  /** What the Tax dropdown offers: the company's rate, and 0% (see checkVatRate on the server). */
  const companyRate = editing ? (quotation?.companyVatRate ?? revision?.vatRate ?? 0.12) : (preview?.vatRate ?? 0.12);
  const currency = me?.company?.currency ?? preview?.currency ?? 'PHP';

  /** A change somebody made — as opposed to a prefill — marks the page dirty. */
  const set = useCallback(<K extends keyof Header>(key: K, value: Header[K]) => {
    setHeader((h) => ({ ...h, [key]: value }));
    setDirty(true);
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  }, []);

  // ── Loading an existing quotation (edit) ──────────────────────────────────
  useEffect(() => {
    if (!id) return;
    // A superseded load (the id changed, or React re-ran the effect) must not
    // land after the current one: its lines would replace the table under
    // somebody already typing in it.
    let live = true;
    api
      .get<QuotationDetail>(`/quotations/${id}`)
      .then((q) => {
        if (!live) return;
        setQuotation(q);
        const draft = q.revisions.find((r) => r.status === 'DRAFT') ?? null;
        setRevision(draft);
        if (draft) {
          const issued = dayKeyOf(new Date(draft.createdAt));
          termsTouched.current = true;
          setHeader({
            number: q.number,
            customer: { id: q.customer.id, name: q.customer.name },
            contactId: q.contact?.id ?? '',
            siteId: q.site?.id ?? '',
            subject: q.subject,
            ownerId: q.owner.id,
            notes: draft.notes ?? '',
            dueDate: addDays(issued, draft.validityDays),
            expectedClosing: q.expectedClosing?.slice(0, 10) ?? '',
            leadId: q.lead?.id ?? '',
            costingId: draft.costing?.id ?? '',
            prNumber: draft.prNumber ?? '',
            delivery: draft.delivery ?? '',
            paymentTerms: draft.paymentTerms ?? '',
            terms: draft.terms ?? '',
            vatInclusive: draft.vatInclusive,
            vatRate: draft.vatRate,
            hideTotal: draft.hideTotal ?? false,
            discountPct: String(draft.discountPct ?? 0),
            outcome: q.outcome,
            lostReason: q.lostReason ?? '',
          });
          vatTouched.current = true;
          if (draft.costing) setPinnedCostings([draft.costing]);
          setLines(draft.items.length ? linesFromItems(draft.items) : [blankLine()]);
          linesTouched.current = draft.items.length > 0;
        }
      })
      .catch((err) => live && setLoadError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, reloadKey]);

  // ── Lookups ───────────────────────────────────────────────────────────────
  useEffect(() => {
    api.get<CostingOption[]>('/costings/lookup').then(setCostings).catch(() => {});
    if (editing) return;
    /*
      Leads still open, so a quotation can say which enquiry it answers — the
      link is what writes the quotation's outcome back onto the lead.
    */
    api
      .get<{ rows: { id: string; companyName: string }[] }>(
        '/leads?pageSize=200&status=NEW,CONTACTED,QUALIFIED,SITE_VISIT,COSTING,QUOTATION_CREATED,NEGOTIATION',
      )
      .then((r) => setLeads(r.rows))
      .catch(() => {});
    if (canPickAuthor) {
      api
        .get<Option[]>(`/users/lookup${qs({ holding: 'gops.quotations.create' })}`)
        .then(setAuthors)
        .catch(() => setAuthors([]));
    }
  }, [editing, canPickAuthor]);

  /*
    The number this quotation will get, before it is saved — with the chosen
    author's own employee digits. Read-only: nothing is consumed until Save.
  */
  useEffect(() => {
    if (editing) return;
    api
      .get<Preview>(`/quotations/next-number${qs({ ownerId: header.ownerId && header.ownerId !== myId ? header.ownerId : undefined })}`)
      .then((p) => {
        setPreview(p);
        setHeader((h) => ({
          ...h,
          ...(vatTouched.current ? {} : { vatRate: p.vatRate }),
          ...(numberTouched.current ? {} : { number: p.number }),
        }));
      })
      .catch(() => setPreview(null));
  }, [editing, header.ownerId, myId]);

  /** Take what the lead already knows. Only fills; every field stays editable. */
  const adoptLead = useCallback(async (leadId: string) => {
    if (!leadId) {
      setLead(null);
      return;
    }
    try {
      const l = await api.get<LeadForQuote>(`/leads/${leadId}`);
      setLead(l);
      const firstLine = (l.description ?? '').split('\n')[0].trim();
      setHeader((h) => ({
        ...h,
        leadId,
        customer: l.customer ? { id: l.customer.id, name: l.customer.name } : h.customer,
        contactId: l.customer && l.customer.id !== h.customer?.id ? '' : h.contactId,
        siteId: l.customer ? (l.site?.id ?? '') : h.siteId,
        subject: h.subject || firstLine.slice(0, 120),
        expectedClosing: l.expectedClosing ? l.expectedClosing.slice(0, 10) : h.expectedClosing,
        costingId: h.costingId || l.costings[0]?.id || '',
      }));
      setWantContact(l.contactPerson);
      setPinnedCostings((list) => [...l.costings, ...list]);
    } catch (err) {
      setError(err);
    }
  }, []);

  // ── The preset: ?leadId, ?costingId, ?customerId (create only) ────────────
  useEffect(() => {
    if (editing) return;
    if (preset.leadId) {
      void adoptLead(preset.leadId);
    } else if (preset.costingId) {
      /*
        Raised from a costing: the costing names the customer, the site, the
        subject and — when it was started from a lead — the lead, which then
        fills in the rest.
      */
      api
        .get<{
          id: string;
          number: string;
          title: string;
          customer: { id: string; name: string } | null;
          site: { id: string; name: string } | null;
          lead: { id: string } | null;
        }>(`/costings/${preset.costingId}`)
        .then((c) => {
          setPinnedCostings((list) => [{ id: c.id, number: c.number, title: c.title }, ...list]);
          setHeader((h) => ({
            ...h,
            costingId: c.id,
            customer: h.customer ?? (c.customer ? { id: c.customer.id, name: c.customer.name } : null),
            siteId: h.siteId || c.site?.id || '',
            subject: h.subject || c.title,
          }));
          if (c.lead) void adoptLead(c.lead.id);
        })
        .catch(() => {});
    }
    if (preset.customerId && !preset.leadId) {
      // The name arrives with the customer's details below.
      setHeader((h) => (h.customer ? h : { ...h, customer: { id: preset.customerId, name: '' } }));
    }
  }, [editing, preset, adoptLead]);

  /*
    ── Duplicate (?duplicate=&revision=, create only) ─────────────────────────
    SCORO's most-used button: a new quotation starting from an old one. It
    copies the client, contact, site, name, terms and lines — cost included
    only where the server sent it to this viewer — and leaves the PR number,
    the enquiry and the costing to be set, because those belong to the new
    request. Nothing is written, and no number used, until Save.
  */
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  useEffect(() => {
    if (editing || !preset.duplicate) return;
    let live = true;
    api
      .get<QuotationDetail>(`/quotations/${preset.duplicate}`)
      .then((q) => {
        if (!live) return;
        const src = q.revisions.find((r) => r.id === preset.revision) ?? q.revisions[0];
        if (!src) return;
        termsTouched.current = true;
        linesTouched.current = src.items.length > 0;
        setHeader((h) => ({
          ...h,
          customer: { id: q.customer.id, name: q.customer.name },
          contactId: q.contact?.id ?? '',
          siteId: q.site?.id ?? '',
          subject: q.subject,
          notes: src.notes ?? '',
          dueDate: addDays(today, src.validityDays),
          delivery: src.delivery ?? '',
          paymentTerms: src.paymentTerms ?? '',
          terms: src.terms ?? '',
          vatInclusive: src.vatInclusive,
          // A zero-rated quote stays zero-rated; any other takes today's company
          // rate, which is what a new quotation may carry.
          ...(src.vatRate === 0 ? { vatRate: 0 } : {}),
          hideTotal: src.hideTotal ?? false,
          discountPct: String(src.discountPct ?? 0),
        }));
        if (src.vatRate === 0) vatTouched.current = true;
        if (src.items.length) setLines(linesFromItems(src.items));
        setDuplicateOf(src.revision > 0 ? `${q.number} R${src.revision}` : q.number);
      })
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [editing, preset, today]);

  // ── The number, checked as it is typed ───────────────────────────────────
  const original = editing ? (quotation?.number ?? '') : (preview?.number ?? '');
  useEffect(() => {
    const n = header.number.trim();
    if (!n || n === original) {
      setNumberProblem(null);
      return;
    }
    if (!NUMBER_RX.test(n)) {
      setNumberProblem('Letters, digits and - / _ . only — up to 40 characters');
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ available: boolean; message: string | null }>(
          `/quotations/number-available${qs({ number: n, excludeId: editing ? id : undefined })}`,
        )
        .then((r) => setNumberProblem(r.available ? null : r.message))
        .catch(() => setNumberProblem(null));
    }, 350);
    return () => clearTimeout(t);
  }, [header.number, original, editing, id]);

  // ── The chosen customer's contacts, sites and payment terms ───────────────
  const customerId = header.customer?.id ?? '';
  useEffect(() => {
    if (!customerId) {
      setContacts([]);
      setSites([]);
      setCustomerTerms(null);
      return;
    }
    api
      .get<{ name: string; paymentTerms: string | null; contacts: Option[]; sites: Option[] }>(`/customers/${customerId}`)
      .then((c) => {
        setContacts(c.contacts);
        setSites(c.sites);
        setCustomerTerms(c.paymentTerms);
        setHeader((h) => {
          if (h.customer?.id !== customerId) return h;
          const next = { ...h };
          if (!h.customer.name) next.customer = { id: customerId, name: c.name };
          // Contacts arrive primary first, so the fallback is the primary one.
          // Only on a new quotation: an existing one keeps the contact it has.
          if (!editing && !h.contactId) {
            const byName = wantContact
              ? c.contacts.find((x) => x.name.trim().toLowerCase() === wantContact.trim().toLowerCase())
              : undefined;
            next.contactId = (byName ?? c.contacts[0])?.id ?? '';
          }
          // "Payment terms default to the customer's own" — until somebody types some.
          if (!termsTouched.current) next.paymentTerms = c.paymentTerms ?? '';
          return next;
        });
      })
      .catch(() => {});
  }, [customerId, wantContact, editing]);

  /*
    A costing chosen before anything was typed in the table previews its
    scope of work as the lines — the same mapping "Fill from costing" writes.
    Once the table has been touched, only the button replaces it.
  */
  const loadCostingLines = useCallback(async (costingId: string) => {
    const rows = await api.get<CostingLine[]>(`/quotations/costing-lines${qs({ costingId })}`);
    return rows.map(fromCostingLine);
  }, []);

  useEffect(() => {
    if (editing || !header.costingId || linesTouched.current) return;
    let live = true;
    loadCostingLines(header.costingId)
      .then((filled) => {
        if (!live || linesTouched.current || filled.length === 0) return;
        setLines((prev) => (prev.every(isBlank) ? filled : prev));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [editing, header.costingId, loadCostingLines]);

  async function fillFromCosting(confirmed = false) {
    if (!header.costingId) return;
    const hasLines = lines.some((l) => !isBlank(l));
    if (hasLines && !confirmed) {
      setConfirmFill(true);
      return;
    }
    setConfirmFill(false);
    try {
      const filled = await loadCostingLines(header.costingId);
      if (!filled.length) {
        setError(new Error('That costing has no scope of work yet — add sections to it first'));
        return;
      }
      setLines(filled);
      linesTouched.current = true;
      setDirty(true);
    } catch (err) {
      setError(err);
    }
  }

  // ── Lines ─────────────────────────────────────────────────────────────────
  function updateLine(key: string, patch: Partial<Line>) {
    linesTouched.current = true;
    setDirty(true);
    setLines((list) => list.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setErrors((e) => {
      const stale = Object.keys(patch).map((f) => lineField(key, f));
      if (!stale.some((k) => k in e) && !('lines' in e)) return e;
      const next = { ...e };
      for (const k of stale) delete next[k];
      delete next.lines;
      return next;
    });
  }

  function addLine(after?: string, heading = false) {
    const fresh = blankLine(heading);
    linesTouched.current = true;
    setLines((list) => {
      if (!after) return [...list, fresh];
      const at = list.findIndex((l) => l.key === after);
      return [...list.slice(0, at + 1), fresh, ...list.slice(at + 1)];
    });
    setFocusKey(fresh.key);
  }

  function removeLine(key: string) {
    linesTouched.current = true;
    setDirty(true);
    const at = lines.findIndex((l) => l.key === key);
    const rest = lines.filter((l) => l.key !== key);
    const next = rest.length ? rest : [blankLine()];
    setLines(next);
    // The button pressed goes with its row. Keep the keyboard in the table: the
    // line that took its place, else the one above, else the fresh empty row.
    const neighbour = next[Math.min(Math.max(at, 0), next.length - 1)];
    focusAfterRender.current = rest.length ? [lineField(neighbour.key, 'remove')] : [lineField(neighbour.key, 'title')];
  }

  /**
   * SCORO's "Append quote": another quotation's lines, added under these —
   * the starter row and any other empty line give way to them. The keyboard
   * lands on the first line appended.
   */
  function appendLines(items: Item[], from: string) {
    setAppendOpen(false);
    if (!items.length) {
      setError(new Error(`${from} has no lines to append`));
      return;
    }
    const added = linesFromItems(items);
    linesTouched.current = true;
    setDirty(true);
    setLines((list) => [...list.filter((l) => !isBlank(l)), ...added]);
    focusAfterRender.current = [lineField(added[0].key, 'title')];
    toast('ok', `Appended ${added.length} line${added.length === 1 ? '' : 's'} from ${from}`);
  }

  function moveLine(key: string, by: -1 | 1) {
    linesTouched.current = true;
    setDirty(true);
    setLines((list) => {
      const at = list.findIndex((l) => l.key === key);
      const to = at + by;
      if (at < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });
    // Keep the keyboard on the moved line: the button pressed, or — when the
    // line reached the top or bottom and that button is now disabled — its twin.
    focusAfterRender.current = [lineField(key, by < 0 ? 'up' : 'down'), lineField(key, by < 0 ? 'down' : 'up')];
  }

  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(lineField(focusKey, 'title'))?.focus();
    setFocusKey(null);
  }, [focusKey, lines]);

  /*
    Where the keyboard goes once a reorder or a removal has been drawn — the
    first of these ids that exists and is enabled. Run after the commit rather
    than in a frame callback: a moved row's DOM is re-inserted, which drops
    focus to <body>, and a frame callback is not guaranteed to run after it.
  */
  useLayoutEffect(() => {
    const ids = focusAfterRender.current;
    if (!ids) return;
    focusAfterRender.current = null;
    for (const fid of ids) {
      const el = document.getElementById(fid) as HTMLButtonElement | HTMLInputElement | null;
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  }, [lines]);

  // `#line-3` from the detail page's per-line Modify lands on that line.
  const hashDone = useRef(false);
  useEffect(() => {
    if (hashDone.current || loading) return;
    const m = /^#line-(\d+)$/.exec(location.hash);
    if (!m) return;
    const line = lines[Number(m[1]) - 1];
    if (!line) return;
    hashDone.current = true;
    document.getElementById(lineField(line.key, 'title'))?.focus();
  }, [location.hash, lines, loading]);

  /** A product picked from what was quoted before: its words, unit and price come with it. */
  function pickProduct(l: Line, sg: ProductSuggestion) {
    updateLine(l.key, {
      title: sg.title,
      description: l.description.trim() ? l.description : sg.description,
      unit: sg.unit || l.unit,
      unitPrice: sg.unitPrice != null ? String(sg.unitPrice) : l.unitPrice,
      ...(sg.unitCost != null && l.unitCost.trim() === '' ? { unitCost: String(sg.unitCost) } : {}),
    });
    focusAfterRender.current = [lineField(l.key, 'quantity')];
  }

  // ── Live figures (the server's arithmetic, mirrored) ──────────────────────
  const priced = useMemo(() => lines.filter((l) => !isBlank(l)), [lines]);
  const totals = useMemo(
    () =>
      quotationTotals({
        lines: priced.map(moneyOf),
        discountPct: figure(header.discountPct),
        vatRate,
        vatInclusive: header.vatInclusive,
      }),
    [priced, header.discountPct, header.vatInclusive, vatRate],
  );
  const marginByKey = new Map<string, LineMargin>(priced.map((l, i) => [l.key, totals.lines[i]]));

  // Leaving with unsaved work asks first — the browser's own prompt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ── Validation and save ───────────────────────────────────────────────────
  function validate(): { errors: Record<string, string>; first: string | null } {
    const found: Record<string, string> = {};
    const order: string[] = [];
    const flag = (key: string, message: string, fieldId = key) => {
      if (found[key]) return;
      found[key] = message;
      order.push(fieldId);
    };
    if (!header.customer) flag('customer', 'Choose the client, or add them as a new customer', 'qe-customer');
    if (header.subject.trim().length < 2) flag('subject', 'Give the quotation a name', 'qe-subject');
    if (!isDayKey(header.dueDate) || daysBetween(issueDate, header.dueDate) < 1) {
      flag('dueDate', 'The due date must be after the date of issue', 'qe-dueDate');
    }
    if (!header.number.trim()) flag('number', 'Give the quotation a number', 'qe-number');
    else if (numberProblem) flag('number', numberProblem, 'qe-number');

    if (!priced.some((l) => !l.isHeading)) flag('lines', 'Add at least one line', lines[0] ? lineField(lines[0].key, 'title') : 'qe-add-line');
    for (const l of priced) {
      if (l.isHeading) continue;
      if (!l.title.trim() && !l.description.trim()) {
        flag(lineField(l.key, 'title'), 'Give the line a product title or a description');
      }
      if (!numberOk(l.quantity)) flag(lineField(l.key, 'quantity'), 'Quantity must be zero or more');
      if (!numberOk(l.unitPrice)) flag(lineField(l.key, 'unitPrice'), 'Price must be zero or more');
      if (l.unitCost.trim() !== '' && !numberOk(l.unitCost)) flag(lineField(l.key, 'unitCost'), 'Cost must be zero or more');
    }
    const disc = Number(header.discountPct || 0);
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) flag('discountPct', 'A discount from 0 to 100%', 'qe-discount');
    if (editing && header.outcome === 'LOST' && header.outcome !== quotation?.outcome && !header.lostReason.trim()) {
      flag('lostReason', 'Say why it was lost — Sales Analytics reports the reasons', 'qe-lostReason');
    }
    return { errors: found, first: order[0] ?? null };
  }

  async function save() {
    const check = validate();
    setErrors(check.errors);
    if (check.first) {
      setError(new Error('Some fields need attention — they are marked below.'));
      document.getElementById(check.first)?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const validityDays = daysBetween(issueDate, header.dueDate);
    const payloadLines = priced.map(linePayload);
    try {
      if (!editing) {
        const created = await api.post<{ id: string; number: string }>('/quotations', {
          customerId: header.customer!.id,
          contactId: header.contactId || null,
          siteId: header.siteId || null,
          leadId: header.leadId || null,
          costingId: header.costingId || null,
          subject: header.subject.trim(),
          // Sent only when it is not the suggestion: otherwise the next free
          // number is issued as the quotation is saved.
          ...(header.number.trim() && header.number.trim() !== preview?.number ? { number: header.number.trim() } : {}),
          expectedClosing: header.expectedClosing || null,
          validityDays,
          notes: header.notes || null,
          terms: header.terms || null,
          prNumber: header.prNumber || null,
          delivery: header.delivery || null,
          paymentTerms: header.paymentTerms || null,
          vatInclusive: header.vatInclusive,
          vatRate: header.vatRate,
          hideTotal: header.hideTotal,
          discountPct: Number(header.discountPct || 0),
          ...(canPickAuthor && header.ownerId && header.ownerId !== myId ? { ownerId: header.ownerId } : {}),
          lines: payloadLines,
        });
        setDirty(false);
        toast('ok', `Created ${created.number}`);
        navigate(`/g-ops/quotations/${created.id}`, { replace: true });
        // Save sits at the foot of a long page; the quotation opens at its top.
        window.scrollTo(0, 0);
        return;
      }

      // Edit: the lines (atomic, and safe to repeat), then the header.
      const base = `/quotations/${quotation!.id}/revisions/${revision!.id}`;
      await api.put(`${base}/lines`, { lines: payloadLines });
      await api.patch(base, {
        costingId: header.costingId || null,
        validityDays,
        notes: header.notes || null,
        terms: header.terms || null,
        prNumber: header.prNumber || null,
        delivery: header.delivery || null,
        paymentTerms: header.paymentTerms || null,
        vatInclusive: header.vatInclusive,
        vatRate: header.vatRate,
        hideTotal: header.hideTotal,
        discountPct: Number(header.discountPct || 0),
      });
      // The status last: the server checks the same move rules as the
      // quotation page and the board, and a refusal leaves the lines saved.
      const moved = header.outcome !== quotation!.outcome;
      await api.patch(`/quotations/${quotation!.id}`, {
        subject: header.subject.trim(),
        ...(header.number.trim() !== quotation!.number ? { number: header.number.trim() } : {}),
        expectedClosing: header.expectedClosing || null,
        contactId: header.contactId || null,
        siteId: header.siteId || null,
        ...(moved ? { outcome: header.outcome } : {}),
        ...(moved && header.outcome === 'LOST' ? { lostReason: header.lostReason.trim() } : {}),
      });
      setDirty(false);
      toast('ok', `Saved ${header.number.trim() || quotation!.number}`);
      navigate(`/g-ops/quotations/${quotation!.id}`);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  function cancel() {
    if (dirty && !leaving) {
      setLeaving(true);
      return;
    }
    leave();
  }

  function leave() {
    setLeaving(false);
    setDirty(false);
    if (editing) navigate(`/g-ops/quotations/${id}`);
    else if (location.key !== 'default') navigate(-1);
    else navigate('/g-ops/quotations');
  }

  // ── What to draw ──────────────────────────────────────────────────────────
  if (loading) return <Loading />;
  if (editing && !quotation) return <ErrorBox error={loadError ?? new Error('Quotation not found')} />;
  if (editing && quotation && quotation.canEdit && !revision) {
    return <QuotationDetailsEditor quotation={quotation} onRevisionRaised={() => setReloadKey((k) => k + 1)} />;
  }
  if (editing && quotation && (!quotation.canEdit || !quotation.canSeeCost)) {
    return (
      <div className="card">
        <h3 className="card-title">{quotation.number} cannot be modified here</h3>
        <p className="muted">
          {!quotation.canEdit
            ? 'Only the author can edit this quotation (or someone who may edit every quotation).'
            : 'Its cost is not visible to you, so its lines cannot be rewritten here.'}
        </p>
        <Link className="btn" to={`/g-ops/quotations/${quotation.id}`}>
          Back to {quotation.number}
        </Link>
      </div>
    );
  }

  const costingOptions = merge(pinnedCostings, costings);
  const leadOptions =
    lead && !leads.some((l) => l.id === lead.id) ? [{ id: lead.id, companyName: lead.companyName }, ...leads] : leads;
  const authorOptions = me && !authors.some((a) => a.id === myId) ? [{ id: myId, name: me.user.name }, ...authors] : authors;
  const ownerName = editing ? quotation!.owner.name : (authorOptions.find((a) => a.id === header.ownerId)?.name ?? me?.user.name ?? '');
  const leadWithoutCustomer = !editing && !!lead && !lead.customer;
  const validityDays = isDayKey(header.dueDate) ? daysBetween(issueDate, header.dueDate) : null;

  // SCORO's Status on the Modify page: where the quotation may go from here,
  // by the same rules as the quotation page and the board. Won needs an
  // approved revision; one that became a project stays won.
  const jobs = quotation ? quotation.revisions.flatMap((r) => r.jobs ?? []) : [];
  const hasApproved = !!quotation?.revisions.some((r) => r.status === 'APPROVED');
  const current = quotation?.outcome ?? 'OPEN';
  const statusOptions = [
    current,
    ...(current === 'WON' && jobs.length > 0 ? [] : (NEXT_OUTCOMES[current] ?? [])),
  ].map((value) => ({
    value,
    label: `${OUTCOMES.find((o) => o.value === value)?.label ?? value}${value === 'WON' && value !== current && !hasApproved ? ' (needs an approved revision)' : ''}`,
    disabled: value === 'WON' && value !== current && !hasApproved,
  }));
  const wonMove = quotation?.statusHistory ? [...quotation.statusHistory].reverse().find((c) => c.to === 'WON') : undefined;
  const confirmedAt = wonMove?.at ?? quotation?.decidedAt ?? null;

  // The Tax dropdown: the company rate, 8%, 6% (Government) and 0% — and a
  // draft's own snapshot, should Settings have moved since.
  const pctLabel = (r: number) => `${Number((r * 100).toFixed(2))}%`;
  const serverTax: TaxOption[] = (editing ? quotation?.taxOptions : preview?.taxOptions) ?? [
    { rate: companyRate, label: pctLabel(companyRate) },
    { rate: 0, label: '0% (zero-rated)' },
  ];
  const taxOptions: TaxOption[] = serverTax.some((o) => Math.abs(o.rate - header.vatRate) < 0.00005)
    ? serverTax
    : [...serverTax, { rate: header.vatRate, label: `${pctLabel(header.vatRate)} (this draft)` }];

  return (
    <div className="qe">
      <div className="breadcrumb">
        <Link to="/g-ops/quotations">Quotations</Link>
        <span className="sep">›</span>
        {editing ? (
          <>
            <Link to={`/g-ops/quotations/${quotation!.id}`} className="mono">
              {quotation!.number} R{revision!.revision}
            </Link>
            <span className="sep">›</span>
            <span>Modify</span>
          </>
        ) : (
          <span>New</span>
        )}
      </div>

      <ErrorBox error={error} />
      {duplicateOf && (
        <div className="alert info">
          Copied from <span className="mono">{duplicateOf}</span> — client, terms and lines. Set the PR
          Number, the enquiry and the costing for this request, then Save; the new number is issued then.
        </div>
      )}
      {leadWithoutCustomer && (
        <div className="alert warn">
          This lead is not linked to a customer yet. Choose the client below, or open the lead, Modify,
          and pick or add the company first.
        </div>
      )}
      {!editing && preview && preview.usesEmployeeDigits && !preview.linked && (
        <div className="alert info">
          {header.ownerId === myId ? 'Your account is' : 'That author’s account is'} not linked to an
          employee record, so this number carries 000 where the employee digits would be. HR can link it
          under G-HR › Employees.
        </div>
      )}

      {/*
        One card, as SCORO lays out "Modify quote details": the header in two
        columns with the labels beside the values, the custom fields, the
        lines, the totals beside the cost panel, and Back / Save at both ends.
      */}
      <section className="card qe-card" aria-labelledby="qe-title">
        <div className="qe-head">
          <div>
            <h1 id="qe-title" className="qe-heading">
              {editing ? 'Modify quote details' : 'New quotation'}
            </h1>
            <p className="faint qe-lead">
              {editing
                ? `Draft revision ${revision!.revision}. Nothing changes until you save.`
                : 'Nothing is saved — and no number is used — until you press Save.'}
            </p>
          </div>
          <div className="row qe-actions">
            <button type="button" className="btn" onClick={cancel} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {leaving && <LeaveBar onLeave={leave} onStay={() => setLeaving(false)} />}

        <div className="qe-header qe-rows">
          <div className="qe-col">
            <NumberField
              value={header.number}
              error={errors.number ?? numberProblem ?? undefined}
              suggestion={editing ? null : (preview?.number ?? null)}
              lastNumber={editing ? null : (preview?.lastNumber ?? null)}
              revision={editing && revision!.revision > 0 ? revision!.revision : null}
              editing={editing}
              onChange={(v) => {
                numberTouched.current = true;
                set('number', v);
              }}
            />
            <Static label="Date of issue">{formatDate(parseDay(issueDate))}</Static>

            {/* SCORO puts the contact beside the client, on the same line. */}
            {editing ? (
              <Static label="Client">
                <div className="qe-client">
                  <Link to={`/g-ops/customers/${quotation!.customer.id}`}>{quotation!.customer.name}</Link>
                  <ContactSelect contacts={contacts} value={header.contactId} onChange={(v) => set('contactId', v)} />
                </div>
              </Static>
            ) : (
              <LooseField label="Client" htmlFor="qe-customer" required error={errors.customer}>
                <div className="qe-client">
                  <CustomerPicker
                    inputId="qe-customer"
                    value={header.customer}
                    invalid={!!errors.customer}
                    describedBy={errors.customer ? 'qe-customer-error' : undefined}
                    autoFocus={!preset.leadId && !preset.costingId && !preset.customerId && !preset.duplicate}
                    onError={setError}
                    onChange={(c) => {
                      setHeader((h) => ({ ...h, customer: c, contactId: '', siteId: '' }));
                      setWantContact(null);
                      setDirty(true);
                      setErrors((e) => {
                        const next = { ...e };
                        delete next.customer;
                        return next;
                      });
                    }}
                  />
                  <ContactSelect contacts={contacts} value={header.contactId} onChange={(v) => set('contactId', v)} />
                </div>
              </LooseField>
            )}
            {sites.length > 0 && (
              <Field label="Site">
                <select value={header.siteId} onChange={(e) => set('siteId', e.target.value)}>
                  <option value="">— none —</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Quote name" required error={errors.subject}>
              <input
                id="qe-subject"
                value={header.subject}
                autoFocus={!!(preset.leadId || preset.costingId || preset.customerId || preset.duplicate) && !editing}
                onChange={(e) => set('subject', e.target.value)}
              />
            </Field>
            {canPickAuthor ? (
              <Field label="Author" hint="Their employee digits go into the number, and only they (or a manager) can edit it">
                <select value={header.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
                  {authorOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Static label="Author">{ownerName}</Static>
            )}
            <Field label="Comment" hint="Printed under Notes on the quotation">
              <textarea rows={3} value={header.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>

          <div className="qe-col">
            <Field
              label="Due date"
              required
              error={errors.dueDate}
              hint={validityDays && validityDays > 0 ? `Valid for ${validityDays} day${validityDays === 1 ? '' : 's'} from the date of issue` : undefined}
            >
              <input
                id="qe-dueDate"
                type="date"
                min={addDays(issueDate, 1)}
                value={header.dueDate}
                onChange={(e) => set('dueDate', e.target.value)}
              />
            </Field>
            <Field label="Estimated closing date" hint="When you expect the decision — the pipeline forecast reads it">
              <input
                type="date"
                value={header.expectedClosing}
                onChange={(e) => set('expectedClosing', e.target.value)}
              />
            </Field>
            <Static label="Currency">{currency}</Static>
            {editing ? (
              <Field
                label="Status"
                hint={
                  statusOptions.length > 1
                    ? 'Applied when you save — it moves the lead too, so the pipeline stays honest'
                    : current === 'WON' && jobs.length > 0
                      ? 'It became a project, so it stays won'
                      : undefined
                }
              >
                <select
                  id="qe-outcome"
                  value={header.outcome}
                  disabled={statusOptions.length <= 1}
                  onChange={(e) => set('outcome', e.target.value)}
                >
                  {statusOptions.map((o) => (
                    <option key={o.value} value={o.value} disabled={o.disabled}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Static label="Status">
                <StatusBadge status="OPEN" extra={QUOTATION_OUTCOME_TONES} />{' '}
                <span className="faint">— it moves once the quotation is saved</span>
              </Static>
            )}
            {editing && header.outcome === 'LOST' && current !== 'LOST' && (
              <Field label="Why it was lost" required error={errors.lostReason} hint="Sales Analytics reports the reasons">
                <textarea
                  id="qe-lostReason"
                  rows={2}
                  value={header.lostReason}
                  onChange={(e) => set('lostReason', e.target.value)}
                />
              </Field>
            )}
            {editing && current === 'WON' && (
              <Static label="Date confirmed">
                {confirmedAt ? formatDateTime(confirmedAt) : <span className="faint">—</span>}
                {wonMove?.by ? <span className="faint"> · {wonMove.by.name}</span> : null}
              </Static>
            )}
            {editing && (
              <Static label="Project">
                {jobs.length > 0 ? (
                  jobs.map((j, i) => (
                    <span key={j.id}>
                      {i > 0 && ', '}
                      <Link to={`/g-ops/projects/${j.id}`} className="mono">
                        {j.number}
                      </Link>{' '}
                      {j.name}
                    </span>
                  ))
                ) : (
                  <span className="faint">Created from the quotation page once it is won</span>
                )}
              </Static>
            )}
            {editing ? (
              <Static label="Enquiry">
                {quotation!.lead ? (
                  <Link to={`/g-ops/leads/${quotation!.lead.id}`}>
                    {quotation!.lead.number} — {quotation!.lead.companyName}
                  </Link>
                ) : (
                  <span className="faint">—</span>
                )}
              </Static>
            ) : (
              leadOptions.length > 0 && (
                <Field
                  label="Enquiry"
                  hint="Keeps the lead's status in step with this quotation — and fills in the rest"
                >
                  <select
                    value={header.leadId}
                    onChange={(e) => {
                      const leadId = e.target.value;
                      set('leadId', leadId);
                      void adoptLead(leadId);
                    }}
                  >
                    <option value="">— none —</option>
                    {leadOptions.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.companyName}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            )}
            <Field label="Costing" hint="Links the pricing to what you estimated; its scope of work can fill the lines">
              <select value={header.costingId} onChange={(e) => set('costingId', e.target.value)}>
                <option value="">— none yet —</option>
                {costingOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number} — {c.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        {/* SCORO's custom fields: PR Number beside Delivery, Payment Terms under. */}
        <div className="qe-terms qe-rows">
          <Field label="PR Number" hint="The customer's purchase request reference">
            <input value={header.prNumber} onChange={(e) => set('prNumber', e.target.value)} />
          </Field>
          <Field label="Delivery" hint="e.g. 4 to 6 weeks upon receipt of PO">
            <input value={header.delivery} onChange={(e) => set('delivery', e.target.value)} />
          </Field>
          <Field
            label="Payment Terms"
            hint={customerTerms ? `The customer's usual: ${customerTerms}` : undefined}
          >
            <input
              value={header.paymentTerms}
              onChange={(e) => {
                termsTouched.current = true;
                set('paymentTerms', e.target.value);
              }}
            />
          </Field>
          <Field label="Terms and conditions">
            <textarea rows={3} value={header.terms} onChange={(e) => set('terms', e.target.value)} />
          </Field>
        </div>

        {/* ── Lines ── */}
        <h2 className="visually-hidden">Lines</h2>
        {errors.lines && (
          <div className="alert error" role="alert">
            {errors.lines}
          </div>
        )}

        {/*
          SCORO's "Modify quote" lines: one row per line — group, the product
          over its description, quantity beside unit, price, amount (the grey
          with-tax figure under it), and, for whoever may see cost, the cost and
          who carries it, then the margin, on the same row. The product and its
          description take whatever width the fixed columns leave. A subheading
          is one wide row.
        */}
        <div className="table-wrap qe-table-wrap">
          <table className={`data qe-lines${showCost ? '' : ' qe-lines-nocost'}`}>
            <thead>
              <tr>
                <th className="qe-col-move">
                  <span className="visually-hidden">Order</span>
                </th>
                <th className="qe-col-group">Group</th>
                <th className="qe-col-product">Product | Description</th>
                <th className="qe-col-qty">Quantity | Unit</th>
                <th className="qe-col-price right">Unit price</th>
                <th className="qe-col-amount right">Amount</th>
                {showCost && <th className="qe-col-cost">Cost and provider info</th>}
                {showCost && <th className="qe-col-margin right">Margin</th>}
                <th className="qe-col-remove">
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const n = i + 1;
                const m = marginByKey.get(l.key);
                const last = i === lines.length - 1;
                const err = (f: string) => errors[lineField(l.key, f)];
                const amount = m?.amount ?? 0;
                const what = l.isHeading ? `subheading ${n}` : `line ${n}`;
                const moveCell = (
                  <td className="qe-col-move">
                    <div className="qe-move">
                      <span className="mono faint">{n}</span>
                      <button
                        type="button"
                        id={lineField(l.key, 'up')}
                        className="btn btn-sm btn-icon btn-ghost"
                        aria-label={`Move ${what} up`}
                        disabled={i === 0}
                        onClick={() => moveLine(l.key, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        id={lineField(l.key, 'down')}
                        className="btn btn-sm btn-icon btn-ghost"
                        aria-label={`Move ${what} down`}
                        disabled={last}
                        onClick={() => moveLine(l.key, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </td>
                );
                const removeCell = (
                  <td className="qe-col-remove">
                    <button
                      type="button"
                      id={lineField(l.key, 'remove')}
                      className="btn btn-sm btn-icon btn-ghost"
                      aria-label={`Remove ${what}`}
                      onClick={() => removeLine(l.key)}
                    >
                      ✕
                    </button>
                  </td>
                );
                if (l.isHeading) {
                  return (
                    <tr key={l.key} id={`line-${n}`} className="qe-line-heading">
                      {moveCell}
                      <td colSpan={showCost ? 7 : 5}>
                        <input
                          id={lineField(l.key, 'title')}
                          className="qe-heading-input"
                          aria-label={`Subheading ${n}`}
                          placeholder="Subheading — e.g. General Requirements"
                          value={l.title}
                          aria-invalid={err('title') ? true : undefined}
                          onChange={(e) => updateLine(l.key, { title: e.target.value })}
                        />
                        <CellError message={err('title')} />
                      </td>
                      {removeCell}
                    </tr>
                  );
                }
                return (
                  <tr key={l.key} id={`line-${n}`}>
                    {moveCell}
                    <td>
                      <input
                        aria-label={`Line ${n} group`}
                        list="qe-groups"
                        value={l.group}
                        onChange={(e) => updateLine(l.key, { group: e.target.value })}
                      />
                    </td>
                    <td>
                      <ProductInput
                        id={lineField(l.key, 'title')}
                        label={`Line ${n} product`}
                        value={l.title}
                        invalid={!!err('title')}
                        describedBy={err('title') ? `${lineField(l.key, 'title')}-error` : undefined}
                        onChange={(v) => updateLine(l.key, { title: v })}
                        onPick={(sg) => pickProduct(l, sg)}
                      />
                      <textarea
                        aria-label={`Line ${n} description`}
                        placeholder="Description"
                        rows={Math.min(10, Math.max(2, l.description.split('\n').length + 1))}
                        value={l.description}
                        onChange={(e) => updateLine(l.key, { description: e.target.value })}
                      />
                      <CellError id={`${lineField(l.key, 'title')}-error`} message={err('title')} />
                    </td>
                    <td>
                      {/* Quantity and unit side by side, as SCORO sets them. */}
                      <div className="qe-qty">
                        <input
                          id={lineField(l.key, 'quantity')}
                          className="qe-num"
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          aria-label={`Line ${n} quantity`}
                          value={l.quantity}
                          aria-invalid={err('quantity') ? true : undefined}
                          onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                        />
                        <input
                          aria-label={`Line ${n} unit`}
                          placeholder="lot"
                          value={l.unit}
                          onChange={(e) => updateLine(l.key, { unit: e.target.value })}
                        />
                      </div>
                      <CellError message={err('quantity')} />
                    </td>
                    <td>
                      <input
                        id={lineField(l.key, 'unitPrice')}
                        className="qe-num"
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        aria-label={`Line ${n} unit price`}
                        value={l.unitPrice}
                        aria-invalid={err('unitPrice') ? true : undefined}
                        onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                          // Enter on the last row's price starts the next line.
                          if (e.key === 'Enter' && last) {
                            e.preventDefault();
                            addLine(l.key);
                          }
                        }}
                      />
                      <CellError message={err('unitPrice')} />
                    </td>
                    <td className="right mono">
                      {formatMoney(amount, currency)}
                      {/* SCORO's grey figure under the amount: the same line with the tax on. */}
                      {!header.vatInclusive && header.vatRate > 0 && amount > 0 && (
                        <div className="faint qe-with-vat" title={`With ${pctLabel(header.vatRate)} VAT`}>
                          <span className="visually-hidden">With VAT: </span>
                          {formatMoney(withTax(amount, header.vatRate), currency)}
                        </div>
                      )}
                    </td>
                    {showCost && (
                      <td>
                        <CostCell
                          line={l}
                          n={n}
                          costError={err('unitCost')}
                          amount={m?.costAmount ?? null}
                          currency={currency}
                          onChange={(patch) => updateLine(l.key, patch)}
                        />
                      </td>
                    )}
                    {showCost && (
                      <td className="right mono">
                        {m?.margin == null ? (
                          <span className="faint">—</span>
                        ) : (
                          <>
                            <div className={m.margin < 0 ? 'quote-negative' : undefined}>{formatMoney(m.margin, currency)}</div>
                            <div className="faint">{pct(m.marginPct)}</div>
                          </>
                        )}
                      </td>
                    )}
                    {removeCell}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="qe-groups">
          {[...new Set(lines.map((l) => l.group.trim()).filter(Boolean))].map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        {/* SCORO's buttons under the lines, in SCORO's order. */}
        <div className="row qe-line-actions">
          <button type="button" className="btn btn-sm" onClick={() => addLine(undefined, true)}>
            + Add subheading
          </button>
          <button type="button" id="qe-add-line" className="btn btn-sm" onClick={() => addLine()}>
            + Add row
          </button>
          <button type="button" className="btn btn-sm" aria-expanded={appendOpen} onClick={() => setAppendOpen((v) => !v)}>
            + Append quote
          </button>
          {header.costingId &&
            (confirmFill ? (
              <span className="row qe-confirm" role="group" aria-label="Replace the lines">
                <span>Replace the lines with the costing’s scope of work?</span>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void fillFromCosting(true)}>
                  Replace
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setConfirmFill(false)}>
                  Keep mine
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void fillFromCosting()}>
                Fill from costing
              </button>
            ))}
        </div>
        {appendOpen && <AppendQuotePanel excludeId={quotation?.id} onClose={() => setAppendOpen(false)} onPick={appendLines} />}
        <p className="faint sales-hint">
          Type a product and pick from what was quoted before. Enter on the last line’s price adds a line; empty lines are
          left out when you save. A group prints as a heading over its lines, and so does a subheading.
          {showCost ? ' Cost, provider and margin are internal — never printed.' : ''}
        </p>

        {/* ── Totals and the cost panel ── */}
        <div className={`quote-summary${showCost && priced.length > 0 ? '' : ' quote-summary-single'}`}>
          <div>
            <dl className="quote-totals" aria-label="Totals">
              <div>
                <dt>Subtotal</dt>
                <dd className="mono">{formatMoney(totals.subtotal, currency)}</dd>
              </div>
              <div>
                <dt>
                  <label className="quote-discount" htmlFor="qe-discount">
                    Discount
                    <input
                      id="qe-discount"
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      inputMode="decimal"
                      value={header.discountPct}
                      aria-invalid={errors.discountPct ? true : undefined}
                      onChange={(e) => set('discountPct', e.target.value)}
                    />
                    %
                  </label>
                </dt>
                <dd className="mono">
                  {totals.discountAmount > 0 ? `−${formatMoney(totals.discountAmount, currency)}` : formatMoney(0, currency)}
                </dd>
              </div>
              <div>
                <dt>Sum without tax</dt>
                <dd className="mono">{formatMoney(totals.netOfTax, currency)}</dd>
              </div>
              <div>
                <dt>
                  <label className="quote-discount" htmlFor="qe-tax">
                    {header.vatInclusive ? 'Tax included' : 'Tax'}
                    <select
                      id="qe-tax"
                      value={String(header.vatRate)}
                      aria-describedby="qe-tax-hint"
                      onChange={(e) => {
                        vatTouched.current = true;
                        set('vatRate', Number(e.target.value));
                      }}
                    >
                      {taxOptions.map((o) => (
                        <option key={o.rate} value={String(o.rate)}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </dt>
                <dd className="mono">{formatMoney(totals.vatAmount, currency)}</dd>
              </div>
              <div className="quote-totals-grand">
                <dt>Total</dt>
                <dd className="mono">{formatMoney(totals.total, currency)}</dd>
              </div>
            </dl>
            <p id="qe-tax-hint" className="faint sales-hint">
              6% is for a government client; 0% for a zero-rated sale — a PEZA or BOI-registered customer, or an export.
            </p>
            {errors.discountPct && <CellError message={errors.discountPct} />}
            <Checkbox
              checked={header.vatInclusive}
              onChange={(v) => set('vatInclusive', v)}
              label="Prices are VAT inclusive — the tax is backed out rather than added on"
            />
            <Checkbox
              checked={header.hideTotal}
              onChange={(v) => set('hideTotal', v)}
              label="Hide total — the PDF prints the lines and their prices, without the totals"
            />
          </div>
          {showCost && priced.length > 0 && <CostPanelBlock panel={totals.cost} />}
        </div>

        {leaving && <LeaveBar onLeave={leave} onStay={() => setLeaving(false)} />}
        <div className="row qe-foot">
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Save quotation'}
          </button>
        </div>
      </section>
    </div>
  );
}

function merge<T extends { id: string }>(pinned: T[], list: T[]) {
  const seen = new Set<string>();
  return [...pinned, ...list].filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** A read-only header value, laid out like a field. */
function Static({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field qe-static">
      <span className="qe-static-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** A field around a control that is not a single element (the client picker). */
function LooseField({
  label,
  htmlFor,
  required,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error && (
        <div className="field-error" id={`${htmlFor}-error`}>
          <span aria-hidden="true">⚠</span>
          {error}
        </div>
      )}
    </div>
  );
}

function CellError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <div className="qe-cell-error" id={id}>
      <span aria-hidden="true">⚠</span> {message}
    </div>
  );
}

/**
 * SCORO's "Cost and provider info": two toggles for who carries the line's
 * cost — one of our people (in-house) or a supplier (outsourced); pressing the
 * one that is on clears it — the person or supplier beside them, then the
 * notes and the unit cost. The line's cost (quantity × unit cost) sits under.
 */
function CostCell({
  line,
  n,
  costError,
  amount,
  currency,
  onChange,
}: {
  line: Line;
  n: number;
  costError?: string;
  amount: number | null;
  currency: string;
  onChange: (patch: Partial<Line>) => void;
}) {
  const kinds: [Exclude<ProviderKind, 'none'>, 'person' | 'building', string][] = [
    ['user', 'person', 'In-house — one of our people'],
    ['supplier', 'building', 'Outsourced — a supplier'],
  ];
  return (
    <div className="qe-cost">
      <div className="qe-provider">
        <div className="qe-kind" role="group" aria-label={`Line ${n}: who carries the cost`}>
          {kinds.map(([value, icon, label]) => {
            const on = line.providerKind === value;
            return (
              <button
                key={value}
                type="button"
                className={`btn btn-sm btn-icon qe-kind-btn${on ? ' is-on' : ''}`}
                aria-pressed={on}
                aria-label={label}
                title={label}
                onClick={() => onChange({ providerKind: on ? 'none' : value, provider: null })}
              >
                <Icon name={icon} size={16} />
              </button>
            );
          })}
        </div>
        {line.providerKind !== 'none' ? (
          <ProviderLookup
            key={line.providerKind}
            kind={line.providerKind}
            label={`Line ${n} ${line.providerKind === 'user' ? 'in-house person' : 'supplier'}`}
            value={line.provider}
            onChange={(provider) => onChange({ provider })}
          />
        ) : (
          <span className="faint qe-kind-none">No provider named</span>
        )}
      </div>
      <div className="qe-cost-row">
        <input
          aria-label={`Line ${n} cost notes`}
          placeholder="Notes"
          value={line.costNote}
          onChange={(e) => onChange({ costNote: e.target.value })}
        />
        <input
          id={lineField(line.key, 'unitCost')}
          className="qe-num"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder="Unit cost"
          aria-label={`Line ${n} unit cost`}
          aria-invalid={costError ? true : undefined}
          value={line.unitCost}
          onChange={(e) => onChange({ unitCost: e.target.value })}
        />
      </div>
      <div className="mono faint qe-cost-sum">{amount == null ? 'not costed' : formatMoney(amount, currency)}</div>
      <CellError message={costError} />
    </div>
  );
}

/** The contact person, beside the client as SCORO has it. Nothing until the client has contacts. */
function ContactSelect({ contacts, value, onChange }: { contacts: Option[]; value: string; onChange: (v: string) => void }) {
  if (contacts.length === 0) return null;
  return (
    <select aria-label="Contact person" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— contact person —</option>
      {contacts.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

interface QuotationListRow {
  id: string;
  number: string;
  subject: string;
  customer: { name: string };
  latest: { revision: number; total: number } | null;
}

/**
 * SCORO's "Append quote", in the page: find another quotation and its newest
 * revision's lines are added under these. The search is the quotation list's
 * own, so it finds only what this person may read, and a line's cost comes
 * along only where the server sends it to them.
 */
function AppendQuotePanel({
  excludeId,
  onClose,
  onPick,
}: {
  excludeId?: string;
  onClose: () => void;
  onPick: (items: Item[], from: string) => void;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<QuotationListRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<{ rows: QuotationListRow[] }>(`/quotations${qs({ search: text.trim() || undefined, pageSize: 8 })}`)
        .then((r) => setRows(r.rows.filter((q) => q.id !== excludeId)))
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [text, excludeId]);

  async function pick(id: string) {
    setBusy(true);
    setError(null);
    try {
      const q = await api.get<QuotationDetail>(`/quotations/${id}`);
      const src = q.revisions[0];
      onPick(src?.items ?? [], src && src.revision > 0 ? `${q.number} R${src.revision}` : q.number);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section className="qe-append" aria-label="Append quote">
      <div className="row qe-append-head">
        <label htmlFor="qe-append-find" className="qe-append-title">
          Append another quotation’s lines
        </label>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <ErrorBox error={error} />
      <input
        id="qe-append-find"
        autoFocus
        placeholder="Find by number, name or client"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="faint">No quotation matches.</p>
      ) : (
        <ul className="qe-append-list">
          {rows.map((q) => (
            <li key={q.id}>
              <button type="button" className="qe-append-item" disabled={busy} onClick={() => void pick(q.id)}>
                <span className="mono">{q.number}</span>
                <span className="qe-append-name">{q.subject}</span>
                <span className="faint">
                  {q.customer.name}
                  {q.latest ? ` · ${formatMoney(q.latest.total)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Search-as-you-type for who carries a cost. Names come from
 * `/quotations/providers`, which the sales role may read without the supplier
 * master permission.
 */
function ProviderLookup({
  kind,
  label,
  value,
  onChange,
}: {
  kind: 'user' | 'supplier';
  label: string;
  value: { id: string; name: string } | null;
  onChange: (v: { id: string; name: string } | null) => void;
}) {
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; name: string; code?: string; position?: string | null }[]>([]);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A choice made elsewhere shows its name; clearing it leaves the typing alone.
  useEffect(() => {
    if (value) setText(value.name);
  }, [value]);

  useEffect(() => {
    if (!open || value) return;
    const t = setTimeout(() => {
      api
        .get<typeof options>(`/quotations/providers${qs({ kind, q: text.trim() || undefined })}`)
        .then(setOptions)
        .catch(() => setOptions([]));
    }, 200);
    return () => clearTimeout(t);
  }, [kind, text, open, value]);

  function pick(o: { id: string; name: string }) {
    onChange({ id: o.id, name: o.name });
    setText(o.name);
    setOpen(false);
    // Back to the input: the button pressed leaves with the list, and focus
    // would otherwise fall to <body>.
    inputRef.current?.focus();
  }

  return (
    <div
      className="lookup"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        aria-label={label}
        placeholder={kind === 'user' ? 'Choose a person' : 'Choose a supplier'}
        autoComplete="off"
        value={text}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value) onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'ArrowDown') {
            const first = menuRef.current?.querySelector<HTMLElement>('button');
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      />
      {value && (
        <span className="lookup-tick" title="Chosen">
          ✓
        </span>
      )}
      {open && !value && options.length > 0 && (
        <ul className="lookup-menu" ref={menuRef}>
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => pick(o)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                }}
              >
                {o.code ? `${o.code} — ` : ''}
                {o.name}
                {o.position ? ` (${o.position})` : ''}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The quote number: the next free one in the author's series, suggested and
 * already filled in — or typed by hand. A number already used (by another
 * quotation, or by a SCORO quote in the archive) is said beside the box as it
 * is typed, and Save refuses it; "Use the suggested number" puts it back.
 */
function NumberField({
  value,
  error,
  suggestion,
  lastNumber,
  revision,
  editing,
  onChange,
}: {
  value: string;
  error?: string;
  suggestion: string | null;
  lastNumber: string | null;
  revision: number | null;
  editing: boolean;
  onChange: (v: string) => void;
}) {
  const hint = editing
    ? 'Changing it renumbers this quotation; a number already used is refused.'
    : suggestion
      ? `Suggested: the next in your series${lastNumber ? ` after ${lastNumber}` : ''}. Type another if you need to.`
      : 'The next in your series is filled in when it loads.';
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor="qe-number">
        Quote No.
        <span className="req" aria-hidden="true">
          *
        </span>
      </label>
      <div>
        <div className="row qe-number">
          <input
            id="qe-number"
            className="mono"
            value={value}
            maxLength={40}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby="qe-number-hint"
            onChange={(e) => onChange(e.target.value.trim())}
          />
          {revision !== null && <span className="mono faint">R{revision}</span>}
          {!editing && suggestion && value !== suggestion && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(suggestion)}>
              Use {suggestion}
            </button>
          )}
        </div>
        <div className="hint" id="qe-number-hint">
          {hint}
        </div>
        {error && (
          <div className="field-error">
            <span aria-hidden="true">⚠</span>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/** Leaving with unsaved work, asked in the page rather than in a dialog. */
function LeaveBar({ onLeave, onStay }: { onLeave: () => void; onStay: () => void }) {
  return (
    <div className="alert warn row qe-leave" role="alert">
      <span>You have changes that are not saved.</span>
      <button type="button" className="btn btn-sm btn-danger" onClick={onLeave}>
        Leave without saving
      </button>
      <button type="button" className="btn btn-sm" autoFocus onClick={onStay}>
        Keep editing
      </button>
    </div>
  );
}

/**
 * A line's product, with what was quoted before offered as it is typed: past
 * lines (latest price, unit and description, and how often) and items from the
 * item master. Keyboard: ArrowDown reaches the list, arrows move in it, Escape
 * closes it, and focus leaving the box and its list closes it too.
 */
function ProductInput({
  id,
  label,
  value,
  invalid,
  describedBy,
  onChange,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  invalid?: boolean;
  describedBy?: string;
  onChange: (v: string) => void;
  onPick: (sg: ProductSuggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<ProductSuggestion[]>([]);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = value.trim();
    if (!open || term.length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<ProductSuggestion[]>(`/quotations/suggest${qs({ q: term })}`)
        .then((rows) => setMatches(rows.filter((r) => r.title.toUpperCase() !== term.toUpperCase() || r.unitPrice != null)))
        .catch(() => setMatches([]));
    }, 220);
    return () => clearTimeout(t);
  }, [value, open]);

  function choose(sg: ProductSuggestion) {
    onPick(sg);
    setOpen(false);
    setMatches([]);
  }

  const buttons = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];

  return (
    <div
      className="lookup"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        id={id}
        className="qe-title"
        aria-label={label}
        placeholder="Product"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open && matches.length > 0}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
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
          {matches.map((sg, i) => (
            <li key={`${sg.source}-${sg.title}-${i}`}>
              <button
                type="button"
                onClick={() => choose(sg)}
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
                <span className="qe-suggest-name">{sg.title}</span>
                <span className="faint qe-suggest-meta">
                  {sg.unitPrice != null ? `${formatMoney(sg.unitPrice)} / ${sg.unit}` : sg.unit}
                  {sg.source === 'item'
                    ? ` · item ${sg.itemCode ?? ''}`
                    : ` · quoted ${sg.uses}×${sg.lastNumber ? `, last on ${sg.lastNumber}` : ''}`}
                </span>
                {sg.description && <span className="faint qe-suggest-desc">{sg.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Modify, once no revision is a draft: the quotation's own details — number,
 * name, contact, site, closing date and status — on the page, with the sent
 * revision's lines, prices, terms and tax left exactly as they were sent. To
 * change those, a new revision is raised right here and the full editor opens
 * on it.
 */
function QuotationDetailsEditor({ quotation, onRevisionRaised }: { quotation: QuotationDetail; onRevisionRaised: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const latest = quotation.revisions[0] ?? null;
  const [form, setForm] = useState({
    number: quotation.number,
    subject: quotation.subject,
    contactId: quotation.contact?.id ?? '',
    siteId: quotation.site?.id ?? '',
    expectedClosing: quotation.expectedClosing?.slice(0, 10) ?? '',
    outcome: quotation.outcome,
    lostReason: quotation.lostReason ?? '',
  });
  const [contacts, setContacts] = useState<Option[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [numberProblem, setNumberProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ contacts: Option[]; sites: Option[] }>(`/customers/${quotation.customer.id}`)
      .then((c) => {
        setContacts(c.contacts);
        setSites(c.sites);
      })
      .catch(() => {});
  }, [quotation.customer.id]);

  useEffect(() => {
    const n = form.number.trim();
    if (!n || n === quotation.number) {
      setNumberProblem(null);
      return;
    }
    if (!NUMBER_RX.test(n)) {
      setNumberProblem('Letters, digits and - / _ . only — up to 40 characters');
      return;
    }
    const t = setTimeout(() => {
      api
        .get<{ available: boolean; message: string | null }>(`/quotations/number-available${qs({ number: n, excludeId: quotation.id })}`)
        .then((r) => setNumberProblem(r.available ? null : r.message))
        .catch(() => setNumberProblem(null));
    }, 350);
    return () => clearTimeout(t);
  }, [form.number, quotation.id, quotation.number]);

  const jobs = quotation.revisions.flatMap((r) => r.jobs ?? []);
  const hasApproved = quotation.revisions.some((r) => r.status === 'APPROVED');
  const current = quotation.outcome;
  const statusOptions = [current, ...(current === 'WON' && jobs.length > 0 ? [] : (NEXT_OUTCOMES[current] ?? []))].map((value) => ({
    value,
    label: `${OUTCOMES.find((o) => o.value === value)?.label ?? value}${value === 'WON' && value !== current && !hasApproved ? ' (needs an approved revision)' : ''}`,
    disabled: value === 'WON' && value !== current && !hasApproved,
  }));

  async function save() {
    if (!form.number.trim() || numberProblem) {
      setError(new Error(numberProblem ?? 'Give the quotation a number'));
      return;
    }
    if (form.subject.trim().length < 2) {
      setError(new Error('Give the quotation a name'));
      return;
    }
    if (form.outcome === 'LOST' && current !== 'LOST' && !form.lostReason.trim()) {
      setError(new Error('Say why it was lost — Sales Analytics reports the reasons'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const moved = form.outcome !== current;
      await api.patch(`/quotations/${quotation.id}`, {
        ...(form.number.trim() !== quotation.number ? { number: form.number.trim() } : {}),
        subject: form.subject.trim(),
        contactId: form.contactId || null,
        siteId: form.siteId || null,
        expectedClosing: form.expectedClosing || null,
        ...(moved ? { outcome: form.outcome } : {}),
        ...(moved && form.outcome === 'LOST' ? { lostReason: form.lostReason.trim() } : {}),
      });
      toast('ok', `Saved ${form.number.trim()}`);
      navigate(`/g-ops/quotations/${quotation.id}`);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function raiseRevision() {
    setBusy(true);
    try {
      await api.post(`/quotations/${quotation.id}/revisions`);
      toast('ok', 'New revision raised — its lines are ready to change');
      onRevisionRaised();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="qe">
      <div className="breadcrumb">
        <Link to="/g-ops/quotations">Quotations</Link>
        <span className="sep">›</span>
        <Link to={`/g-ops/quotations/${quotation.id}`} className="mono">
          {quotation.number}
        </Link>
        <span className="sep">›</span>
        <span>Modify</span>
      </div>
      <section className="card qe-card" aria-labelledby="qe-details-title">
        <div className="qe-head">
          <div>
            <h1 id="qe-details-title" className="qe-heading">
              Modify quote details
            </h1>
            <p className="faint qe-lead">Nothing changes until you save.</p>
          </div>
          <div className="row qe-actions">
            <Link className="btn" to={`/g-ops/quotations/${quotation.id}`}>
              Back
            </Link>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <ErrorBox error={error} />
        {latest && (
          <div className="alert info row qe-locked">
            <span>
              R{latest.revision} is {latest.status.toLowerCase().replace(/_/g, ' ')}: its lines, prices, terms and tax are
              what the customer was sent, and stay as they are.
            </span>
            {latest.status !== 'PENDING_APPROVAL' && (
              <button type="button" className="btn btn-sm" onClick={() => void raiseRevision()} disabled={busy}>
                Raise a new revision to change them
              </button>
            )}
          </div>
        )}
        <div className="qe-header qe-rows">
          <div className="qe-col">
            <NumberField
              value={form.number}
              error={numberProblem ?? undefined}
              suggestion={null}
              lastNumber={null}
              revision={null}
              editing
              onChange={(v) => setForm((f) => ({ ...f, number: v }))}
            />
            <Static label="Client">
              <Link to={`/g-ops/customers/${quotation.customer.id}`}>{quotation.customer.name}</Link>
            </Static>
            {contacts.length > 0 && (
              <Field label="Contact person">
                <select value={form.contactId} onChange={(e) => setForm((f) => ({ ...f, contactId: e.target.value }))}>
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
                <select value={form.siteId} onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))}>
                  <option value="">— none —</option>
                  {sites.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Quote name" required>
              <input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
            </Field>
          </div>
          <div className="qe-col">
            <Static label="Author">{quotation.owner.name}</Static>
            <Field label="Estimated closing date" hint="When you expect the decision — the pipeline forecast reads it">
              <input
                type="date"
                value={form.expectedClosing}
                onChange={(e) => setForm((f) => ({ ...f, expectedClosing: e.target.value }))}
              />
            </Field>
            <Field label="Status" hint="Applied when you save — it moves the lead too">
              <select
                value={form.outcome}
                disabled={statusOptions.length <= 1}
                onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))}
              >
                {statusOptions.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            {form.outcome === 'LOST' && current !== 'LOST' && (
              <Field label="Why it was lost" required hint="Sales Analytics reports the reasons">
                <textarea rows={2} value={form.lostReason} onChange={(e) => setForm((f) => ({ ...f, lostReason: e.target.value }))} />
              </Field>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
