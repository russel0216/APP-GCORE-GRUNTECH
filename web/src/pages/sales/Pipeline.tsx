import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, downloadBlob, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Stat } from '../../components/charts';
import { Menu } from '../../components/Menu';
import { NumberInput } from '../../components/NumberInput';
import { useConfirm } from '../../components/Confirm';
import {
  Avatar,
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  ModalFoot,
  StatusBadge,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { LeadForm, loadPeople, type Person } from './Leads';

/*
  The sales board.

  A VIEW over leads and quotations — not a third record (Phase 3: "No
  Opportunity entity"). The server decides everything that has to agree with
  somewhere else: which records are cards, which column each stands in, what
  each is worth (`quotationValue`, the same rule Insights uses) and where each
  may be dropped (`allowedTargets`, the same rules PATCH /leads and PATCH
  /quotations enforce). This file only draws that and asks for moves.

  A move writes through the ordinary record routes. There is no board-only
  write path, so the detail pages and the board refuse the same things for the
  same reasons: WON needs an approved revision, LOST needs a reason, a lead is
  won by its quotation.

  Dragging is native HTML5 drag-and-drop, which most touch browsers never
  fire. The Move menu (Enter or Space on a card) and Shift+Arrow are the other
  two ways to move a card, and on a phone they are the only ones.
*/

// ── Server shapes (api/src/shared/pipeline.ts) ───────────────────────────────

interface BoardPerson {
  id: string;
  name: string;
  photoPath: string | null;
}

interface Card {
  ref: string;
  kind: 'lead' | 'quotation';
  id: string;
  number: string;
  title: string;
  subject: string | null;
  customer: { id: string; name: string } | null;
  owner: BoardPerson;
  value: number;
  probability: number;
  weighted: number;
  ageDays: number;
  expectedClosing: string | null;
  nextStep: { label: string; at: string | null } | null;
  revision: { n: number; status: string } | null;
  hasApprovedRevision: boolean;
  job: { id: string; number: string } | null;
  lostReason: string | null;
  overdue: boolean;
  canMove: boolean;
  allowedTargets: string[];
  link: string;
  column: string;
  /** Won AND booked — a sales order or project exists (SCORO's Completed). */
  booked: boolean;
  /** The stage (SCORO's band) the card stands in. */
  stage: string;
}

/** A stage as Admin › Pipeline Stages has it: SCORO's status, as data. */
interface StageDef {
  key: string;
  label: string;
  probability: number | null;
  color: string;
  inActiveList: boolean;
  successful: boolean;
  fixedOdds: boolean;
  columns: string[];
  statuses: string[];
  explanation: string;
}

interface Column {
  key: string;
  label: string;
  kind: 'lead' | 'quotation' | 'terminal' | 'parked' | 'forecast' | 'stage';
  count: number;
  value: number;
  weighted: number;
  cards: Card[];
  /** A stage column: its colour and the fine columns it gathers. */
  color?: string;
  explanation?: string;
  columns?: string[];
}

interface Kpis {
  openQuotes: number;
  quotedValue: number;
  weightedValue: number;
  leadEstimate: number;
  leadCount: number;
  averageQuote: number | null;
  averageDiscountPct: number | null;
  expectedMarginPct: number | null;
  marginSample: { withCosting: number; open: number };
  overdue: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
  forecastValue: number;
  forecastWeighted: number;
  forecastCount: number;
  unprobabled: number;
}

interface Board {
  asOf: string;
  window: { decidedFrom: string; decidedWithinDays: number };
  kpis: Kpis;
  stages: StageDef[];
  columns: Column[];
  forecast: Omit<Column, 'kind'>;
  people: BoardPerson[];
}

// ── The view: what a person has chosen to see ────────────────────────────────

const BOARD_KEYS = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT',
  'COSTING',
  'QUOTED',
  'SUBMITTED',
  'NEGOTIATION',
  'WON',
  'LOST',
  'ON_HOLD',
];
const FORECAST = 'FORECAST';
/** The stage keys, so a collapsed stage is remembered like a collapsed column. */
const STAGE_KEYS = ['OPPORTUNITY', 'NEGOTIATION', 'CLOSING', 'CONFIRMED', 'COMPLETED', 'LOST', 'HOLD'];
const LEAD_KEYS = ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'ON_HOLD'];
const QUOTATION_KEYS = ['QUOTED', 'SUBMITTED', 'NEGOTIATION'];

const CARD_FIELDS = [
  { key: 'customer', label: 'Customer' },
  { key: 'subject', label: 'Subject and number' },
  { key: 'value', label: 'Value' },
  { key: 'probability', label: 'Probability' },
  { key: 'weighted', label: 'Weighted value' },
  { key: 'owner', label: 'Salesperson' },
  { key: 'age', label: 'Age' },
  { key: 'next', label: 'Next step' },
  { key: 'revision', label: 'Revision' },
  { key: 'job', label: 'Project' },
];

// SCORO's strip, in its order: Total, Average quote, Average discount, Sum,
// Margin, Overdue — then G-CORE's own three, off by default.
const KPI_TILES = [
  { key: 'open', label: 'Total (open quotes)' },
  { key: 'average', label: 'Average quote' },
  { key: 'discount', label: 'Average discount' },
  { key: 'quoted', label: 'Sum (quoted value)' },
  { key: 'margin', label: 'Margin' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'weighted', label: 'Weighted' },
  { key: 'won', label: 'Won this period' },
  { key: 'forecast', label: 'This month forecast' },
];
const DEFAULT_KPIS = ['open', 'average', 'discount', 'quoted', 'margin', 'overdue'];

const SORTS = [
  { value: 'weighted', label: 'Weighted value' },
  { value: 'value', label: 'Value' },
  { value: 'age', label: 'Oldest first' },
  { value: 'closing', label: 'Expected closing' },
] as const;

type Sort = (typeof SORTS)[number]['value'];

interface PipelineView {
  v: 1;
  /** SCORO's stages (the default), or every one of G-CORE's own steps. */
  stages: 'stages' | 'detailed';
  columns: string[];
  collapsed: string[];
  cardFields: string[];
  kpis: string[];
  groupBy: 'none' | 'owner';
  ownerId: string;
  decidedWithinDays: number;
  sort: Sort;
}

const DEFAULT_VIEW: PipelineView = {
  v: 1,
  stages: 'stages',
  columns: [...BOARD_KEYS, FORECAST],
  collapsed: ['ON_HOLD'],
  cardFields: CARD_FIELDS.map((f) => f.key),
  kpis: DEFAULT_KPIS,
  groupBy: 'none',
  ownerId: '',
  decidedWithinDays: 90,
  sort: 'weighted',
};

const VIEW_STORAGE = 'gcore_pipeline_view';

/**
 * Accepts anything and returns a valid view: unknown keys dropped, missing
 * ones defaulted. A view saved by a later version of this screen, or edited
 * by hand, degrades instead of breaking the board.
 */
function sanitiseView(raw: unknown): PipelineView {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const all = [...BOARD_KEYS, FORECAST];
  const list = (v: unknown, allowed: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)) : null;
  const columns = list(r.columns, all);
  // Every column is always present in the order list — hiding is collapsing,
  // never removing, so nothing a drop could land on is ever out of reach.
  const ordered = columns ? [...new Set([...columns, ...all.filter((k) => !columns.includes(k))])] : DEFAULT_VIEW.columns;
  const days = Number(r.decidedWithinDays);
  return {
    v: 1,
    stages: r.stages === 'detailed' ? 'detailed' : 'stages',
    columns: ordered,
    collapsed: list(r.collapsed, [...all, ...STAGE_KEYS]) ?? DEFAULT_VIEW.collapsed,
    cardFields: list(r.cardFields, CARD_FIELDS.map((f) => f.key)) ?? DEFAULT_VIEW.cardFields,
    kpis: list(r.kpis, KPI_TILES.map((k) => k.key)) ?? DEFAULT_VIEW.kpis,
    groupBy: r.groupBy === 'owner' ? 'owner' : 'none',
    ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
    decidedWithinDays: Number.isFinite(days) ? Math.min(730, Math.max(30, Math.round(days))) : 90,
    sort: SORTS.some((s) => s.value === r.sort) ? (r.sort as Sort) : 'weighted',
  };
}

function readStoredView(): PipelineView | null {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE);
    return raw ? sanitiseView(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function storeView(view: PipelineView) {
  try {
    localStorage.setItem(VIEW_STORAGE, JSON.stringify(view));
  } catch {
    /* a private window: the view simply is not remembered */
  }
}

interface SavedView {
  id: string;
  userId: string;
  name: string;
  query: unknown;
  isShared: boolean;
}

// ── Rules the client needs only to EXPLAIN a refusal ─────────────────────────

const LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  SITE_VISIT: 'Site visit',
  COSTING: 'Costing',
  QUOTED: 'Quotation drafted',
  SUBMITTED: 'Submitted',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  ON_HOLD: 'On hold',
  FORECAST: 'This month forecast',
};

/**
 * Why a card may not go to a column, in the words the server would use.
 * The server's `allowedTargets` decides; this only puts the refusal into a
 * sentence before the drop, so nobody learns the rule from a 400.
 */
function refusalFor(card: Card, key: string): string | null {
  if (key === card.column) return null;
  if (card.allowedTargets.includes(key)) return null;
  if (key === FORECAST) return 'The forecast is worked out from expected closing — set the date on the record';
  if (!card.canMove) return 'Only the owner (or a manager) can move this';
  if (card.kind === 'lead') return 'Raise a quotation from this lead first — a lead is won by its quotation';
  if (card.column === 'WON' && card.job) return `This quotation became ${card.job.number} — it stays won`;
  if (LEAD_KEYS.includes(key)) return 'A quotation is not a lead; put its lead on hold from the lead';
  if (key === 'WON') return 'Needs an approved revision — submit it for approval first';
  return 'Not a move this card can make';
}

function payloadFor(card: Card, key: string, lostReason?: string) {
  if (card.kind === 'lead') return { status: key, ...(lostReason ? { lostReason } : {}) };
  return { outcome: key === 'QUOTED' ? 'OPEN' : key, ...(lostReason ? { lostReason } : {}) };
}

/**
 * SCORO's column tints (the owner's pipeline screenshot): opportunity cream,
 * negotiation orange, closing light green, confirmed green, forecast yellow.
 * Mapped onto G-CORE's own stages; the colours come from the tone tokens.
 */
const COLUMN_TONE: Record<string, string> = {
  NEW: 'opportunity',
  CONTACTED: 'opportunity',
  QUALIFIED: 'opportunity',
  SITE_VISIT: 'opportunity',
  COSTING: 'opportunity',
  QUOTED: 'opportunity',
  // By position on SCORO's ladder (Opportunity → Negotiation → Closing →
  // Confirmed): a submitted quote is their Negotiation, negotiating is Closing.
  SUBMITTED: 'negotiation',
  NEGOTIATION: 'closing',
  WON: 'won',
  LOST: 'lost',
  ON_HOLD: '',
  [FORECAST]: 'forecast',
};

const byClosing = (c: Card) => (c.expectedClosing ? c.expectedClosing : '9999-12-31');

function sortCards(cards: Card[], sort: Sort): Card[] {
  const out = [...cards];
  if (sort === 'weighted') out.sort((a, b) => b.weighted - a.weighted || b.value - a.value);
  if (sort === 'value') out.sort((a, b) => b.value - a.value);
  if (sort === 'age') out.sort((a, b) => b.ageDays - a.ageDays);
  if (sort === 'closing') out.sort((a, b) => byClosing(a).localeCompare(byClosing(b)));
  return out;
}

/** Σ value × probability, rounded once — the server's (and Insights') way. */
const weightedOf = (cards: Card[]) => Math.round(cards.reduce((s, c) => s + (c.value * c.probability) / 100, 0) * 100) / 100;
const valueOf = (cards: Card[]) => Math.round(cards.reduce((s, c) => s + c.value, 0) * 100) / 100;

/**
 * SCORO's view: one column a stage, each gathering the cards of the fine
 * columns that stand in it (the server says which stage each card is in, so
 * a won quotation with a sales order lands in Completed). Derived from the
 * fine columns, so an optimistic move shows in both views at once.
 */
function stageColumns(board: Board): Column[] {
  const all = board.columns.flatMap((c) => c.cards);
  return board.stages
    .filter((s) => s.inActiveList)
    .map((s) => {
      const cards = all.filter((c) => c.stage === s.key);
      return {
        key: s.key,
        label: s.label,
        kind: 'stage' as const,
        count: cards.length,
        value: valueOf(cards),
        weighted: weightedOf(cards),
        cards,
        color: s.color,
        explanation: s.explanation,
        columns: s.columns,
      };
    });
}

/**
 * Where a card goes when dropped on a stage: the first of the stage's own
 * columns the server allows it to move to. Null with a reason explains why
 * not — Completed is never a drop target, it is worked out.
 */
function stageTarget(card: Card, stage: StageDef): { key: string | null; reason: string | null } {
  if (card.stage === stage.key) return { key: null, reason: null };
  const key = stage.columns.find((k) => k !== card.column && card.allowedTargets.includes(k)) ?? null;
  if (key) return { key, reason: null };
  if (stage.key === 'COMPLETED') {
    return { key: null, reason: 'Completed is a won quotation with a sales order or project — create one from the quotation' };
  }
  if (card.column === 'WON') return { key: null, reason: 'Already won — it shows as Completed because it has a sales order or project' };
  return { key: null, reason: refusalFor(card, stage.columns[0]) ?? 'Not a move this card can make' };
}

// ════════════════════════════════════════════════════════════════════
//  THE BOARD
// ════════════════════════════════════════════════════════════════════

export function Pipeline() {
  const { can, me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [view, setViewState] = useState<PipelineView>(() => readStoredView() ?? DEFAULT_VIEW);
  const hadStoredView = useRef(readStoredView() !== null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [knownPeople, setKnownPeople] = useState<Map<string, BoardPerson>>(new Map());

  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ key: string; reason: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const pendingFocus = useRef<string | null>(null);

  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [savingView, setSavingView] = useState(false);
  const [customising, setCustomising] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [creating, setCreating] = useState<'lead' | 'forecast' | null>(null);
  /** The view a "Delete the view?" question names: picking another view withdraws the question. */
  const viewInQuestion = useRef<string | null>(null);
  const closeConfirm = confirm.close;
  useEffect(() => {
    if (viewInQuestion.current !== null && viewInQuestion.current !== activeViewId) {
      viewInQuestion.current = null;
      closeConfirm();
    }
  }, [activeViewId, closeConfirm]);
  const navigate = useNavigate();
  const [people, setPeople] = useState<Person[]>([]);

  const setView = useCallback((next: PipelineView | ((v: PipelineView) => PipelineView)) => {
    setViewState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      storeView(v);
      return v;
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(
    () => ({
      ownerId: view.ownerId || undefined,
      decidedWithinDays: view.decidedWithinDays,
      search: debounced || undefined,
    }),
    [view.ownerId, view.decidedWithinDays, debounced],
  );

  const load = useCallback(async () => {
    try {
      const res = await api.get<Board>(`/pipeline${qs(query)}`);
      setBoard(res);
      setKnownPeople((prev) => {
        const next = new Map(prev);
        for (const p of res.people) next.set(p.id, p);
        return next;
      });
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadViews = useCallback(async () => {
    try {
      setSavedViews(await api.get<SavedView[]>('/saved-filters/pipeline'));
    } catch {
      setSavedViews([]);
    }
  }, []);

  useEffect(() => {
    void loadViews();
  }, [loadViews]);

  // No working view in this browser: start from the person's own "Default".
  useEffect(() => {
    if (hadStoredView.current || !me) return;
    const mine = savedViews.find((v) => v.userId === me.user.id && v.name.toLowerCase() === 'default');
    if (mine) {
      hadStoredView.current = true;
      setActiveViewId(mine.id);
      setView(sanitiseView(mine.query));
    }
  }, [savedViews, me, setView]);

  // Keep keyboard focus on a card after it moved and the board re-rendered.
  useEffect(() => {
    const ref = pendingFocus.current;
    if (!ref) return;
    const el = document.querySelector<HTMLElement>(`[data-card-ref="${CSS.escape(ref)}"]`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  }, [board]);

  function announce(text: string) {
    // Clearing first makes a repeated message announce again.
    setLive('');
    window.setTimeout(() => setLive(text), 30);
  }

  /**
   * A move. LOST asks "Why was it lost?" first, in the confirm bar under the
   * board's head (the lead and quotation pages ask it the same way under
   * theirs); every other move goes straight through.
   */
  async function move(card: Card, key: string) {
    const reason = refusalFor(card, key);
    if (reason) {
      announce(reason);
      toast('warn', reason);
      return;
    }
    if (key === 'LOST') {
      viewInQuestion.current = null;
      confirm.ask({
        title: `Mark ${card.number} lost?`,
        body: 'Price, timing, went to a competitor, project shelved… Sales Analytics groups these, so a few plain words beat a paragraph.',
        confirmLabel: 'Mark lost',
        reason: 'required',
        reasonLabel: 'Why was it lost?',
        // A few plain words — the board always asked for three characters at least.
        minReason: 3,
        // Through the ref: the bar outlives this render, and the move must
        // roll back to the board as it is when the person confirms.
        onConfirm: (lostReason) => sendMoveRef.current(card, 'LOST', lostReason),
      });
      return;
    }
    await sendMove(card, key);
  }

  /**
   * Optimistic: the card jumps now; the server's answer re-derives every total.
   * With a lost reason it was asked in the confirm bar, so a refusal rolls the
   * board back and is THROWN — the bar shows it and stays open with the reason
   * typed so far — rather than toasted.
   */
  async function sendMove(card: Card, key: string, lostReason?: string) {
    const asked = lostReason !== undefined;
    const before = board;
    if (board) {
      setBoard({
        ...board,
        columns: board.columns.map((col) => {
          if (col.key === card.column) {
            const cards = col.cards.filter((c) => c.ref !== card.ref);
            return { ...col, cards, count: cards.length, value: valueOf(cards), weighted: weightedOf(cards) };
          }
          if (col.key === key) {
            const cards = [{ ...card, column: key, allowedTargets: [] }, ...col.cards];
            return { ...col, cards, count: cards.length, value: valueOf(cards), weighted: weightedOf(cards) };
          }
          return col;
        }),
      });
    }
    pendingFocus.current = card.ref;
    try {
      await api.patch(card.kind === 'lead' ? `/leads/${card.id}` : `/quotations/${card.id}`, payloadFor(card, key, lostReason));
      // In the stage view the person dropped the card on a STAGE, so the
      // toast names the stage — the status the quotation page prints too
      // (2026-10-08) — not the fine column the drop resolved to.
      const stageLabel = view.stages !== 'detailed' ? board?.stages.find((s) => s.columns.includes(key))?.label : undefined;
      const where = stageLabel ?? LABELS[key] ?? key;
      const text = `Moved ${card.number} to ${where}${card.kind === 'quotation' ? ` — the quotation's status now reads ${where}` : ''}`;
      toast('ok', text);
      announce(text);
      await load();
    } catch (err) {
      setBoard(before);
      const message = err instanceof ApiError ? err.message : 'The move did not go through';
      announce(`${card.number} was not moved: ${message}`);
      if (asked) throw err;
      toast('error', message);
      if (err instanceof ApiError && err.status === 400) return;
      throw err;
    }
  }
  const sendMoveRef = useRef(sendMove);
  sendMoveRef.current = sendMove;

  function tryMove(card: Card, key: string) {
    move(card, key).catch(() => {});
  }

  const stageMode = view.stages !== 'detailed';

  /**
   * What a drop on `key` means for this card: in the stage view the stage's
   * own column the server allows; in the detailed view the column itself.
   */
  function resolveDrop(card: Card, key: string): { key: string | null; reason: string | null } {
    if (key === FORECAST) return { key: null, reason: refusalFor(card, FORECAST) };
    if (stageMode) {
      const stage = board?.stages.find((s) => s.key === key);
      return stage ? stageTarget(card, stage) : { key: null, reason: 'Not a stage' };
    }
    if (key === card.column) return { key: null, reason: null };
    return card.allowedTargets.includes(key) ? { key, reason: null } : { key: null, reason: refusalFor(card, key) };
  }

  /** Shift+Arrow: the nearest column (or stage) this card may go to, in board order. LOST is skipped: it asks for a reason. */
  function stepTarget(card: Card, dir: -1 | 1): string | null {
    if (stageMode) {
      const order = (board?.stages ?? []).filter((s) => s.inActiveList).map((s) => s.key);
      let i = order.indexOf(card.stage);
      if (i < 0) return null;
      for (i += dir; i >= 0 && i < order.length; i += dir) {
        if (order[i] === 'LOST') continue;
        const t = resolveDrop(card, order[i]);
        if (t.key) return t.key;
      }
      return null;
    }
    const order = view.columns.filter((k) => k !== FORECAST);
    let i = order.indexOf(card.column);
    if (i < 0) return null;
    for (i += dir; i >= 0 && i < order.length; i += dir) {
      if (order[i] !== 'LOST' && card.allowedTargets.includes(order[i])) return order[i];
    }
    return null;
  }

  /** The Move menu's choices in the stage view: each active stage, resolved for this card. */
  function stageOptions(card: Card): { key: string; label: string; target: string | null; why: string | null }[] | null {
    if (!stageMode || !board) return null;
    const options = board.stages
      .filter((s) => s.inActiveList && s.key !== card.stage)
      .map((s) => {
        const t = stageTarget(card, s);
        return { key: s.key, label: s.label, target: t.key, why: t.reason };
      })
      .filter((o) => o.target || o.why);
    if (!board.stages.some((s) => s.key === 'LOST' && s.inActiveList) && card.allowedTargets.includes('LOST')) {
      options.push({ key: 'LOST', label: 'Lost', target: 'LOST', why: null });
    }
    return options;
  }

  function onCardKey(e: KeyboardEvent<HTMLDivElement>, card: Card) {
    if (e.target !== e.currentTarget) return; // the title link and Move button handle their own keys
    if ((e.key === 'Enter' || e.key === ' ') && card.canMove) {
      e.preventDefault();
      setMenuFor(card.ref);
      return;
    }
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (!card.canMove) {
        announce(refusalFor(card, 'NEW') ?? 'This card cannot be moved');
        return;
      }
      const to = stepTarget(card, e.key === 'ArrowLeft' ? -1 : 1);
      if (!to) {
        announce(`${card.number} cannot move further that way`);
        return;
      }
      tryMove(card, to);
    }
  }

  // ── Drag and drop ──
  function dragOver(e: React.DragEvent, key: string) {
    if (!dragging) return;
    const t = resolveDrop(dragging, key);
    if (t.key) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
      if (refused) setRefused(null);
    } else if (t.reason) {
      if (refused?.key !== key) {
        setRefused({ key, reason: t.reason });
        announce(t.reason);
      }
      if (over) setOver(null);
    }
  }

  function drop(e: React.DragEvent, key: string) {
    e.preventDefault();
    const card = dragging;
    setDragging(null);
    setOver(null);
    setRefused(null);
    if (!card) return;
    const t = resolveDrop(card, key);
    if (t.key) tryMove(card, t.key);
  }

  function endDrag() {
    setDragging(null);
    setOver(null);
    setRefused(null);
  }

  // ── Views ──
  const activeView = savedViews.find((v) => v.id === activeViewId) ?? null;
  const ownsActive = !!activeView && !!me && activeView.userId === me.user.id;

  async function updateView() {
    if (!activeView) return;
    try {
      await api.patch(`/saved-filters/${activeView.id}`, { query: view });
      toast('ok', `View “${activeView.name}” updated`);
      await loadViews();
    } catch (err) {
      setError(err);
    }
  }

  /** Asks first, under the board's head; a refusal shows in the bar, which stays open. */
  function deleteView() {
    if (!activeView) return;
    const doomed = activeView;
    viewInQuestion.current = doomed.id;
    confirm.ask({
      title: `Delete the view “${doomed.name}”?`,
      body: doomed.isShared
        ? 'It is shared — it goes from everyone’s list of views. The board itself is not changed.'
        : 'The board itself is not changed; only the saved view goes.',
      confirmLabel: 'Delete view',
      onConfirm: async () => {
        await api.del(`/saved-filters/${doomed.id}`);
        toast('ok', `View “${doomed.name}” deleted`);
        viewInQuestion.current = null;
        setActiveViewId('');
        await loadViews();
      },
    });
  }

  async function exportCsv() {
    try {
      await downloadBlob(`/pipeline/board.csv${qs(query)}`, 'sales-pipeline.csv');
    } catch (err) {
      setError(err);
    }
  }

  async function openCreate(kind: 'lead' | 'quotation' | 'forecast') {
    setNewMenu(false);
    // A quotation is written on its own full page (the SCORO editor), not a dialog.
    if (kind === 'quotation') {
      navigate('/g-ops/quotations/new');
      return;
    }
    if (people.length === 0) {
      setPeople(await loadPeople().catch(() => []));
    }
    setCreating(kind);
  }

  // ── What to draw ──
  const columnsByKey = useMemo(() => {
    const map = new Map<string, Column>();
    for (const c of board?.columns ?? []) map.set(c.key, c);
    if (board) map.set(FORECAST, { ...board.forecast, kind: 'forecast' });
    return map;
  }, [board]);

  const forecastColumn = columnsByKey.get(FORECAST);
  const ordered = stageMode
    ? board
      ? [...stageColumns(board), ...(forecastColumn ? [forecastColumn] : [])]
      : []
    : view.columns.map((k) => columnsByKey.get(k)).filter((c): c is Column => !!c);
  const peopleList = [...knownPeople.values()].sort((a, b) => a.name.localeCompare(b.name));
  const lanes =
    view.groupBy === 'owner'
      ? (board?.people ?? []).map((p) => ({ person: p, columns: ordered.map((c) => narrow(c, p.id)) }))
      : null;
  const isEmpty = !!board && board.columns.every((c) => c.count === 0);
  const canCreateLead = can('gops.leads.create');
  const canCreateQuote = can('gops.quotations.create');

  const newMenuButton = (canCreateLead || canCreateQuote) && (
    <div className="pipe-menu-wrap">
      <button
        className="btn btn-primary btn-sm"
        aria-haspopup="menu"
        aria-expanded={newMenu}
        onClick={() => setNewMenu((o) => !o)}
      >
        + New ▾
      </button>
      {newMenu && (
        <Menu onClose={() => setNewMenu(false)} label="Create">
          {canCreateLead && (
            <button role="menuitem" onClick={() => void openCreate('lead')}>
              Lead
            </button>
          )}
          {canCreateLead && (
            <button role="menuitem" onClick={() => void openCreate('forecast')}>
              Forecast deal
            </button>
          )}
          {canCreateQuote && (
            <button role="menuitem" onClick={() => void openCreate('quotation')}>
              Quotation
            </button>
          )}
        </Menu>
      )}
    </div>
  );

  if (loading && !board) return <Loading />;

  const drawColumns = (cols: Column[], laneKey = '') => (
    <div className={`pipeline${stageMode ? ' fit' : ''}`} role="list" aria-label={laneKey ? `Pipeline for ${laneKey}` : 'Pipeline'}>
      {cols.map((col) => (
        <PipeColumn
          key={col.key}
          column={col}
          color={col.color}
          collapsed={view.collapsed.includes(col.key)}
          over={over === col.key}
          refusal={refused?.key === col.key ? refused.reason : null}
          onToggle={() =>
            setView((v) => ({
              ...v,
              collapsed: v.collapsed.includes(col.key) ? v.collapsed.filter((k) => k !== col.key) : [...v.collapsed, col.key],
            }))
          }
          onDragOver={(e) => dragOver(e, col.key)}
          onDragLeave={() => {
            if (over === col.key) setOver(null);
          }}
          onDrop={(e) => drop(e, col.key)}
        >
          {sortCards(col.cards, view.sort).map((card) => (
            <PipeCard
              key={`${col.key}-${card.ref}`}
              card={card}
              inForecast={col.key === FORECAST}
              fields={view.cardFields}
              dragging={dragging?.ref === card.ref}
              menuOptions={stageOptions(card)}
              menuOpen={menuFor === card.ref && col.key !== FORECAST}
              onOpenMenu={() => setMenuFor(card.ref)}
              onCloseMenu={() => setMenuFor(null)}
              onKeyDown={(e) => onCardKey(e, card)}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', card.ref);
                e.dataTransfer.effectAllowed = 'move';
                setDragging(card);
              }}
              onDragEnd={endDrag}
              onMove={(key) => {
                setMenuFor(null);
                tryMove(card, key);
              }}
            />
          ))}
        </PipeColumn>
      ))}
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Pipeline</h1>
          <p>
            Every open lead and quotation in SCORO’s stages. Drag a card to move it, or press Enter on it
            for the Move menu; a move sets the deal’s odds the way the stage says.
          </p>
        </div>
        {newMenuButton}
      </div>

      {confirm.bar}

      <ErrorBox error={error} />

      <div className="pipe-toolbar">
        <label className="visually-hidden" htmlFor="pipe-view">
          Saved view
        </label>
        <select
          id="pipe-view"
          className="pipe-select"
          value={activeViewId}
          title="Saved views — save or change one under Customise"
          onChange={(e) => {
            const id = e.target.value;
            setActiveViewId(id);
            const chosen = savedViews.find((v) => v.id === id);
            if (chosen) setView(sanitiseView(chosen.query));
          }}
        >
          <option value="">Working view</option>
          {savedViews.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {me && v.userId !== me.user.id ? ' (shared)' : v.isShared ? ' · shared' : ''}
            </option>
          ))}
        </select>

        <label className="visually-hidden" htmlFor="pipe-owner">
          Salesperson
        </label>
        <select
          id="pipe-owner"
          className="pipe-select"
          value={view.ownerId}
          onChange={(e) => setView((v) => ({ ...v, ownerId: e.target.value }))}
        >
          <option value="">All salespeople</option>
          {peopleList.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className="visually-hidden" htmlFor="pipe-search">
          Search the board
        </label>
        <input
          id="pipe-search"
          className="pipe-search"
          type="search"
          placeholder="Search number, customer, subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="scope-switch" role="group" aria-label="Which columns">
          <button
            className={stageMode ? 'active' : ''}
            aria-pressed={stageMode}
            onClick={() => setView((v) => ({ ...v, stages: 'stages' }))}
            title="SCORO’s stages: Opportunity, Negotiation, Closing, Confirmed, Completed"
          >
            Stages
          </button>
          <button
            className={!stageMode ? 'active' : ''}
            aria-pressed={!stageMode}
            onClick={() => setView((v) => ({ ...v, stages: 'detailed' }))}
            title="Every step: New, Contacted, Qualified, Site visit, Costing, Quotation drafted…"
          >
            All steps
          </button>
        </div>

        <button
          className={`btn btn-sm${customising ? ' btn-active' : ''}`}
          aria-expanded={customising}
          aria-controls="pipe-customise"
          onClick={() => setCustomising((o) => !o)}
        >
          Customise ▾
        </button>
      </div>

      {customising && (
        <Customise
          view={view}
          setView={setView}
          onClose={() => setCustomising(false)}
          activeViewName={activeView?.name ?? null}
          ownsActive={ownsActive}
          onSaveView={() => setSavingView(true)}
          onUpdateView={() => void updateView()}
          onDeleteView={deleteView}
          canExport={can('gops.pipeline.export')}
          onExport={() => void exportCsv()}
        />
      )}

      {board && <KpiRow kpis={board.kpis} board={board} show={view.kpis} canInsights={can('insights.pipeline.view_all')} />}

      {isEmpty ? (
        <div className="card">
          <Empty
            title={debounced || view.ownerId ? 'Nothing on the board matches' : 'Nothing in the pipeline yet'}
            hint={
              debounced || view.ownerId
                ? 'Clear the search or pick all salespeople.'
                : 'Add a lead the moment an enquiry arrives, and it appears here.'
            }
          />
        </div>
      ) : lanes ? (
        <div className="pipe-lanes">
          {lanes.map(({ person, columns }) => {
            const cards = columns.filter((c) => c.key !== FORECAST).flatMap((c) => c.cards);
            return (
              <section key={person.id} className="pipe-lane" aria-label={person.name}>
                <div className="pipe-lane-head">
                  <span className="row">
                    <Avatar name={person.name} photoId={person.photoPath} size={24} />
                    <strong>{person.name}</strong>
                  </span>
                  <span className="pipe-lane-totals">
                    {cards.length} card{cards.length === 1 ? '' : 's'} · {formatMoney(valueOf(cards))} ·{' '}
                    {formatMoney(weightedOf(cards))} weighted
                  </span>
                </div>
                {drawColumns(columns, person.name)}
              </section>
            );
          })}
        </div>
      ) : (
        drawColumns(ordered)
      )}

      <div className="pipe-live" aria-live="polite" role="status">
        {live}
      </div>

      {savingView && (
        <SaveViewModal
          onClose={() => setSavingView(false)}
          onSave={async (name, isShared) => {
            const row = await api.post<SavedView>('/saved-filters/pipeline', { name, query: view, isShared });
            setSavingView(false);
            toast('ok', `View “${name}” saved`);
            await loadViews();
            setActiveViewId(row.id);
          }}
        />
      )}

      {creating === 'lead' && (
        <LeadForm
          people={people}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            void load();
          }}
        />
      )}
      {creating === 'forecast' && (
        <ForecastDealForm
          people={people}
          me={me?.user.id ?? ''}
          onClose={() => setCreating(null)}
          onSaved={(closingThisMonth) => {
            setCreating(null);
            toast('ok', closingThisMonth ? 'On the board and in this month\u2019s forecast' : 'On the board \u2014 it joins the forecast in its closing month');
            void load();
          }}
        />
      )}
    </div>
  );
}

/** One owner's slice of a column, with its own totals. */
function narrow(col: Column, ownerId: string): Column {
  const cards = col.cards.filter((c) => c.owner.id === ownerId);
  return { ...col, cards, count: cards.length, value: valueOf(cards), weighted: weightedOf(cards) };
}

// ── KPI row ──────────────────────────────────────────────────────────────────

function KpiRow({ kpis, board, show, canInsights }: { kpis: Kpis; board: Board; show: string[]; canInsights: boolean }) {
  const tiles: Record<string, ReactNode> = {
    discount: (
      <Stat
        key="discount"
        label="Average discount"
        value={kpis.averageDiscountPct === null ? '—' : `${kpis.averageDiscountPct}%`}
        sub={kpis.averageDiscountPct === null ? 'no open quotation to average' : 'the discount on open quotations, averaged'}
      />
    ),
    open: (
      <Stat
        key="open"
        label="Total"
        value={kpis.openQuotes}
        sub={`and ${kpis.leadCount} lead${kpis.leadCount === 1 ? '' : 's'} estimated at ${formatMoney(kpis.leadEstimate)}`}
      />
    ),
    quoted: <Stat key="quoted" label="Sum" value={formatMoney(kpis.quotedValue)} figure sub="open quotations, approved revision else latest" />,
    weighted: <Stat key="weighted" label="Weighted" value={formatMoney(kpis.weightedValue)} figure tone="neon" sub="amount × probability" />,
    average: (
      <Stat
        key="average"
        label="Average quote"
        value={kpis.averageQuote === null ? '—' : formatMoney(kpis.averageQuote)}
        figure
        sub={kpis.averageDiscountPct === null ? 'no open quotation to average' : `average discount ${kpis.averageDiscountPct}%`}
      />
    ),
    margin:
      kpis.expectedMarginPct === null ? (
        <Stat key="margin" label="Margin" value="—" sub="expected, from costing — none linked to an open quote" />
      ) : (
        <Stat
          key="margin"
          label="Margin"
          value={`${kpis.expectedMarginPct}%`}
          figure
          accent={kpis.expectedMarginPct < 0 ? 'danger' : kpis.expectedMarginPct < 10 ? 'warn' : undefined}
          sub={`from costing, ${kpis.marginSample.withCosting} of ${kpis.marginSample.open} quotes`}
        />
      ),
    overdue: (
      <Stat
        key="overdue"
        label="Overdue"
        value={kpis.overdue}
        accent={kpis.overdue > 0 ? 'danger' : undefined}
        sub="past expected close, next action or validity"
      />
    ),
    won: (
      <Stat
        key="won"
        label="Won this period"
        value={formatMoney(kpis.wonValue)}
        figure
        accent="ok"
        sub={`${kpis.wonCount} won · ${kpis.lostCount} lost · last ${board.window.decidedWithinDays} days`}
        to={canInsights ? '/insights/pipeline' : undefined}
        more={canInsights ? 'Sales Analytics' : undefined}
      />
    ),
    forecast: (
      <Stat
        key="forecast"
        label="This month forecast"
        value={formatMoney(kpis.forecastWeighted)}
        figure
        sub={`${formatMoney(kpis.forecastValue)} unweighted · ${kpis.forecastCount} card${kpis.forecastCount === 1 ? '' : 's'}${
          kpis.unprobabled ? ` · ${kpis.unprobabled} with no probability yet` : ''
        }`}
      />
    ),
  };
  const visible = KPI_TILES.filter((t) => show.includes(t.key));
  if (visible.length === 0) return null;
  return <div className="kpi-grid pipe-kpis">{visible.map((t) => tiles[t.key])}</div>;
}

// ── Column ───────────────────────────────────────────────────────────────────

function PipeColumn({
  column,
  color,
  collapsed,
  over,
  refusal,
  onToggle,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: {
  column: Column;
  color?: string;
  collapsed: boolean;
  over: boolean;
  refusal: string | null;
  onToggle: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  children: ReactNode;
}) {
  const forecast = column.key === FORECAST;
  // A stage column lists what its first fine column lists; Opportunity, which
  // mixes leads and drafted quotes, opens the leads.
  const listFor = (key: string) =>
    LEAD_KEYS.includes(key)
      ? `/g-ops/leads${qs({ status: key })}`
      : QUOTATION_KEYS.includes(key) || key === 'WON' || key === 'LOST'
        ? `/g-ops/quotations${qs({ outcome: key === 'QUOTED' ? 'OPEN' : key })}`
        : null;
  const listLink =
    column.kind === 'stage' ? (column.key === 'OPPORTUNITY' ? '/g-ops/leads' : listFor(column.columns?.[0] ?? '')) : listFor(column.key);
  const cls = `pipe-col${forecast ? ' forecast' : ''}${collapsed ? ' collapsed' : ''}${over ? ' over' : ''}${refusal ? ' refused' : ''}${color ? ' has-color' : ''}`;
  return (
    <section
      className={cls}
      style={color ? ({ '--stage-color': color } as React.CSSProperties) : undefined}
      data-tone={color ? undefined : COLUMN_TONE[column.key] || undefined}
      role="listitem"
      aria-label={`${column.label}: ${column.count} card${column.count === 1 ? '' : 's'}, ${formatMoney(column.value)}`}
      // The forecast never calls preventDefault, so nothing can be dropped on it.
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={forecast ? undefined : onDrop}
    >
      {/* SCORO's column band: the stage, "N deals", and the total sum on a tint. */}
      <div className="pipe-band">
        <div className="pipe-head">
          <strong>{column.label}</strong>
          <span className="pipe-head-tools">
            <button
              className="pipe-collapse"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          </span>
        </div>
        <div className="pipe-count">
          {column.count} deal{column.count === 1 ? '' : 's'}
        </div>
        <div className="pipe-total mono">
          {formatMoney(column.value)} <span className="faint">(Total sum)</span>
        </div>
        {column.weighted !== column.value && (
          <div className="pipe-total weighted faint mono">{formatMoney(column.weighted)} weighted</div>
        )}
      </div>
      {forecast && !collapsed && <div className="pipe-note">Worked out from expected closing — not a drop target.</div>}
      {refusal && <div className="pipe-refusal">{refusal}</div>}
      {!collapsed && (
        <div className="pipe-body">
          {children}
          {column.count === 0 && <div className="pipe-note">Nothing here{forecast ? ' closing this month' : ''}.</div>}
        </div>
      )}
      {!collapsed && listLink && (
        <Link className="pipe-list-link" to={listLink}>
          Open as list ›
        </Link>
      )}
    </section>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

function PipeCard({
  card,
  inForecast,
  fields,
  dragging,
  menuOptions,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  card: Card;
  inForecast: boolean;
  fields: string[];
  dragging: boolean;
  /** The stage view's choices; null in the detailed view, where the columns are the choices. */
  menuOptions: { key: string; label: string; target: string | null; why: string | null }[] | null;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onMove: (key: string) => void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const show = (f: string) => fields.includes(f);
  const ageId = `age-${card.kind}-${card.id}${inForecast ? '-f' : ''}`;
  const movable = card.canMove && !inForecast;
  const next = card.nextStep;
  const nextOverdue = !!next?.at && new Date(next.at).getTime() < Date.now();

  return (
    <div
      ref={self}
      className={`pipe-card${dragging ? ' dragging' : ''}`}
      role="listitem"
      tabIndex={0}
      data-card-ref={inForecast ? undefined : card.ref}
      draggable={movable}
      aria-roledescription="pipeline card"
      aria-label={`${card.number}, ${card.title}, ${formatMoney(card.value)}, ${LABELS[card.column] ?? card.column}`}
      aria-describedby={show('age') ? ageId : undefined}
      onKeyDown={movable ? onKeyDown : undefined}
      onDragStart={movable ? onDragStart : undefined}
      onDragEnd={movable ? onDragEnd : undefined}
    >
      {/*
        SCORO's card (the owner's pipeline screenshot): the deal's name in
        bold, the company under it, the owner's face top-right, and a footer
        of age on the left against the amount on the right.
      */}
      <div className="pipe-card-row">
        <Link to={card.link} className="pipe-card-title" draggable={false}>
          {(show('subject') && card.subject) || (show('customer') ? card.title : card.number)}
        </Link>
        {show('owner') && (
          <span className="pipe-card-face" title={card.owner.name}>
            <Avatar name={card.owner.name} photoId={card.owner.photoPath} size={22} />
          </span>
        )}
      </div>
      {show('customer') && show('subject') && card.subject && <div className="pipe-card-sub">{card.title}</div>}
      {show('subject') && (
        <div className="pipe-card-sub">
          <span className="mono">{card.number}</span> <span className="tag">{card.kind === 'quotation' ? 'QT' : 'LEAD'}</span>
        </div>
      )}
      {(show('probability') || (show('weighted') && card.weighted !== card.value)) && (
        <div className="pipe-card-sub mono">
          {show('probability') ? `${card.probability}%` : ''}
          {show('weighted') && card.weighted !== card.value
            ? `${show('probability') ? ' · ' : ''}${formatMoney(card.weighted)} weighted`
            : ''}
        </div>
      )}
      {show('revision') && card.revision && (
        <div className="pipe-card-sub">
          R{card.revision.n} <StatusBadge status={card.revision.status} extra={{ SUPERSEDED: '' }} />
        </div>
      )}
      {(show('age') || show('value')) && (
        <div className="pipe-card-row pipe-card-foot">
          {show('age') ? (
            <span
              id={ageId}
              className={`pipe-age${card.overdue ? ' stale' : ''}`}
              title={card.overdue ? 'Past its expected close, next action or validity' : `${card.ageDays} days in the pipeline`}
            >
              {card.ageDays}d{card.overdue ? ' · overdue' : ''}
            </span>
          ) : (
            <span />
          )}
          {show('value') && <span className="pipe-card-amount mono">{formatMoney(card.value)}</span>}
        </div>
      )}
      {show('next') && next && (
        <div className={`pipe-card-sub${nextOverdue ? ' pipe-overdue' : ''}`}>
          Next: {next.label}
          {next.at ? ` · ${formatDate(next.at)}` : ''}
          {nextOverdue ? ' · overdue' : ''}
        </div>
      )}
      {card.expectedClosing && inForecast && (
        <div className="pipe-card-sub">Closing {formatDate(card.expectedClosing)}</div>
      )}
      {card.column === 'LOST' && card.lostReason && <div className="pipe-card-sub">Lost: {card.lostReason}</div>}
      {show('job') && card.column === 'WON' && (
        <div className="pipe-card-sub">
          {card.job ? (
            <Link to={`/g-ops/projects/${card.job.id}`} className="tag">
              Job {card.job.number}
            </Link>
          ) : (
            <Link to={`/g-ops/quotations/${card.id}`}>Create project ›</Link>
          )}
        </div>
      )}
      {movable && (
        <div className="pipe-menu-wrap pipe-card-actions">
          <button
            className="btn btn-sm"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? onCloseMenu() : onOpenMenu())}
          >
            Move ▾
          </button>
          {menuOpen && (
            <MoveMenu
              card={card}
              options={menuOptions}
              onMove={onMove}
              onClose={() => {
                onCloseMenu();
                self.current?.focus();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The keyboard and touch way to move a card. Arrow keys cycle, Escape closes. */
function MoveMenu({
  card,
  options,
  onMove,
  onClose,
}: {
  card: Card;
  options: { key: string; label: string; target: string | null; why: string | null }[] | null;
  onMove: (key: string) => void;
  onClose: () => void;
}) {
  const targets = card.allowedTargets;
  const cannotWin = !options && card.kind === 'quotation' && !card.hasApprovedRevision && card.column !== 'WON';
  return (
    <Menu onClose={onClose} label={`Move ${card.number}`}>
      {options
        ? options.map((o) =>
            o.target ? (
              <button key={o.key} role="menuitem" onClick={() => onMove(o.target!)}>
                {o.target === 'LOST' ? 'Mark lost…' : `Move to ${o.label}`}
              </button>
            ) : (
              <button key={o.key} role="menuitem" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                {o.label}
                <span className="menu-pop-why">{o.why}</span>
              </button>
            ),
          )
        : targets.map((key) => (
            <button key={key} role="menuitem" onClick={() => onMove(key)}>
              {key === 'LOST' ? 'Mark lost…' : `Move to ${LABELS[key] ?? key}`}
            </button>
          ))}
      {cannotWin && (
        <button role="menuitem" aria-disabled="true" onClick={(e) => e.preventDefault()}>
          Won
          <span className="menu-pop-why">Needs an approved revision — open the quotation to submit it</span>
        </button>
      )}
      <Link role="menuitem" to={card.link}>
        Open {card.kind === 'lead' ? 'lead' : 'quotation'}
      </Link>
    </Menu>
  );
}

// ── Customise ────────────────────────────────────────────────────────────────

function Customise({
  view,
  setView,
  onClose,
  activeViewName,
  ownsActive,
  onSaveView,
  onUpdateView,
  onDeleteView,
  canExport,
  onExport,
}: {
  view: PipelineView;
  setView: (fn: (v: PipelineView) => PipelineView) => void;
  onClose: () => void;
  activeViewName: string | null;
  ownsActive: boolean;
  onSaveView: () => void;
  onUpdateView: () => void;
  onDeleteView: () => void;
  canExport: boolean;
  onExport: () => void;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button, select')?.focus();
  }, []);

  const toggle = (list: 'collapsed' | 'cardFields' | 'kpis', key: string, on: boolean) =>
    setView((v) => ({ ...v, [list]: on ? [...new Set([...v[list], key])] : v[list].filter((k) => k !== key) }));

  const shift = (key: string, dir: -1 | 1) =>
    setView((v) => {
      const cols = [...v.columns];
      const i = cols.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cols.length) return v;
      [cols[i], cols[j]] = [cols[j], cols[i]];
      return { ...v, columns: cols };
    });

  return (
    <section
      ref={ref}
      id="pipe-customise"
      className="card pipe-customise"
      aria-label="Customise the board"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="pipe-popover-grid">
        <fieldset>
          <legend>This view</legend>
          <p className="pipe-note">{activeViewName ? `“${activeViewName}”` : 'The working view — remembered in this browser.'}</p>
          <div className="pipe-customise-actions">
            <button className="btn btn-sm" onClick={onSaveView}>
              Save as…
            </button>
            {ownsActive && (
              <>
                <button className="btn btn-sm" onClick={onUpdateView}>
                  Update view
                </button>
                <button className="btn btn-sm btn-danger-ghost" onClick={onDeleteView}>
                  Delete view
                </button>
              </>
            )}
            {canExport && (
              <button className="btn btn-sm" onClick={onExport}>
                Export CSV
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setView(() => DEFAULT_VIEW)}>
              Standard board
            </button>
          </div>
          <Field label="Group">
            <div className="scope-switch" role="group" aria-label="Group by">
              <button
                className={view.groupBy === 'none' ? 'active' : ''}
                aria-pressed={view.groupBy === 'none'}
                onClick={() => setView((v) => ({ ...v, groupBy: 'none' }))}
              >
                One board
              </button>
              <button
                className={view.groupBy === 'owner' ? 'active' : ''}
                aria-pressed={view.groupBy === 'owner'}
                onClick={() => setView((v) => ({ ...v, groupBy: 'owner' }))}
              >
                By salesperson
              </button>
            </div>
          </Field>
          <Field label="Won and lost shown for">
            <select value={view.decidedWithinDays} onChange={(e) => setView((v) => ({ ...v, decidedWithinDays: Number(e.target.value) }))}>
              {[30, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  the last {d} days
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort each column by">
            <select value={view.sort} onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as Sort }))}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
        <fieldset>
          <legend>Figures across the top</legend>
          {KPI_TILES.map((t) => (
            <Checkbox key={t.key} checked={view.kpis.includes(t.key)} onChange={(on) => toggle('kpis', t.key, on)} label={t.label} />
          ))}
        </fieldset>
        <fieldset>
          <legend>On each card</legend>
          {CARD_FIELDS.map((f) => (
            <Checkbox
              key={f.key}
              checked={view.cardFields.includes(f.key)}
              onChange={(on) => toggle('cardFields', f.key, on)}
              label={f.label}
            />
          ))}
        </fieldset>
        <fieldset>
          <legend>Columns of the “All steps” view</legend>
          <p className="pipe-note">Unticked columns collapse to a strip — still a drop target.</p>
          <ol className="pipe-order">
            {view.columns.map((key, i) => (
              <li key={key}>
                <Checkbox
                  checked={!view.collapsed.includes(key)}
                  onChange={(on) => toggle('collapsed', key, !on)}
                  label={LABELS[key] ?? key}
                />
                <span className="pipe-order-buttons">
                  <button
                    className="pipe-collapse"
                    onClick={() => shift(key, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${LABELS[key]} earlier`}
                  >
                    ↑
                  </button>
                  <button
                    className="pipe-collapse"
                    onClick={() => shift(key, 1)}
                    disabled={i === view.columns.length - 1}
                    aria-label={`Move ${LABELS[key]} later`}
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </fieldset>
      </div>
      <div className="pipe-popover-foot">
        <button className="btn btn-sm btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  );
}

function SaveViewModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, isShared: boolean) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), shared);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Save this view"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || name.trim().length < 1}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name" hint="Call one “Default” and the board opens on it in a browser that has no view of its own">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Checkbox checked={shared} onChange={setShared} label="Share with the team — everyone with the board can pick it" />
    </Modal>
  );
}

/**
 * Manual forecast input (2026-10-07, the owner's call): a deal typed straight
 * onto the board, quotation or not. It is filed as a LEAD — the pipeline
 * stays a view over leads and quotations (Phase 3: no third record) — so it
 * is a card at once, and its value × probability joins the weighted forecast
 * the moment its expected closing is set. Source says "Forecast", so
 * hand-typed deals stay tellable from enquiries that rang in.
 */
function ForecastDealForm({
  people,
  me,
  onClose,
  onSaved,
}: {
  people: Person[];
  me: string;
  onClose: () => void;
  onSaved: (closingThisMonth: boolean) => void;
}) {
  const [form, setForm] = useState({
    companyName: '',
    description: '',
    estimatedValue: '',
    probability: '50',
    expectedClosing: '',
    assignedToId: me,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/leads', {
        companyName: form.companyName.trim(),
        description: form.description.trim() || null,
        estimatedValue: Number(form.estimatedValue) || 0,
        probability: Math.round(Number(form.probability) || 0),
        expectedClosing: form.expectedClosing,
        assignedToId: form.assignedToId || undefined,
        source: 'Forecast',
      });
      const month = new Date().toISOString().slice(0, 7);
      onSaved(form.expectedClosing.startsWith(month));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const valid =
    form.companyName.trim().length >= 2 && Number(form.estimatedValue) > 0 && !!form.expectedClosing;

  return (
    <Modal
      title="New forecast deal"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !valid}>
            {busy ? 'Saving\u2026' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p className="muted">
        A deal you know is coming, before any quotation exists. It lands on the board as a lead and
        counts in the weighted forecast from its expected closing \u2014 value \u00d7 probability.
      </p>
      <Field label="Company" required>
        <input
          value={form.companyName}
          autoFocus
          onChange={(e) => setForm({ ...form, companyName: e.target.value })}
          placeholder="Who the deal is with"
        />
      </Field>
      <Field label="What is it">
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="e.g. PSA oxygen generator, Phase 2"
        />
      </Field>
      <div className="grid grid-3">
        <Field label="Estimated value" required>
          <NumberInput
            kind="money"
            min={0}
            value={form.estimatedValue}
            onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })}
          />
        </Field>
        <Field label="Probability %">
          <NumberInput
            kind="percent"
            min={0}
            max={100}
            value={form.probability}
            onChange={(e) => setForm({ ...form, probability: e.target.value })}
          />
        </Field>
        <Field label="Expected closing" required hint="The month it forecasts into">
          <input
            type="date"
            value={form.expectedClosing}
            onChange={(e) => setForm({ ...form, expectedClosing: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Salesperson" hint="They are notified when it is not you">
        <select value={form.assignedToId} onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me ? `${p.name} (me)` : p.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
