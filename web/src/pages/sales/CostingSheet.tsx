import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { addDays, todayLocal } from '../../lib/day';
import { costingFigures, lineAmount, lineCodes, planTasks } from '../../lib/costingMath';
import { CustomerPicker, type CustomerRef } from '../../components/CustomerPicker';
import { Checkbox, ErrorBox, Field, Loading, formatMoney, useToast } from '../../components/ui';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import type { CostingDetail } from './CostingDetail';
import { NumberInput } from '../../components/NumberInput';

/*
  The costing sheet — a page, never a dialog. `/g-ops/costing/new` writes a new
  costing and `/g-ops/costing/:id/edit` changes a draft one.

  Everything is typed in place, top to bottom as the estimate prints:

    Costing details      project, customer, location, system / unit, valid until
    Project budgeted cost the six buckets (Contingency the sixth), each a block
                          of rows with its own subtotal; subheadings; paste
                          straight from Excel
    Cost summary          the margin on the price, VAT, grand total — and
                          "set the grand total" to price to a figure
    Scope of work         phases and their tasks on working days (Mon–Fri)
    Terms & Conditions    printed; Internal notes, never printed

  One Save sends it all (POST /costings or PUT /costings/:id/sheet), and the
  server writes it in one transaction. The figures here are lib/costingMath —
  a copy of the server's arithmetic, pinned equal by verify-costing — so what
  the page shows before saving is what is stored.

  What was typed before comes back as you type: a line's name offers past lines
  (with their last unit, price and description) and items from the item
  master; unit, System / Unit, phase and task names offer what has been used
  most; a new sheet starts from your last Terms & Conditions.
*/

interface Category {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive?: boolean;
}

interface SheetLine {
  key: string;
  id?: string;
  categoryId: string;
  itemId: string | null;
  isHeading: boolean;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unitCost: string;
}

interface SheetTask {
  key: string;
  id?: string;
  name: string;
  startDay: string;
  durationDays: string;
}

type Kind = 'MAIN_WORK' | 'TESTING_COMMISSIONING' | 'TURNOVER' | 'OTHER';

interface SheetSection {
  key: string;
  id?: string;
  kind: Kind;
  name: string;
  description: string;
  value: string;
  durationDays: string;
  tasks: SheetTask[];
}

interface Header {
  title: string;
  customer: CustomerRef | null;
  siteId: string;
  leadId: string;
  systemUnit: string;
  validUntil: string;
  /** The margin on the price, in percent as typed ("25" = 25%). */
  marginPct: string;
  vatOn: boolean;
  notes: string;
  terms: string;
}

interface Lists {
  units: string[];
  systemUnits: string[];
  phases: string[];
  tasks: string[];
  terms: string | null;
  companyVatRate: number;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  withPrices: boolean;
  lineCount: number;
  sectionCount: number;
}

interface TemplateFull {
  id: string;
  name: string;
  systemUnit: string | null;
  marginPct: number;
  terms: string | null;
  lines: {
    costCategoryId: string | null;
    isHeading: boolean;
    name: string | null;
    description: string;
    quantity: number;
    unit: string;
    unitCost: number;
    itemId: string | null;
  }[];
  sections: { kind: Kind; name: string; description: string | null; durationDays: number; tasks: { name: string; startDay: number | null; durationDays: number }[] }[];
}

interface Suggestion {
  name: string;
  description: string;
  unit: string;
  unitCost: number | null;
  costCategoryId: string | null;
  itemId: string | null;
  itemCode?: string;
  source: 'history' | 'item';
  uses: number;
  lastNumber?: string;
}

const KINDS: { value: Kind; label: string }[] = [
  { value: 'MAIN_WORK', label: 'Main work' },
  { value: 'TESTING_COMMISSIONING', label: 'Testing & commissioning' },
  { value: 'TURNOVER', label: 'Turnover' },
  { value: 'OTHER', label: 'Other' },
];

let keySeq = 0;
const nextKey = (p: string) => `${p}${++keySeq}`;

const blankLine = (categoryId: string, isHeading = false): SheetLine => ({
  key: nextKey('l'),
  categoryId,
  itemId: null,
  isHeading,
  name: '',
  description: '',
  quantity: isHeading ? '' : '1',
  unit: isHeading ? '' : 'pc',
  unitCost: '',
});

const blankTask = (): SheetTask => ({ key: nextKey('t'), name: '', startDay: '', durationDays: '1' });

const blankSection = (): SheetSection => ({
  key: nextKey('s'),
  kind: 'MAIN_WORK',
  name: '',
  description: '',
  value: '0',
  durationDays: '0',
  tasks: [blankTask()],
});

/** A typed figure as a number: commas, spaces, "PHP" and ₱ are allowed in. */
function figure(s: string): number {
  const n = Number(String(s).replace(/[,\s₱]|PHP/gi, ''));
  return Number.isFinite(n) ? n : 0;
}
const figureOk = (s: string) => s.trim() === '' || (Number.isFinite(Number(s.replace(/[,\s₱]|PHP/gi, ''))) && figure(s) >= 0);
/** A stored fraction as the percent typed in the box — to four places, since the margin is kept to six decimals. */
const percentString = (fraction: number) => String(Number((fraction * 100).toFixed(4)));
/** The margin box: a percentage of the price, between −95 and 95 (at 100% there is no price). */
const marginOk = (s: string) => {
  const v = Number(s.replace(/[,\s%]/g, ''));
  return s.trim() !== '' && Number.isFinite(v) && v > -95 && v < 95;
};
const isBlankLine = (l: SheetLine) => !l.isHeading && !l.name.trim() && !l.description.trim() && !figure(l.unitCost);
const isBlankTask = (t: SheetTask) => !t.name.trim();

/** Rows copied out of Excel: Name, Description, Unit, Qty, Unit cost — tab-separated, one per line. */
function parsePasted(text: string, categoryId: string): SheetLine[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((row) => row.split('\t').map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean))
    .map((cells) => ({
      ...blankLine(categoryId),
      name: cells[0] ?? '',
      description: cells[1] ?? '',
      unit: cells[2] || 'pc',
      quantity: cells[3] ? String(figure(cells[3])) : '1',
      unitCost: cells[4] ? String(figure(cells[4])) : '',
    }));
}

/**
 * Prices the sheet to a grand total: the margin (to the 0.0001% it is stored
 * at) that lands the estimate nearest the figure. A margin is a share of the
 * price, so the estimate may miss the target by a centavo or two; the toast
 * says where it landed. (The markup rule used a discount to make up the
 * difference — there is no discount on a costing any more, 2026-10-09.)
 */
function priceTo(
  target: number,
  lines: { quantity: string; unitCost: string; isHeading?: boolean }[],
  vatRate: number,
): { marginPct: number; grand: number } | null {
  const base = costingFigures(lines, { marginPct: 0, vatRate });
  if (base.totalCost <= 0 || target <= 0) return null;
  // The contract value whose VAT brings it to the target, to the centavo.
  const targetCents = Math.round(target * 100);
  const guess = Math.round(targetCents / (1 + vatRate));
  let contractCents = guess;
  let best = Infinity;
  for (const c of [guess - 2, guess - 1, guess, guess + 1, guess + 2]) {
    const grand = c + Math.round(c * vatRate);
    if (Math.abs(grand - targetCents) < best) {
      best = Math.abs(grand - targetCents);
      contractCents = c;
    }
  }
  const contract = contractCents / 100;
  if (contract <= 0) return null;
  const marginPct = Math.round(((contract - base.totalCost) / contract) * 1_000_000) / 1_000_000;
  if (marginPct >= 0.95 || marginPct <= -0.95) return null;
  return { marginPct, grand: costingFigures(lines, { marginPct, vatRate }).grandTotal };
}

export function CostingSheet() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [categories, setCategories] = useState<Category[]>([]);
  const [lists, setLists] = useState<Lists>({ units: [], systemUnits: [], phases: [], tasks: [], terms: null, companyVatRate: 0.12 });
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(!editing);
  const [costing, setCosting] = useState<CostingDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const [header, setHeader] = useState<Header>({
    title: '',
    customer: null,
    siteId: '',
    leadId: params.get('leadId') ?? '',
    systemUnit: '',
    validUntil: addDays(todayLocal(), 30),
    marginPct: '15',
    vatOn: true,
    notes: '',
    terms: '',
  });
  /** The VAT rate a draft was saved with, kept while its toggle stays on after Settings change. */
  const [savedVat, setSavedVat] = useState<number | null>(null);
  const [lines, setLines] = useState<SheetLine[]>([]);
  const [sections, setSections] = useState<SheetSection[]>([]);
  const [spread, setSpread] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [leadNote, setLeadNote] = useState<{ id: string; number: string; companyName: string } | null>(null);
  const [templateId, setTemplateId] = useState(params.get('template') ?? '');
  const [target, setTarget] = useState('');
  const [templatePanel, setTemplatePanel] = useState(false);
  const focusNext = useRef<string | null>(null);

  // ── Loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    api.get<Category[]>('/reference/cost-categories').then(setCategories).catch(setError);
    api.get<Lists>('/costings/suggest/lists').then(setLists).catch(() => {});
    api.get<TemplateRow[]>('/costings/templates').then(setTemplates).catch(() => {});
  }, []);

  // A new sheet: one empty row in the first bucket to start typing in, and your
  // last Terms & Conditions to start from.
  useEffect(() => {
    if (editing || !categories.length) return;
    setLines((ls) => (ls.length ? ls : [blankLine(categories[0].id)]));
  }, [editing, categories]);
  useEffect(() => {
    if (editing || !lists.terms) return;
    setHeader((h) => (h.terms ? h : { ...h, terms: lists.terms ?? '' }));
  }, [editing, lists.terms]);

  // Editing: the saved draft, as rows to type into.
  useEffect(() => {
    if (!id) return;
    api
      .get<CostingDetail>(`/costings/${id}`)
      .then((c) => {
        setCosting(c);
        setSavedVat(c.vatRate);
        setHeader({
          title: c.title,
          customer: c.customer ? { id: c.customer.id, name: c.customer.name } : null,
          siteId: c.site?.id ?? '',
          leadId: c.lead?.id ?? '',
          systemUnit: c.systemUnit ?? '',
          validUntil: c.validUntil ?? '',
          marginPct: percentString(c.marginPct),
          vatOn: c.vatRate > 0,
          notes: c.notes ?? '',
          terms: c.terms ?? '',
        });
        setLines(
          c.lines.map((l) => ({
            key: nextKey('l'),
            id: l.id,
            categoryId: l.costCategory.id,
            itemId: l.item?.id ?? null,
            isHeading: l.isHeading,
            name: l.name ?? (l.isHeading ? l.description : ''),
            description: l.name || l.isHeading ? (l.description === l.name ? '' : l.description) : l.description,
            quantity: l.isHeading ? '' : String(l.quantity),
            unit: l.isHeading ? '' : l.unit,
            unitCost: l.isHeading ? '' : String(l.unitCost),
          })),
        );
        setSections(
          c.scopeSections.map((s) => ({
            key: nextKey('s'),
            id: s.id,
            kind: s.kind,
            name: s.name,
            description: s.description ?? '',
            value: String(s.value),
            durationDays: String(s.durationDays),
            tasks: s.tasks.map((t) => ({
              key: nextKey('t'),
              id: t.id,
              name: t.name,
              startDay: t.startDay ? String(t.startDay) : '',
              durationDays: String(t.durationDays),
            })),
          })),
        );
        // A costing whose schedule of values was set by hand keeps it unless asked.
        setSpread(Math.abs(c.scopeTotal - c.contractValue) < 0.005 || c.scopeSections.length === 0);
      })
      .catch(setError)
      .finally(() => setLoaded(true));
  }, [id]);

  // "Start costing" from a lead, or "New costing" from Customer 360: the customer,
  // site and title come prefilled, and only into what is still empty.
  useEffect(() => {
    if (editing) return;
    const leadId = params.get('leadId');
    const customerId = params.get('customerId');
    if (leadId) {
      api
        .get<{
          id: string;
          number: string;
          companyName: string;
          description: string | null;
          customer: CustomerRef | null;
          site: { id: string; name: string } | null;
        }>(`/leads/${leadId}`)
        .then((l) => {
          setLeadNote({ id: l.id, number: l.number, companyName: l.companyName });
          const first = (l.description ?? '').split('\n')[0].trim();
          setHeader((h) => ({
            ...h,
            title: h.title || (first || `${l.companyName} — requirement`).slice(0, 120),
            customer: h.customer ?? l.customer ?? null,
            siteId: h.siteId || l.site?.id || '',
          }));
        })
        .catch(setError);
    } else if (customerId) {
      api
        .get<{ id: string; name: string }>(`/customers/${customerId}`)
        .then((c) => setHeader((h) => ({ ...h, customer: h.customer ?? { id: c.id, name: c.name } })))
        .catch(() => {});
    }
  }, [editing, params]);

  const customerId = header.customer?.id ?? '';
  useEffect(() => {
    if (!customerId) {
      setSites([]);
      return;
    }
    api
      .get<{ sites: { id: string; name: string }[] }>(`/customers/${customerId}`)
      .then((c) => setSites(c.sites))
      .catch(() => setSites([]));
  }, [customerId]);

  // Arriving from Templates' "Start costing" (?template=): the template is
  // loaded once, as soon as the buckets it names are known.
  const autoTemplate = useRef(editing ? null : params.get('template'));
  useEffect(() => {
    if (!autoTemplate.current || !categories.length) return;
    autoTemplate.current = null;
    void loadTemplate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  // After adding a row, the cursor goes to its first box.
  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  // ── Unsaved changes ────────────────────────────────────────────────────────
  //
  // The sheet as it would be saved, without the row keys the page invents. The
  // baseline is taken the moment the person first changes a field, clicks,
  // presses a key or pastes in the sheet (in the capture phase, so before the
  // change itself lands) — after the draft has loaded and the prefills (the
  // lead, the customer, your last terms, a template from ?template=) have
  // landed — so none of those counts as a change; only what the person did.
  const snapshot = useMemo(
    () =>
      JSON.stringify({
        header: { ...header, customer: header.customer?.id ?? null },
        lines: lines.map(({ key: _key, ...l }) => l),
        sections: sections.map(({ key: _key, tasks, ...s }) => ({ ...s, tasks: tasks.map(({ key: _k, ...t }) => t) })),
        spread,
      }),
    [header, lines, sections, spread],
  );
  const [baseline, setBaseline] = useState<string | null>(null);
  const touch = () => setBaseline((b) => b ?? snapshot);
  const dirty = baseline !== null && baseline !== snapshot;
  useUnsavedChanges(dirty);
  useBackLink(editing ? `/g-ops/costing/${id}` : null, costing?.number);

  // ── Figures ────────────────────────────────────────────────────────────────

  const vatRate = header.vatOn ? (savedVat && savedVat > 0 ? savedVat : lists.companyVatRate) : 0;
  const rates = {
    // Typed in percent, stored as a fraction to six decimals; a minus sign is a loss-making bid, said as such.
    marginPct: marginOk(header.marginPct) ? Math.round(Number(header.marginPct.replace(/[,\s%]/g, '')) * 10000) / 1_000_000 : 0,
    vatRate,
  };
  const mathLines = lines.map((l) => ({ quantity: l.quantity || '0', unitCost: l.unitCost || '0', isHeading: l.isHeading }));
  const totals = costingFigures(mathLines, rates);
  /** The markup on cost the typed margin amounts to — for whoever still thinks in markup. */
  const markupNote = totals.totalCost > 0 ? ((totals.marginAmount / totals.totalCost) * 100).toFixed(2) : '0.00';

  const visibleCategories = useMemo(
    () =>
      [...categories]
        .filter((c) => c.isActive !== false || lines.some((l) => l.categoryId === c.id))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)),
    [categories, lines],
  );
  const rankOf = useMemo(() => new Map(visibleCategories.map((c, i) => [c.id, i + 1])), [visibleCategories]);

  // Lines grouped by bucket, in the order each bucket's rows were typed.
  const byCategory = useMemo(() => {
    const map = new Map<string, SheetLine[]>();
    for (const c of visibleCategories) map.set(c.id, []);
    for (const l of lines) map.get(l.categoryId)?.push(l);
    return map;
  }, [lines, visibleCategories]);
  const orderedLines = visibleCategories.flatMap((c) => byCategory.get(c.id) ?? []);
  const codes = lineCodes(orderedLines.map((l) => ({ rank: rankOf.get(l.categoryId) ?? 0, isHeading: l.isHeading })));
  const codeOf = new Map(orderedLines.map((l, i) => [l.key, codes[i]]));

  const plan = planTasks(
    sections.map((s) => ({
      durationDays: figure(s.durationDays),
      tasks: s.tasks.map((t) => ({ startDay: t.startDay ? figure(t.startDay) : null, durationDays: figure(t.durationDays) })),
    })),
  );
  const scopeTotal = sections.reduce((sum, s) => sum + figure(s.value), 0);

  // ── Editing the rows ───────────────────────────────────────────────────────

  const setH = <K extends keyof Header>(k: K, v: Header[K]) => setHeader((h) => ({ ...h, [k]: v }));
  const updateLine = (key: string, patch: Partial<SheetLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  function addLine(categoryId: string, isHeading = false, atTop = false) {
    const line = blankLine(categoryId, isHeading);
    focusNext.current = `cs-${line.key}-name`;
    setLines((ls) => {
      if (!atTop) {
        // After the bucket's last row, so the order within the bucket is the order typed.
        const last = ls.map((l) => l.categoryId).lastIndexOf(categoryId);
        return last < 0 ? [...ls, line] : [...ls.slice(0, last + 1), line, ...ls.slice(last + 1)];
      }
      const first = ls.findIndex((l) => l.categoryId === categoryId);
      return first < 0 ? [...ls, line] : [...ls.slice(0, first), line, ...ls.slice(first)];
    });
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(categoryId);
      return next;
    });
  }

  function removeLine(key: string) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

  /** Up or down within its own bucket — the keyboard's drag handle. */
  function moveLine(key: string, dir: -1 | 1) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      const cat = ls[i].categoryId;
      let j = i + dir;
      while (j >= 0 && j < ls.length && ls[j].categoryId !== cat) j += dir;
      if (j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function pasteRows(e: ClipboardEvent<HTMLInputElement>, line: SheetLine) {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.trim().includes('\n')) return; // one plain value: an ordinary paste
    e.preventDefault();
    const rows = parsePasted(text, line.categoryId);
    if (!rows.length) return;
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === line.key);
      // Pasted into an empty row, the rows take its place; otherwise they go under it.
      const replace = isBlankLine(line);
      return [...ls.slice(0, replace ? i : i + 1), ...rows, ...ls.slice(i + 1)];
    });
    toast('ok', `${rows.length} row${rows.length === 1 ? '' : 's'} pasted`);
  }

  function pick(line: SheetLine, s: Suggestion) {
    updateLine(line.key, {
      name: s.name,
      description: line.description || s.description,
      unit: s.unit || line.unit,
      unitCost: s.unitCost != null ? String(s.unitCost) : line.unitCost,
      itemId: s.itemId,
    });
    focusNext.current = `cs-${line.key}-qty`;
  }

  const updateSection = (key: string, patch: Partial<SheetSection>) =>
    setSections((ss) => ss.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const updateTask = (sKey: string, tKey: string, patch: Partial<SheetTask>) =>
    setSections((ss) =>
      ss.map((s) => (s.key === sKey ? { ...s, tasks: s.tasks.map((t) => (t.key === tKey ? { ...t, ...patch } : t)) } : s)),
    );

  function addSection() {
    const s = blankSection();
    focusNext.current = `cs-${s.key}-name`;
    setSections((ss) => [...ss, s]);
  }
  function addTask(sKey: string) {
    const t = blankTask();
    focusNext.current = `cs-${t.key}-name`;
    setSections((ss) => ss.map((s) => (s.key === sKey ? { ...s, tasks: [...s.tasks, t] } : s)));
  }
  function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  /** Writes the plan down: every task starts the working day after the one before it ends. */
  function sequence() {
    let cursor = 1;
    setSections((ss) =>
      ss.map((s) => ({
        ...s,
        tasks: s.tasks.map((t) => {
          const start = cursor;
          cursor = start + Math.max(figure(t.durationDays), 1);
          return { ...t, startDay: String(start) };
        }),
      })),
    );
  }

  /** Adds a template's rows and phases to the sheet; on an empty sheet, its settings too. */
  async function loadTemplate() {
    if (!templateId) return;
    try {
      const t = await api.get<TemplateFull>(`/costings/templates/${templateId}`);
      const firstCat = visibleCategories[0]?.id ?? '';
      const newLines: SheetLine[] = t.lines.map((l) => ({
        key: nextKey('l'),
        categoryId: l.costCategoryId ?? firstCat,
        itemId: l.itemId,
        isHeading: l.isHeading,
        name: l.name ?? (l.isHeading ? l.description : ''),
        description: l.name ? (l.description === l.name ? '' : l.description) : l.isHeading ? '' : l.description,
        quantity: l.isHeading ? '' : String(l.quantity),
        unit: l.isHeading ? '' : l.unit,
        unitCost: l.isHeading || !l.unitCost ? '' : String(l.unitCost),
      }));
      const newSections: SheetSection[] = t.sections.map((s) => ({
        key: nextKey('s'),
        kind: s.kind,
        name: s.name,
        description: s.description ?? '',
        value: '0',
        durationDays: String(s.durationDays),
        tasks: s.tasks.map((task) => ({
          key: nextKey('t'),
          name: task.name,
          startDay: task.startDay ? String(task.startDay) : '',
          durationDays: String(task.durationDays),
        })),
      }));
      const empty = lines.every(isBlankLine) && sections.every((s) => !s.name.trim());
      setLines((ls) => [...ls.filter((l) => !isBlankLine(l)), ...newLines]);
      setSections((ss) => [...ss.filter((s) => s.name.trim()), ...newSections]);
      if (empty) {
        setHeader((h) => ({
          ...h,
          systemUnit: h.systemUnit || t.systemUnit || '',
          marginPct: t.marginPct ? percentString(t.marginPct) : h.marginPct,
          terms: t.terms || h.terms,
        }));
      }
      toast('ok', `“${t.name}” added — ${newLines.length} row(s), ${newSections.length} phase(s)`);
    } catch (err) {
      setError(err);
    }
  }

  function applyTarget() {
    const result = priceTo(figure(target), mathLines, vatRate);
    if (!result) {
      toast('error', 'Enter the cost lines first — a price is set on top of a cost, and within a 95% margin of it.');
      return;
    }
    setHeader((h) => ({ ...h, marginPct: percentString(result.marginPct) }));
    toast('ok', `A ${percentString(result.marginPct)}% margin lands on ${formatMoney(result.grand)}`);
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  const kept = lines.filter((l) => !isBlankLine(l));
  const lineProblems = new Map<string, string>();
  for (const l of kept) {
    if (!l.name.trim() && !l.description.trim()) lineProblems.set(l.key, 'Name the line');
    else if (!l.isHeading && (!figureOk(l.quantity) || !figureOk(l.unitCost))) lineProblems.set(l.key, 'Quantity and unit cost are numbers, zero or more');
  }
  const keptSections = sections.filter((s) => s.name.trim() || s.tasks.some((t) => !isBlankTask(t)));
  const sectionProblems = new Map<string, string>();
  for (const s of keptSections) if (s.name.trim().length < 2) sectionProblems.set(s.key, 'Name the phase');
  const titleProblem = header.title.trim().length < 2 ? 'Give the costing a title' : null;
  const rateProblem = !marginOk(header.marginPct) ? 'The margin is a percentage of the price, between −95 and 95' : null;
  const valid = !titleProblem && !rateProblem && !lineProblems.size && !sectionProblems.size;

  function sheetPayload() {
    return {
      title: header.title.trim(),
      customerId: header.customer?.id ?? null,
      siteId: header.siteId || null,
      systemUnit: header.systemUnit.trim() || null,
      validUntil: header.validUntil || null,
      marginPct: rates.marginPct,
      vatRate,
      notes: header.notes,
      terms: header.terms,
      lines: kept.map((l) => ({
        ...(l.id ? { id: l.id } : {}),
        costCategoryId: l.categoryId,
        itemId: l.itemId,
        isHeading: l.isHeading,
        name: l.name.trim() || null,
        description: l.description.trim() || null,
        quantity: l.isHeading ? 0 : figure(l.quantity),
        unit: l.unit.trim() || 'pc',
        unitCost: l.isHeading ? 0 : figure(l.unitCost),
      })),
      sections: keptSections.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        kind: s.kind,
        name: s.name.trim(),
        description: s.description.trim() || null,
        durationDays: figure(s.durationDays),
        value: figure(s.value),
        tasks: s.tasks
          .filter((t) => !isBlankTask(t))
          .map((t) => ({
            ...(t.id ? { id: t.id } : {}),
            name: t.name.trim(),
            startDay: t.startDay ? Math.max(1, Math.floor(figure(t.startDay))) : null,
            durationDays: Math.floor(figure(t.durationDays)),
          })),
      })),
      spread: spread && keptSections.length > 0,
    };
  }

  async function save() {
    setAttempted(true);
    if (!valid) {
      toast('error', 'Some fields need attention');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = sheetPayload();
      const saved = editing
        ? await api.put<{ id: string; number: string }>(`/costings/${id}/sheet`, payload)
        : await api.post<{ id: string; number: string }>('/costings', { ...payload, leadId: header.leadId || null });
      toast('ok', `${saved.number} saved`);
      setBaseline(null); // saved: nothing left to lose on the way out
      navigate(`/g-ops/costing/${saved.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function saveTemplate(name: string, description: string, withPrices: boolean) {
    const p = sheetPayload();
    await api.post('/costings/templates', {
      name,
      description,
      withPrices,
      sheet: {
        systemUnit: p.systemUnit,
        marginPct: p.marginPct,
        terms: p.terms,
        lines: p.lines,
        sections: p.sections,
      },
    });
    toast('ok', `Saved as template “${name}”`);
    setTemplatePanel(false);
    api.get<TemplateRow[]>('/costings/templates').then(setTemplates).catch(() => {});
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  if (!loaded || !categories.length) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && costing && (!costing.canEdit || costing.status !== 'DRAFT')) {
    // The Shell's "← Back to <number>" (useBackLink above) is the way out.
    return (
      <div className="card">
        <p className="muted">
          {!costing.canEdit
            ? 'Only the author, or someone who may edit every costing, can change this one.'
            : costing.status === 'FINAL'
              ? 'This costing is final. Reopen it from its page before changing it.'
              : 'This costing is with the approver and holds still until they decide.'}
        </p>
      </div>
    );
  }
  if (editing && !costing) return <ErrorBox error={error ?? new Error('Costing not found')} />;

  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="costing-sheet" onChangeCapture={touch} onClickCapture={touch} onKeyDownCapture={touch} onPasteCapture={touch}>
      <section className="card qe-card" aria-labelledby="cs-heading">
        <div className="qe-head">
          <div>
            <h1 id="cs-heading" className="qe-heading">
              {editing && costing ? `Modify costing ${costing.number}` : 'New costing'}
            </h1>
            <p className="muted qe-lead">
              {editing
                ? 'Change what you need and Save — the lines, the scope and the figures are saved together.'
                : 'Type straight into the sheet. The number is issued when you Save.'}
            </p>
          </div>
          <div className="row qe-actions">
            {/* A new sheet's one other save: a template from what is typed, before any costing exists. A saved costing's is on its page's ⋯. */}
            {!editing && can('gops.costing.create') && (
              <button type="button" className="btn" onClick={() => setTemplatePanel((v) => !v)} aria-expanded={templatePanel}>
                Save as template
              </button>
            )}
            {saveButton}
          </div>
        </div>

        <ErrorBox error={error} />
        {templatePanel && <TemplateSavePanel onSave={saveTemplate} onCancel={() => setTemplatePanel(false)} />}

        {leadNote && (
          <div className="alert info">
            Started from lead{' '}
            <Link to={`/g-ops/leads/${leadNote.id}`} className="mono">
              {leadNote.number}
            </Link>{' '}
            — {leadNote.companyName}. The lead moves to Costing when you save.
          </div>
        )}

        {templates.length > 0 && (
          <div className="cs-template row">
            <label htmlFor="cs-template">{editing ? 'Add from a template' : 'Start from a template'}</label>
            <select id="cs-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">— choose a template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.lineCount} line{t.lineCount === 1 ? '' : 's'}, {t.sectionCount} phase{t.sectionCount === 1 ? '' : 's'}
                  {t.withPrices ? '' : ' · no prices'}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => void loadTemplate()} disabled={!templateId}>
              Add to sheet
            </button>
          </div>
        )}

        {/* ── Costing details ───────────────────────────────────────────── */}
        <h2 className="cs-section-title">Costing details</h2>
        <div className="qe-header qe-rows">
          <div>
            <Field label="Project / job name" required error={attempted ? titleProblem : null}>
              <input
                value={header.title}
                maxLength={300}
                autoFocus={!editing}
                placeholder="e.g. Quadruplex booster VFD controller"
                onChange={(e) => setH('title', e.target.value)}
              />
            </Field>
            <Field label="Customer" htmlFor="cs-client">
              <CustomerPicker
                inputId="cs-client"
                value={header.customer}
                onError={setError}
                onChange={(c) => setHeader((h) => ({ ...h, customer: c, siteId: c?.id === h.customer?.id ? h.siteId : '' }))}
              />
            </Field>
            <Field label="Location / site">
              <select value={header.siteId} onChange={(e) => setH('siteId', e.target.value)} disabled={!sites.length}>
                <option value="">{header.customer ? (sites.length ? '— none —' : 'No sites on file') : 'Choose the customer first'}</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div>
            <Field label="System / unit" hint="The plant or equipment this is for">
              <input
                value={header.systemUnit}
                list="cs-systems"
                maxLength={200}
                placeholder="e.g. Booster pump controller"
                onChange={(e) => setH('systemUnit', e.target.value)}
              />
            </Field>
            <Field label="Valid until">
              <input type="date" value={header.validUntil} onChange={(e) => setH('validUntil', e.target.value)} />
            </Field>
            {editing && costing && (
              <div className="field qe-static">
                <span className="qe-static-label">Prepared by</span>
                <div>{costing.owner.name}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── Project budgeted cost ─────────────────────────────────────── */}
        <div className="row cs-block-head">
          <h2 className="cs-section-title">Project budgeted cost</h2>
          <p className="faint cs-paste-hint">
            Tip: copy rows from Excel (Name, Description, Unit, Qty, Unit cost) and paste into any name box.
          </p>
        </div>
        {visibleCategories.map((cat) => {
          const rank = rankOf.get(cat.id) ?? 0;
          const rows = byCategory.get(cat.id) ?? [];
          const subtotal = costingFigures(
            rows.map((l) => ({ quantity: l.quantity || '0', unitCost: l.unitCost || '0', isHeading: l.isHeading })),
            { marginPct: 0 },
          ).totalCost;
          const open = !collapsed.has(cat.id);
          const count = rows.filter((l) => !l.isHeading && !isBlankLine(l)).length;
          return (
            <div key={cat.id} className="cs-cat">
              <button
                type="button"
                className="cs-cat-head"
                aria-expanded={open}
                aria-controls={`cs-cat-${cat.id}`}
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (next.has(cat.id)) next.delete(cat.id);
                    else next.add(cat.id);
                    return next;
                  })
                }
              >
                <span className="cs-caret" aria-hidden="true">
                  {open ? '▾' : '▸'}
                </span>
                <span className="cs-cat-name">
                  {rank} {cat.name}
                </span>
                <span className="faint">
                  {count} line{count === 1 ? '' : 's'}
                </span>
                <span className="cs-cat-total mono">{formatMoney(subtotal)}</span>
              </button>
              {open && (
                <div id={`cs-cat-${cat.id}`}>
                  {rows.length > 0 && (
                    <div className="qe-table-wrap">
                      <table className="data qe-lines cs-lines">
                        <thead>
                          <tr>
                            <th className="cs-col-code">Code</th>
                            <th>Name | Description</th>
                            <th className="cs-col-unit">Unit</th>
                            <th className="cs-col-qty right">Qty</th>
                            <th className="cs-col-cost right">Unit cost</th>
                            <th className="cs-col-amount right">Amount</th>
                            <th className="cs-col-tools">
                              <span className="visually-hidden">Move or remove</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((l, i) => {
                            const problem = attempted ? lineProblems.get(l.key) : undefined;
                            const label = l.isHeading ? `Subheading in ${cat.name}` : `${cat.name} line ${codeOf.get(l.key) ?? i + 1}`;
                            const tools = (
                              <td className="cs-col-tools">
                                <div className="cs-tools">
                                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => moveLine(l.key, -1)}>
                                    ↑
                                  </button>
                                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${label} down`} disabled={i === rows.length - 1} onClick={() => moveLine(l.key, 1)}>
                                    ↓
                                  </button>
                                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Remove ${label}`} onClick={() => removeLine(l.key)}>
                                    ✕
                                  </button>
                                </div>
                              </td>
                            );
                            if (l.isHeading) {
                              return (
                                <tr key={l.key} className="cs-subhead">
                                  <td className="cs-col-code faint">—</td>
                                  <td colSpan={5}>
                                    <input
                                      id={`cs-${l.key}-name`}
                                      className="qe-title"
                                      aria-label={label}
                                      placeholder="Subheading"
                                      value={l.name}
                                      aria-invalid={problem ? true : undefined}
                                      onChange={(e) => updateLine(l.key, { name: e.target.value })}
                                    />
                                    {problem && <div className="qe-cell-error">{problem}</div>}
                                  </td>
                                  {tools}
                                </tr>
                              );
                            }
                            return (
                              <tr key={l.key}>
                                <td className="cs-col-code mono faint">{codeOf.get(l.key)}</td>
                                <td>
                                  <SuggestInput
                                    id={`cs-${l.key}-name`}
                                    label={`${label} name`}
                                    value={l.name}
                                    categoryId={cat.id}
                                    invalid={!!problem}
                                    onChange={(v) => updateLine(l.key, { name: v, itemId: null })}
                                    onPick={(s) => pick(l, s)}
                                    onPaste={(e) => pasteRows(e, l)}
                                  />
                                  <textarea
                                    aria-label={`${label} description`}
                                    placeholder="Description"
                                    rows={2}
                                    value={l.description}
                                    onChange={(e) => updateLine(l.key, { description: e.target.value })}
                                  />
                                  {problem && <div className="qe-cell-error">{problem}</div>}
                                </td>
                                <td className="cs-col-unit">
                                  <input aria-label={`${label} unit`} list="cs-units" value={l.unit} maxLength={30} onChange={(e) => updateLine(l.key, { unit: e.target.value })} />
                                </td>
                                <td className="cs-col-qty">
                                  <NumberInput
                                    kind="quantity"
                                    id={`cs-${l.key}-qty`}
                                    className="qe-num"
                                    aria-label={`${label} quantity`}
                                    value={l.quantity}
                                    onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                                  />
                                </td>
                                <td className="cs-col-cost">
                                  <NumberInput
                                    kind="money"
                                    className="qe-num"
                                    aria-label={`${label} unit cost`}
                                    placeholder="0.00"
                                    value={l.unitCost}
                                    onChange={(e) => updateLine(l.key, { unitCost: e.target.value })}
                                    onKeyDown={(e) => {
                                      // Enter on the last row's price starts the next row.
                                      if (e.key === 'Enter' && i === rows.length - 1) {
                                        e.preventDefault();
                                        addLine(cat.id);
                                      }
                                    }}
                                  />
                                </td>
                                <td className="cs-col-amount right mono">
                                  {formatMoney(figureOk(l.quantity) && figureOk(l.unitCost) ? lineAmount(l.quantity || '0', l.unitCost || '0') : 0)}
                                </td>
                                {tools}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="row cs-row-actions">
                    <button type="button" className="btn btn-sm" onClick={() => addLine(cat.id)}>
                      + Add row
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => addLine(cat.id, true)}>
                      + Add subheading
                    </button>
                    {rows.length > 0 && (
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => addLine(cat.id, true, true)}>
                        + Subheading at top
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="cs-grand-cost row">
          <strong>Total project budgeted cost</strong>
          <strong className="mono">{formatMoney(totals.totalCost)}</strong>
        </div>

        {/* ── Cost summary ──────────────────────────────────────────────── */}
        <h2 className="cs-section-title">Cost summary</h2>
        <div className="cs-summary-grid">
          <table className="data cs-summary">
            <tbody>
              <tr>
                <td>Project budgeted cost</td>
                <td />
                <td className="right mono">{formatMoney(totals.totalCost)}</td>
              </tr>
              {/* The owner's summary (2026-10-09): the margin as a share of the price; no contingency % and no discount here. */}
              <tr>
                <td>
                  <label htmlFor="cs-margin">Margin on the price</label>
                  <div className="faint cs-note">= {markupNote}% markup on cost</div>
                </td>
                <td className="cs-rate">
                  <NumberInput kind="percent" id="cs-margin" className="qe-num" value={header.marginPct} onChange={(e) => setH('marginPct', e.target.value)} />
                  <span aria-hidden="true">%</span>
                </td>
                <td className="right mono">{formatMoney(totals.marginAmount)}</td>
              </tr>
              <tr className="cs-strong">
                <td>Subtotal (contract value)</td>
                <td />
                <td className="right mono">{formatMoney(totals.contractValue)}</td>
              </tr>
              <tr>
                <td colSpan={2}>
                  <Checkbox checked={header.vatOn} onChange={(v) => setH('vatOn', v)} label={`VAT ${((savedVat && savedVat > 0 ? savedVat : lists.companyVatRate) * 100).toFixed(0)}%`} />
                </td>
                <td className="right mono">{formatMoney(totals.vatAmount)}</td>
              </tr>
              <tr className="cs-grand">
                <td colSpan={2}>GRAND TOTAL</td>
                <td className="right mono">{formatMoney(totals.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
          <div className="cs-summary-side">
            {rateProblem && attempted && <div className="alert error">{rateProblem}</div>}
            <Field label="Set the grand total" hint="Works out the margin that lands on this figure — to the centavo where a margin can.">
              <div className="row cs-target">
                <NumberInput
                  kind="money"
                  placeholder="e.g. 130,000"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyTarget();
                    }
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={applyTarget} disabled={!figure(target)}>
                  Apply
                </button>
              </div>
            </Field>
            <p className="faint cs-note">
              The project budgeted cost — every line, contingency included, without the margin — becomes the project's
              purchasing budget when a project is built on this costing. The contract value is net of VAT; it is what the
              schedule of values below adds up to.
            </p>
          </div>
        </div>

        {/* ── Scope of work ─────────────────────────────────────────────── */}
        <div className="row cs-block-head">
          <h2 className="cs-section-title">Scope of work</h2>
          <p className="faint cs-paste-hint">
            {plan.totalDays} working day{plan.totalDays === 1 ? '' : 's'} in all (Mon–Fri). A task with no start day follows the one before it.
          </p>
        </div>
        {sections.length === 0 && (
          <p className="muted">
            No phases yet. Typical: Planning &amp; mobilization, main works, testing &amp; commissioning, turnover — each phase is
            a line of the schedule of values that progress billing bills against.
          </p>
        )}
        {sections.map((s, si) => {
          const planned = plan.sections[si];
          const problem = attempted ? sectionProblems.get(s.key) : undefined;
          const phaseLabel = `Phase ${si + 1}`;
          return (
            <div key={s.key} className="cs-phase">
              <div className="cs-phase-head">
                <div className="cs-tools">
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${phaseLabel} up`} disabled={si === 0} onClick={() => setSections((ss) => move(ss, si, -1))}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${phaseLabel} down`} disabled={si === sections.length - 1} onClick={() => setSections((ss) => move(ss, si, 1))}>
                    ↓
                  </button>
                </div>
                <div className="cs-phase-name">
                  <input
                    id={`cs-${s.key}-name`}
                    className="qe-title"
                    aria-label={`${phaseLabel} name`}
                    list="cs-phases"
                    placeholder="Phase, e.g. Controller assembly"
                    value={s.name}
                    aria-invalid={problem ? true : undefined}
                    onChange={(e) => updateSection(s.key, { name: e.target.value })}
                  />
                  {problem && <div className="qe-cell-error">{problem}</div>}
                </div>
                <select aria-label={`${phaseLabel} type`} value={s.kind} onChange={(e) => updateSection(s.key, { kind: e.target.value as Kind })}>
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <label className="cs-phase-value">
                  <span className="faint">Value</span>
                  <NumberInput
                    kind="money"
                    className="qe-num"
                    aria-label={`${phaseLabel} value (schedule of values)`}
                    value={s.value}
                    disabled={spread}
                    title={spread ? 'Spread from the contract value on save' : undefined}
                    onChange={(e) => updateSection(s.key, { value: e.target.value })}
                  />
                </label>
                <span className="faint cs-phase-span">
                  {planned.start ? `Day ${planned.start}–${planned.end} · ${planned.days} d` : `${planned.days} d`}
                </span>
                <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${phaseLabel}`} onClick={() => setSections((ss) => ss.filter((x) => x.key !== s.key))}>
                  Remove
                </button>
              </div>
              <div className="qe-table-wrap">
                <table className="data qe-lines cs-tasks">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th className="cs-col-day right">Start day</th>
                      <th className="cs-col-day right">Days</th>
                      <th className="cs-col-day right">Ends</th>
                      <th className="cs-col-bar">
                        <span className="visually-hidden">Plan</span>
                      </th>
                      <th className="cs-col-tools">
                        <span className="visually-hidden">Move or remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.tasks.map((t, ti) => {
                      const pt = planned.tasks[ti];
                      const taskLabel = `${phaseLabel} task ${ti + 1}`;
                      return (
                        <tr key={t.key}>
                          <td>
                            <input
                              id={`cs-${t.key}-name`}
                              aria-label={`${taskLabel} name`}
                              list="cs-tasks"
                              placeholder="Task"
                              value={t.name}
                              onChange={(e) => updateTask(s.key, t.key, { name: e.target.value })}
                            />
                          </td>
                          <td className="cs-col-day">
                            <NumberInput
                              kind="count"
                              className="qe-num"
                              aria-label={`${taskLabel} start day`}
                              placeholder={String(pt.start)}
                              value={t.startDay}
                              onChange={(e) => updateTask(s.key, t.key, { startDay: e.target.value.replace(/\D/g, '') })}
                            />
                          </td>
                          <td className="cs-col-day">
                            <NumberInput
                              kind="count"
                              className="qe-num"
                              aria-label={`${taskLabel} duration in working days`}
                              value={t.durationDays}
                              onChange={(e) => updateTask(s.key, t.key, { durationDays: e.target.value.replace(/\D/g, '') })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && ti === s.tasks.length - 1) {
                                  e.preventDefault();
                                  addTask(s.key);
                                }
                              }}
                            />
                          </td>
                          <td className="cs-col-day right mono">Day {pt.end}</td>
                          <td className="cs-col-bar">
                            <PlanBar start={pt.start} days={pt.days} total={Math.max(plan.totalDays, 1)} />
                          </td>
                          <td className="cs-col-tools">
                            <div className="cs-tools">
                              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${taskLabel} up`} disabled={ti === 0} onClick={() => updateSection(s.key, { tasks: move(s.tasks, ti, -1) })}>
                                ↑
                              </button>
                              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Move ${taskLabel} down`} disabled={ti === s.tasks.length - 1} onClick={() => updateSection(s.key, { tasks: move(s.tasks, ti, 1) })}>
                                ↓
                              </button>
                              <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`Remove ${taskLabel}`} onClick={() => updateSection(s.key, { tasks: s.tasks.filter((x) => x.key !== t.key) })}>
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-sm cs-add-task" onClick={() => addTask(s.key)}>
                + Add task
              </button>
            </div>
          );
        })}
        <div className="row cs-row-actions">
          <button type="button" className="btn btn-sm" onClick={addSection}>
            + Add phase
          </button>
          {sections.some((s) => s.tasks.length) && (
            <button type="button" className="btn btn-sm" onClick={sequence} title="Each task starts the working day after the one before it ends">
              Sequence tasks
            </button>
          )}
        </div>
        {sections.length > 0 && (
          <div className="cs-sov">
            <Checkbox checked={spread} onChange={setSpread} label="Keep the schedule of values equal to the contract value (spread it across the phases on save)" />
            {!spread && Math.abs(scopeTotal - totals.contractValue) > 0.009 && (
              <div className="alert warn">
                The phases add up to {formatMoney(scopeTotal)} against a contract value of {formatMoney(totals.contractValue)}. A
                project cannot be built until they agree.
              </div>
            )}
          </div>
        )}

        {/* ── Terms and notes ───────────────────────────────────────────── */}
        <div className="qe-header cs-texts">
          <Field label="Terms & Conditions" hint="Printed on the estimate">
            <textarea rows={5} value={header.terms} onChange={(e) => setH('terms', e.target.value)} />
          </Field>
          <Field label="Internal notes" hint="Never printed — for the team only">
            <textarea rows={5} value={header.notes} onChange={(e) => setH('notes', e.target.value)} />
          </Field>
        </div>

        <div className="row qe-foot">{saveButton}</div>
      </section>

      <datalist id="cs-units">
        {[...new Set([...lists.units, 'pc', 'pcs', 'lot', 'set', 'unit', 'm', 'kg', 'day', 'hr', 'trip'])].map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <datalist id="cs-systems">
        {lists.systemUnits.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <datalist id="cs-phases">
        {lists.phases.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <datalist id="cs-tasks">
        {lists.tasks.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </div>
  );
}

/** A task's place on the plan, as a bar across the whole project's working days. */
export function PlanBar({ start, days, total }: { start: number; days: number; total: number }) {
  const from = ((start - 1) / total) * 100;
  const len = (Math.max(days, 1) / total) * 100;
  return (
    <div className="cs-bar-track" aria-hidden="true">
      <span className="cs-bar" style={{ ['--from' as string]: `${from}%`, ['--len' as string]: `${len}%` }} />
    </div>
  );
}

/**
 * A line's name box that offers what was costed before: past lines (their last
 * unit, price and description) and items from the item master. Keyboard: the
 * matches are buttons — ArrowDown reaches them, Escape closes the list, and
 * focus leaving the box and its list closes it too.
 */
function SuggestInput({
  id,
  label,
  value,
  categoryId,
  invalid,
  onChange,
  onPick,
  onPaste,
}: {
  id: string;
  label: string;
  value: string;
  categoryId: string;
  invalid?: boolean;
  onChange: (v: string) => void;
  onPick: (s: Suggestion) => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Suggestion[]>([]);
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
        .get<Suggestion[]>(`/costings/suggest${qs({ q: term, categoryId })}`)
        .then((rows) => setMatches(rows.filter((r) => r.name.toUpperCase() !== term.toUpperCase() || r.unitCost != null)))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(t);
  }, [value, open, categoryId]);

  function choose(s: Suggestion) {
    onPick(s);
    setOpen(false);
    setMatches([]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      menuRef.current?.querySelector<HTMLElement>('button')?.focus();
    }
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
        id={id}
        className="qe-title"
        aria-label={label}
        placeholder="Name"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open && matches.length > 0}
        aria-invalid={invalid || undefined}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {open && matches.length > 0 && (
        <ul className="lookup-menu qe-suggest" ref={menuRef}>
          {matches.map((s, i) => (
            <li key={`${s.source}-${s.name}-${i}`}>
              <button
                type="button"
                onClick={() => choose(s)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setOpen(false);
                    inputRef.current?.focus();
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const buttons = [...(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];
                    const at = buttons.indexOf(e.currentTarget);
                    const next = buttons[at + (e.key === 'ArrowDown' ? 1 : -1)];
                    if (next) next.focus();
                    else if (e.key === 'ArrowUp') inputRef.current?.focus();
                  }
                }}
              >
                <span className="qe-suggest-name">{s.name}</span>
                <span className="faint qe-suggest-meta">
                  {s.unitCost != null ? `${formatMoney(s.unitCost)} / ${s.unit}` : s.unit}
                  {s.source === 'item'
                    ? ` · item ${s.itemCode ?? ''}`
                    : ` · costed ${s.uses}×${s.lastNumber ? `, last on ${s.lastNumber}` : ''}`}
                </span>
                {s.description && <span className="faint qe-suggest-desc">{s.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Name the template, say whether it keeps prices — then save. In the page, not over it. */
export function TemplateSavePanel({
  onSave,
  onCancel,
  defaultName = '',
}: {
  onSave: (name: string, description: string, withPrices: boolean) => Promise<void>;
  onCancel: () => void;
  defaultName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [withPrices, setWithPrices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), description.trim(), withPrices);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cs-template-save" role="group" aria-labelledby="cs-template-save-title">
      <h3 id="cs-template-save-title" className="card-title">
        Save as template
      </h3>
      <p className="muted">
        The lines, phases, tasks, margin and terms are kept, to start the next costing from. The customer, dates and approval are
        not.
      </p>
      <ErrorBox error={error} />
      <div className="qe-header">
        <Field label="Template name" required>
          <input value={name} autoFocus maxLength={120} placeholder="e.g. VFD controller — supply and install" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <Checkbox checked={withPrices} onChange={setWithPrices} label="Keep the unit costs (untick to keep quantities and names only)" />
      <div className="row cs-row-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || name.trim().length < 2}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

