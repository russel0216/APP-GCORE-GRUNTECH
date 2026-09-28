import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, dayKeyOf, isDayKey, parseDay, todayLocal } from '../../lib/day';
import { lineAmount, quotationTotals, type LineMargin } from '../../lib/quotationMath';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { Checkbox, ErrorBox, Field, Loading, Modal, StatusBadge, formatDate, formatDateTime, formatMoney, useToast } from '../../components/ui';
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
  modifies its DRAFT revision. Everything is typed in place — the header in two
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
  probability: string;
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
type CostingOption = { id: string; number: string; title: string };

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

function blankLine(): Line {
  return {
    key: nextKey(),
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
    customer: null,
    contactId: '',
    siteId: '',
    subject: '',
    ownerId: myId,
    notes: '',
    dueDate: addDays(today, 30),
    expectedClosing: addDays(today, 30),
    probability: '50',
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
            customer: { id: q.customer.id, name: q.customer.name },
            contactId: q.contact?.id ?? '',
            siteId: q.site?.id ?? '',
            subject: q.subject,
            ownerId: q.owner.id,
            notes: draft.notes ?? '',
            dueDate: addDays(issued, draft.validityDays),
            expectedClosing: q.expectedClosing?.slice(0, 10) ?? '',
            probability: String(q.probability),
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
          setLines(draft.items.length ? draft.items.map(fromItem) : [blankLine()]);
          linesTouched.current = draft.items.length > 0;
        }
      })
      .catch((err) => live && setLoadError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id]);

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
        if (!vatTouched.current) setHeader((h) => ({ ...h, vatRate: p.vatRate }));
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
        if (src.items.length) setLines(src.items.map(fromItem));
        setDuplicateOf(src.revision > 0 ? `${q.number} R${src.revision}` : q.number);
      })
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [editing, preset, today]);

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

  async function fillFromCosting() {
    if (!header.costingId) return;
    const hasLines = lines.some((l) => !isBlank(l));
    if (hasLines && !window.confirm('Replace the lines in the table with the costing’s scope of work?')) return;
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

  function addLine(after?: string) {
    const fresh = blankLine();
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
    const added = items.map(fromItem);
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
  const groups = [...new Set(lines.map((l) => l.group.trim()).filter(Boolean))];

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
    const prob = Number(header.probability);
    if (!Number.isInteger(prob) || prob < 0 || prob > 100) flag('probability', 'A whole number from 0 to 100', 'qe-probability');

    if (priced.length === 0) flag('lines', 'Add at least one line', lines[0] ? lineField(lines[0].key, 'title') : 'qe-add-line');
    for (const l of priced) {
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
          probability: Number(header.probability),
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
        probability: Number(header.probability),
        expectedClosing: header.expectedClosing || null,
        contactId: header.contactId || null,
        siteId: header.siteId || null,
        ...(moved ? { outcome: header.outcome } : {}),
        ...(moved && header.outcome === 'LOST' ? { lostReason: header.lostReason.trim() } : {}),
      });
      setDirty(false);
      toast('ok', `Saved ${quotation!.number}`);
      navigate(`/g-ops/quotations/${quotation!.id}`);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm('Leave without saving? What you typed here will be lost.')) return;
    setDirty(false);
    if (editing) navigate(`/g-ops/quotations/${id}`);
    else if (location.key !== 'default') navigate(-1);
    else navigate('/g-ops/quotations');
  }

  // ── What to draw ──────────────────────────────────────────────────────────
  if (loading) return <Loading />;
  if (editing && !quotation) return <ErrorBox error={loadError ?? new Error('Quotation not found')} />;
  if (editing && quotation && (!quotation.canEdit || !quotation.canSeeCost || !revision)) {
    return (
      <div className="card">
        <h3 className="card-title">{quotation.number} cannot be modified here</h3>
        <p className="muted">
          {!quotation.canEdit
            ? 'Only the author can edit this quotation (or someone who may edit every quotation).'
            : !revision
              ? 'None of its revisions is a draft. An approved, pending or superseded revision is what the customer was sent — raise a new revision on the quotation to change it.'
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

  // SCORO's Tax dropdown: the company's rate and 0%, plus a draft's own snapshot.
  const taxOptions = [...new Set([companyRate, 0, header.vatRate])].sort((a, b) => b - a);
  const pctLabel = (r: number) => `${Number((r * 100).toFixed(2))}%`;

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

        <div className="qe-header qe-rows">
          <div className="qe-col">
            <Static label="Quote No.">
              {editing ? (
                <span className="mono">
                  {quotation!.number}
                  {revision!.revision > 0 ? ` R${revision!.revision}` : ''}
                </span>
              ) : (
                <>
                  <span className="mono">{preview?.number ?? '…'}</span>{' '}
                  <span className="faint">— assigned when saved</span>
                </>
              )}
            </Static>
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
            <Field label="Probability %" error={errors.probability} hint="Your own read — the weighted pipeline multiplies by it">
              <input
                id="qe-probability"
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                value={header.probability}
                onChange={(e) => set('probability', e.target.value)}
              />
            </Field>
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
                return (
                  <tr key={l.key} id={`line-${n}`}>
                    <td className="qe-col-move">
                      <div className="qe-move">
                        <span className="mono faint">{n}</span>
                        <button
                          type="button"
                          id={lineField(l.key, 'up')}
                          className="btn btn-sm btn-icon btn-ghost"
                          aria-label={`Move line ${n} up`}
                          disabled={i === 0}
                          onClick={() => moveLine(l.key, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          id={lineField(l.key, 'down')}
                          className="btn btn-sm btn-icon btn-ghost"
                          aria-label={`Move line ${n} down`}
                          disabled={last}
                          onClick={() => moveLine(l.key, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                    <td>
                      <input
                        aria-label={`Line ${n} group`}
                        list="qe-groups"
                        value={l.group}
                        onChange={(e) => updateLine(l.key, { group: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        id={lineField(l.key, 'title')}
                        className="qe-title"
                        aria-label={`Line ${n} product`}
                        placeholder="Product"
                        value={l.title}
                        aria-invalid={err('title') ? true : undefined}
                        aria-describedby={err('title') ? `${lineField(l.key, 'title')}-error` : undefined}
                        onChange={(e) => updateLine(l.key, { title: e.target.value })}
                      />
                      <textarea
                        aria-label={`Line ${n} description`}
                        placeholder="Description"
                        rows={2}
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
                    <td>
                      <button
                        type="button"
                        id={lineField(l.key, 'remove')}
                        className="btn btn-sm btn-icon btn-ghost"
                        aria-label={`Remove line ${n}`}
                        onClick={() => removeLine(l.key)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <datalist id="qe-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        {/* SCORO's buttons under the lines. */}
        <div className="row qe-line-actions">
          <button type="button" id="qe-add-line" className="btn btn-sm" onClick={() => addLine()}>
            + Add row
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAppendOpen(true)}>
            + Append quote
          </button>
          {header.costingId && (
            <button type="button" className="btn btn-sm" onClick={() => void fillFromCosting()}>
              Fill from costing
            </button>
          )}
        </div>
        <p className="faint sales-hint">
          Enter on the last line’s price adds a line. Empty lines are left out when you save. A group
          prints as a heading over its lines.
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
                      {taxOptions.map((r) => (
                        <option key={r} value={String(r)}>
                          {pctLabel(r)}
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
              0% is for a zero-rated sale — a PEZA or BOI-registered customer, or an export.
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

        <div className="row qe-foot">
          <button type="button" className="btn" onClick={cancel} disabled={busy}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Save quotation'}
          </button>
        </div>
      </section>

      {appendOpen && (
        <AppendQuoteModal excludeId={quotation?.id} onClose={() => setAppendOpen(false)} onPick={appendLines} />
      )}
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
 * SCORO's "Append quote": pick another quotation and its newest revision's
 * lines are added under these. The search is the quotation list's own, so it
 * finds only what this person may read, and a line's cost comes along only
 * where the server sends it to them.
 */
function AppendQuoteModal({
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
        .get<{ rows: QuotationListRow[] }>(`/quotations${qs({ search: text.trim() || undefined, pageSize: 12 })}`)
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
    <Modal
      title="Append quote"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <ErrorBox error={error} />
      <Field label="Find a quotation" hint="By number, name or client. Its newest revision’s lines are added under yours.">
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
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
    </Modal>
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
