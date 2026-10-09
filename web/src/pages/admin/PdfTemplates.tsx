import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, getToken, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dayKeyOf } from '../../lib/day';
import { Checkbox, ErrorBox, Field, Loading, formatDateTime, useToast } from '../../components/ui';
import {
  ANCHOR_HINTS,
  ANCHOR_LABELS,
  ANCHORS_FOR,
  COMPANY_SETTING_NAMES,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  SWATCHES,
  TYPE_LABELS,
  clampToPage,
  emptyFieldsIn,
  listOf,
  pt,
  resolveInline,
  resolveTemplate,
  pageSizeOf,
  tableBottom,
  unknownFieldsIn,
  type Align,
  type Anchor,
  type Block,
  type BlockType,
  type ColumnKey,
  type FieldDef,
  type ItemsBlock,
  type Layout,
  type Orientation,
  type PdfCell,
  type Run,
  type Sample,
  type SignoffsBlock,
  type TextBlock,
  type TotalsBlock,
} from '../../lib/pdfTemplate';
import { NumberInput } from '../../components/NumberInput';
import { useConfirm } from '../../components/Confirm';
import { RecordActions } from '../../components/RecordHeader';
import { useUnsavedChanges } from '../../components/Navigation';

/**
 * Admin › PDF Templates — the designed documents' PDFs, laid out by hand:
 * the quotation (portrait, the customer's paper) and the sales order
 * (landscape, the internal booking record, the one whose line table may
 * place the cost columns).
 *
 * The page is A4 at scale, each box where it prints. Drag a box to move it and
 * a handle to size it; it snaps to the margins and to other boxes' edges, and
 * Alt while dragging stops that. From the keyboard a focused box moves with
 * the arrow keys (Shift for 10pt) and sizes with Ctrl + arrows. What a box
 * prints — fixed text and {{fields}} — is chosen on the right.
 *
 * The page's own drawing is a guide. "Preview PDF" sends the layout as it
 * stands, saved or not, to the server, which prints it with the engine every
 * real quotation goes through — against the sample, or a quotation you pick.
 */

const DOCS = [
  { type: 'quotation', label: 'Quotation', plural: 'Quotations' },
  { type: 'sales_order', label: 'Sales Order', plural: 'Sales orders' },
] as const;
type DocType = (typeof DOCS)[number]['type'];

interface Loaded {
  type: string;
  label: string;
  layout: Layout;
  saved: boolean;
  unreadable: boolean;
  standard: Layout;
  fields: FieldDef[];
  columns: { key: ColumnKey; label: string }[];
  sample: Sample;
  hasLogo: boolean;
}

type View = 'first' | 'later';
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type DragMode = 'move' | Handle | 'flowTop' | 'flowBottom';
type Patch = Partial<TextBlock> & Partial<ItemsBlock> & Partial<TotalsBlock> & Partial<SignoffsBlock> & { color?: string; align?: Align };
/** A change to one box: fixed values, or worked out from the box as it is now (a nudge). */
type BlockChange = Patch | ((b: Block) => Patch);

// ── Undo and redo ─────────────────────────────────────────────────────────────

interface History {
  layout: Layout;
  past: Layout[];
  future: Layout[];
  /** Typing into one property is one step back, not one per keystroke. */
  lastKey: string | null;
  lastAt: number;
}

type HistoryAction =
  | { type: 'load'; layout: Layout }
  /**
   * A change, worked out from the layout as it stands when it is applied — so
   * two arrow presses faster than a render move a box twice, not once.
   */
  | { type: 'edit'; update: (layout: Layout) => Layout; key?: string; at: number }
  /** While a box is being dragged: shown, not yet a step. */
  | { type: 'live'; layout: Layout }
  /** The drag ended; what it started from becomes the step back. */
  | { type: 'settle'; before: Layout }
  | { type: 'undo' }
  | { type: 'redo' };

const same = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);

function history(s: History | null, a: HistoryAction): History | null {
  if (a.type === 'load') return { layout: a.layout, past: [], future: [], lastKey: null, lastAt: 0 };
  if (!s) return s;
  switch (a.type) {
    case 'edit': {
      const next = a.update(s.layout);
      if (next === s.layout) return s;
      const merge = !!a.key && s.lastKey === a.key && a.at - s.lastAt < 1500;
      return {
        layout: next,
        past: merge ? s.past : [...s.past.slice(-99), s.layout],
        future: [],
        lastKey: a.key ?? null,
        lastAt: a.at,
      };
    }
    case 'live':
      return { ...s, layout: a.layout };
    case 'settle':
      if (same(s.layout, a.before)) return s;
      return { ...s, past: [...s.past.slice(-99), a.before], future: [], lastKey: null };
    case 'undo':
      if (!s.past.length) return s;
      return { layout: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.layout, ...s.future], lastKey: null, lastAt: 0 };
    case 'redo':
      if (!s.future.length) return s;
      return { layout: s.future[0], past: [...s.past, s.layout], future: s.future.slice(1), lastKey: null, lastAt: 0 };
  }
}

// ── Layout arithmetic ────────────────────────────────────────────────────────

/**
 * What follows the lines moves with them: when the table is moved or sized in
 * the editor, every box anchored "after" keeps its distance under it, and no
 * such box may start above the table's foot.
 */
function follow(prev: Layout, next: Layout): Layout {
  const page = pageSizeOf(next);
  const delta = tableBottom(next) - tableBottom(prev);
  const floor = tableBottom(next);
  return {
    ...next,
    blocks: next.blocks.map((b) => {
      if (b.anchor !== 'after') return b;
      const before = prev.blocks.find((p) => p.id === b.id);
      let y = b.y;
      if (delta && before && before.y === b.y) y += delta;
      y = Math.max(y, floor);
      return y === b.y ? b : clampToPage({ ...b, y }, page);
    }),
  };
}

/** One box changed, the page kept on the paper and what follows the lines kept after them. */
function changed(layout: Layout, id: string, change: BlockChange): Layout {
  const next: Layout = {
    ...layout,
    blocks: layout.blocks.map((b) =>
      b.id === id ? clampToPage({ ...b, ...(typeof change === 'function' ? change(b) : change) } as Block, pageSizeOf(layout)) : b,
    ),
  };
  return follow(layout, next);
}

function shown(b: Block, view: View): boolean {
  if (b.type === 'items') return view === 'first';
  if (view === 'first') return b.anchor !== 'later';
  return b.anchor === 'every' || b.anchor === 'later';
}

function snapTo(edges: number[], targets: number[], tol: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const e of edges) {
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  }
  return best;
}

/** A drag, applied to the layout it started from. */
function dragTo(
  before: Layout,
  mode: DragMode,
  id: string | null,
  dx: number,
  dy: number,
  tol: number,
  view: View,
): { layout: Layout; guides: { x?: number; y?: number } } {
  const page = pageSizeOf(before);
  if (mode === 'flowTop' || mode === 'flowBottom') {
    const value =
      mode === 'flowTop'
        ? Math.min(Math.max(before.flowTop + dy, 0), Math.min(400, before.flowBottom - 200))
        : Math.max(Math.min(before.flowBottom + dy, page.h), Math.max(200, before.flowTop + 200));
    return { layout: { ...before, [mode]: pt(value) }, guides: { y: pt(value) } };
  }
  const b = before.blocks.find((x) => x.id === id);
  if (!b) return { layout: before, guides: {} };
  const min = 4;
  const minH = b.type === 'line' ? b.h : min;
  let { x, y, w, h } = b;
  if (mode === 'move') {
    x += dx;
    y += dy;
  } else {
    if (mode.includes('e')) w = Math.max(min, b.w + dx);
    if (mode.includes('w')) {
      x = Math.min(b.x + dx, b.x + b.w - min);
      w = b.x + b.w - x;
    }
    if (b.type !== 'line') {
      if (mode.includes('s')) h = Math.max(minH, b.h + dy);
      if (mode.includes('n')) {
        y = Math.min(b.y + dy, b.y + b.h - minH);
        h = b.y + b.h - y;
      }
    }
  }

  const guides: { x?: number; y?: number } = {};
  if (tol > 0) {
    const others = before.blocks.filter((o) => o.id !== b.id && shown(o, view));
    const xs = [36, page.w - 36, page.w / 2, ...others.flatMap((o) => [o.x, o.x + o.w])];
    const ys = [before.flowTop, before.flowBottom, ...others.flatMap((o) => [o.y, o.y + o.h])];
    if (mode === 'move') {
      const sx = snapTo([x, x + w, x + w / 2], xs, tol);
      if (sx) {
        x += sx.delta;
        guides.x = sx.at;
      }
      const sy = snapTo([y, y + h], ys, tol);
      if (sy) {
        y += sy.delta;
        guides.y = sy.at;
      }
    } else {
      if (mode.includes('e')) {
        const s = snapTo([x + w], xs, tol);
        if (s && w + s.delta >= min) {
          w += s.delta;
          guides.x = s.at;
        }
      }
      if (mode.includes('w')) {
        const s = snapTo([x], xs, tol);
        if (s && w - s.delta >= min) {
          x += s.delta;
          w -= s.delta;
          guides.x = s.at;
        }
      }
      if (b.type !== 'line' && mode.includes('s')) {
        const s = snapTo([y + h], ys, tol);
        if (s && h + s.delta >= minH) {
          h += s.delta;
          guides.y = s.at;
        }
      }
      if (b.type !== 'line' && mode.includes('n')) {
        const s = snapTo([y], ys, tol);
        if (s && h - s.delta >= minH) {
          y += s.delta;
          h -= s.delta;
          guides.y = s.at;
        }
      }
    }
  }

  const moved = clampToPage(
    { ...b, x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2, w: Math.round(w * 2) / 2, h: b.type === 'line' ? b.h : Math.round(h * 2) / 2 },
    page,
  );
  const next: Layout = { ...before, blocks: before.blocks.map((o) => (o.id === b.id ? moved : o)) };
  return { layout: follow(before, next), guides };
}

function newId(type: BlockType) {
  return `${type}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Measuring for the preview ────────────────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;

/** The width of a run in points at `size`, near enough to Helvetica's to decide "Shrink to fit". */
function textWidth(text: string, size: number, bold: boolean, italic: boolean, spacing: number): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.5;
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width + spacing * Math.max(0, text.length - 1);
}

function fitSize(block: TextBlock, lines: Run[][]): number {
  if (!block.fit) return block.size;
  const width = (line: Run[]) =>
    line.reduce((n, r) => n + textWidth(block.uppercase ? r.text.toUpperCase() : r.text, size, r.bold, block.italic, block.spacing), 0);
  const floor = Math.max(4, block.size * 0.6);
  let size = block.size;
  while (size > floor && lines.some((line) => width(line) > block.w)) size = Math.max(floor, size - 0.25);
  return size;
}

// ── The page ─────────────────────────────────────────────────────────────────

/** Which "Empty in Company Settings" note this reader hid — the note, not the fields. */
const HIDDEN_NOTE_KEY = 'pdfTemplates.hiddenCompanyNote';

/**
 * One editor per document, remounted when `?doc=` changes — by the switch, the
 * menu, Ctrl+K or "Leave without saving". A question open in the confirm bar,
 * the undo history and every other piece of state belong to the document they
 * were made on, and go with it: a "Put the standard layout back?" asked on the
 * sales order must never be answered on the quotation.
 */
export function PdfTemplates() {
  const [params] = useSearchParams();
  const docType: DocType = params.get('doc') === 'sales_order' ? 'sales_order' : 'quotation';
  return <PdfTemplateEditor key={docType} docType={docType} />;
}

function PdfTemplateEditor({ docType }: { docType: DocType }) {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('admin.pdf_templates.edit_all');
  const canCompany = can('admin.company.view_all');
  const [, setParams] = useSearchParams();
  const doc = DOCS.find((x) => x.type === docType)!;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [hist, dispatch] = useReducer(history, null);
  const [savedJson, setSavedJson] = useState('');
  // Read when a confirmed Discard runs, which may be after a save made while it was asking.
  const savedJsonRef = useRef(savedJson);
  savedJsonRef.current = savedJson;
  const [saved, setSaved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('first');
  const [tab, setTab] = useState<'box' | 'boxes'>('boxes');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [previewWith, setPreviewWith] = useState<'short' | 'long' | 'real'>('short');
  const [previewDoc, setPreviewDoc] = useState<{ id: string; number: string; label: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hiddenNote, setHiddenNote] = useState<string | null>(() => {
    try {
      return localStorage.getItem(HIDDEN_NOTE_KEY);
    } catch {
      return null;
    }
  });

  const layout = hist?.layout ?? null;
  const dirty = !!layout && JSON.stringify(layout) !== savedJson;
  const selected = layout?.blocks.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setLoaded(null);
    setSelectedId(null);
    setView('first');
    setTab('boxes');
    setError(null);
    setPreviewWith('short');
    setPreviewDoc(null);
    api
      .get<Loaded>(`/pdf-templates/${docType}`)
      .then(async (data) => {
        if (!alive) return;
        setLoaded(data);
        dispatch({ type: 'load', layout: data.layout });
        setSavedJson(JSON.stringify(data.layout));
        setSaved(data.saved);
        if (data.hasLogo) {
          try {
            const blob = await api.getBlob('/pdf-templates/logo');
            if (!alive) return;
            url = URL.createObjectURL(blob);
            setLogoUrl(url);
          } catch {
            /* the page draws a placeholder instead */
          }
        }
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [docType]);

  /** The other document's editor, guarded: unsaved work asks first. */
  function switchDoc(next: DocType) {
    if (next === docType) return;
    const open = () => setParams(next === 'quotation' ? {} : { doc: next }, { replace: true });
    if (!dirty) {
      open();
      return;
    }
    confirm.ask({
      title: 'Throw away the changes since you last saved?',
      body: `The ${DOCS.find((x) => x.type === next)!.label.toLowerCase()}'s layout opens instead.`,
      confirmLabel: 'Discard and switch',
      onConfirm: open,
    });
  }

  // Leaving with unsaved work asks first: a link in the app, or the browser's own prompt.
  useUnsavedChanges(dirty);

  const edit = useCallback((next: Layout, key?: string) => dispatch({ type: 'edit', update: () => next, key, at: Date.now() }), []);

  const patchBlock = useCallback(
    (id: string, change: BlockChange, key?: string) =>
      dispatch({ type: 'edit', update: (l) => changed(l, id, change), key: key ? `${id}.${key}` : undefined, at: Date.now() }),
    [],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!id || !layout) return;
      setTab('box');
      const b = layout.blocks.find((x) => x.id === id);
      if (b && !shown(b, view)) setView(b.anchor === 'later' ? 'later' : 'first');
    },
    [layout, view],
  );

  const remove = useCallback(
    (id: string) => {
      if (!layout) return;
      const b = layout.blocks.find((x) => x.id === id);
      if (!b || b.type === 'items') return;
      edit({ ...layout, blocks: layout.blocks.filter((x) => x.id !== id) });
      setSelectedId(null);
      setTab('boxes');
    },
    [layout, edit],
  );

  function add(type: BlockType, text?: string, name?: string) {
    if (!layout || !loaded) return;
    const later = view === 'later';
    const anchor: Anchor = type === 'totals' || type === 'signoffs' ? (type === 'totals' ? 'after' : 'last') : later ? 'later' : 'first';
    const y = later ? layout.flowTop + 20 : 360;
    const id = newId(type);
    let block: Block;
    switch (type) {
      case 'text':
        block = {
          id, name: name ?? 'Text', type, anchor, x: 200, y, w: 200, h: 14, text: text ?? 'New text', size: 10,
          bold: false, italic: false, color: '#222222', align: 'left', uppercase: false, spacing: 0, lineGap: 0, fit: false, multiPageOnly: false,
        };
        break;
      case 'line':
        block = { id, name: 'Line', type, anchor, x: 36, y, w: pageSizeOf(layout).w - 72, h: 0.75, color: '#D9D9D9' };
        break;
      case 'box':
        block = { id, name: 'Box', type, anchor, x: 200, y, w: 200, h: 60, color: '#F2F2F2' };
        break;
      case 'logo':
        block = { id, name: 'Logo', type, anchor, x: 36, y: later ? layout.flowTop - 40 : 30, w: 72, h: 36, align: 'left' };
        break;
      default: {
        // Totals and sign-offs come back as the standard layout has them.
        const std = loaded.standard.blocks.find((b) => b.type === type);
        if (!std) return;
        block = { ...std, id };
      }
    }
    block = clampToPage(block, pageSizeOf(layout));
    // A box goes behind everything, so a band never covers the text over it.
    const blocks = type === 'box' ? [block, ...layout.blocks] : [...layout.blocks, block];
    edit(follow(layout, { ...layout, blocks }));
    setSelectedId(id);
    setTab('box');
  }

  function duplicate(id: string) {
    if (!layout) return;
    const b = layout.blocks.find((x) => x.id === id);
    if (!b || b.type === 'items' || b.type === 'totals' || b.type === 'signoffs') return;
    const copy = clampToPage({ ...b, id: newId(b.type), name: b.name ? `${b.name} (copy)` : undefined, x: b.x + 10, y: b.y + 10 } as Block, pageSizeOf(layout));
    const at = layout.blocks.indexOf(b) + 1;
    edit({ ...layout, blocks: [...layout.blocks.slice(0, at), copy, ...layout.blocks.slice(at)] });
    setSelectedId(copy.id);
  }

  function layer(id: string, dir: 1 | -1) {
    if (!layout) return;
    const i = layout.blocks.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layout.blocks.length) return;
    const blocks = [...layout.blocks];
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    edit({ ...layout, blocks });
  }

  async function save() {
    if (!layout || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ layout: Layout; saved: boolean }>(`/pdf-templates/${docType}`, layout);
      // What came back is what was sent, tidied: no step to undo.
      dispatch({ type: 'live', layout: res.layout });
      setSavedJson(JSON.stringify(res.layout));
      setSaved(true);
      // Every question this page asks is about what is saved (discard, switch,
      // put the standard back); a save changes it under the question.
      confirm.close();
      toast('ok', `Saved — ${doc.plural.toLowerCase()} now print with this layout`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Asked in the confirm bar first; a refusal is shown there, so it throws. */
  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.del<{ layout: Layout }>(`/pdf-templates/${docType}`);
      edit(res.layout);
      setSavedJson(JSON.stringify(res.layout));
      setSaved(false);
      setSelectedId(null);
      toast('ok', 'The standard layout is back');
    } finally {
      setBusy(false);
    }
  }

  /**
   * The layout on screen, as a file — how a layout tried on the laptop reaches
   * the live server, since a push carries code and never this database's
   * settings. It names the document, so Import refuses one meant for another.
   */
  function exportLayout() {
    if (!layout) return;
    const body = JSON.stringify({ type: docType, exportedAt: new Date().toISOString(), layout }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${docType.replace('_', '-')}-layout-${dayKeyOf(new Date())}.json`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  /**
   * An exported file, read back. The server checks it with the rules a save
   * uses and fills in what an older file leaves out; it then sits in the
   * editor as unsaved changes — preview it, then Save, or Undo it.
   */
  async function importLayout(file: File) {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not a layout — it does not read as one.');
      }
      const wrapped = parsed && typeof parsed === 'object' && 'layout' in parsed ? (parsed as { type?: unknown; layout: unknown }) : null;
      if (wrapped && wrapped.type !== undefined && wrapped.type !== docType) {
        throw new Error(`That file is a layout for ${String(wrapped.type)}, not the ${doc.label.toLowerCase()}.`);
      }
      const res = await api.post<{ layout: Layout }>(`/pdf-templates/${docType}/check`, wrapped ? wrapped.layout : parsed);
      edit(res.layout);
      setSelectedId(null);
      setTab('boxes');
      toast('ok', 'Layout imported — look it over and preview it, then Save to use it');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      // The same file chosen again must still read.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function discard() {
    const last = JSON.parse(savedJsonRef.current) as Layout;
    edit(last);
    setSelectedId(null);
  }

  async function preview() {
    if (!layout) return;
    if (previewWith === 'real' && !previewDoc) {
      setError(new Error(`Choose the ${doc.label.toLowerCase()} to preview with first`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pdf-templates/${docType}/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout,
          ...(previewWith === 'real' && previewDoc ? { documentId: previewDoc.id } : { sample: previewWith }),
        }),
      });
      if (!res.ok) {
        let message = `Could not print the preview (${res.status})`;
        let details;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
          if (Array.isArray(body?.details)) details = body.details;
        } catch {
          /* not JSON */
        }
        throw new ApiError(res.status, message, details);
      }
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  // Ctrl+Z / Ctrl+Y / Ctrl+S, unless the person is typing in a field — a text
  // box keeps its own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (dirty && !busy) void save();
        return;
      }
      if (typing) return;
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: 'undo' });
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const values = useMemo(() => {
    const v: Record<string, string> = Object.fromEntries((loaded?.fields ?? []).map((f) => [f.key, f.sample ?? '']));
    v.page = view === 'later' ? '2' : '1';
    v.pages = '2';
    return v;
  }, [loaded, view]);
  const known = useMemo(() => new Set((loaded?.fields ?? []).map((f) => f.key)), [loaded]);

  if (!loaded || !layout || !hist) return error ? <ErrorBox error={error} /> : <Loading />;

  const missing = (type: BlockType) => !layout.blocks.some((b) => b.type === type);
  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty} title="Save (Ctrl+S)">
      Save
    </button>
  );

  return (
    <div className="pt-screen">
      <div className="page-head">
        <div>
          <h1>PDF Templates</h1>
          <p>
            Lay out the {doc.label.toLowerCase()} as it prints: move and size the boxes, and choose what each one shows. Fields
            such as the customer or the document number fill in from each {doc.label.toLowerCase()}.
          </p>
          <div className="pt-doc-switch" role="group" aria-label="Which document">
            {DOCS.map((o) => (
              <button
                key={o.type}
                type="button"
                className={`btn btn-sm${o.type === docType ? ' btn-active' : ''}`}
                aria-pressed={o.type === docType}
                onClick={() => switchDoc(o.type)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {/* The page editor's head: [⋯] [Save] — Save right-most, everything rarer in ⋯. */}
        <div className="pt-actions">
          {canEdit && (
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importLayout(file);
              }}
            />
          )}
          <RecordActions
            confirm={confirm}
            more={[
              { label: 'Export layout', hint: 'A file to import on another G-CORE', onSelect: exportLayout },
              canEdit && {
                label: 'Import layout',
                hint: 'A layout file exported from another G-CORE',
                disabled: busy,
                onSelect: () => fileRef.current?.click(),
              },
              canEdit &&
                dirty && {
                  label: 'Discard changes',
                  disabled: busy,
                  confirm: {
                    title: 'Throw away the changes since you last saved?',
                    confirmLabel: 'Discard',
                    onConfirm: discard,
                  },
                },
              canEdit && {
                label: 'Standard layout',
                danger: true,
                disabled: busy,
                confirm: {
                  title: 'Put the standard layout back?',
                  body: `Your saved layout is deleted, and ${doc.plural.toLowerCase()} print the standard way.`,
                  confirmLabel: 'Put it back',
                  onConfirm: reset,
                },
              },
            ]}
          />
          {canEdit && saveButton}
        </div>
      </div>
      {confirm.bar}

      {(() => {
        // The company's own details are real on this page, not samples: an
        // empty one is left out here exactly as on the quotation. Hidden by
        // the reader, the note stays hidden until a different field is empty.
        const names = [
          ...new Set(
            emptyFieldsIn(layout.blocks, values)
              .filter((k) => k.startsWith('company.'))
              .map((k) => COMPANY_SETTING_NAMES[k] ?? k),
          ),
        ];
        const noteKey = names.join('|');
        if (!names.length || hiddenNote === noteKey) return null;
        const one = names.length === 1;
        return (
          <div className="alert info row pt-company-note">
            <span>
              Empty in Company Settings: {listOf(names)}. Wherever the layout prints {one ? 'it, it is' : 'them, they are'} left
              out — on this page, in the preview and on every quotation.{' '}
              {canCompany && <Link to="/admin/company">Fill {one ? 'it' : 'them'} in Company Settings</Link>}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setHiddenNote(noteKey);
                try {
                  localStorage.setItem(HIDDEN_NOTE_KEY, noteKey);
                } catch {
                  /* private mode: hidden for this visit only */
                }
              }}
            >
              Hide
            </button>
          </div>
        );
      })()}
      {loaded.unreadable && (
        <div className="alert warn">
          The saved layout could not be read, so {doc.plural.toLowerCase()} print with the standard one. Saving puts a layout that reads in its place.
        </div>
      )}
      <ErrorBox error={error} />

      <div className="pt-status">
        {/* Undo and Redo sit with what they act on — the unsaved changes — not beside Save. */}
        <div className="pt-actions">
          <span className={`pt-state${dirty ? ' is-dirty' : ''}`}>
            {dirty
              ? 'Changes not saved yet'
              : saved
                ? `${doc.plural} print with this layout`
                : `The standard layout — ${doc.plural.toLowerCase()} print with it`}
          </span>
          {canEdit && (
            <>
              <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'undo' })} disabled={!hist.past.length} title="Undo (Ctrl+Z)">
                Undo
              </button>
              <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'redo' })} disabled={!hist.future.length} title="Redo (Ctrl+Y)">
                Redo
              </button>
            </>
          )}
        </div>
        <PreviewControl
          docType={docType}
          label={doc.label}
          value={previewWith}
          onValue={setPreviewWith}
          picked={previewDoc}
          onPicked={setPreviewDoc}
          busy={busy}
          onPreview={preview}
        />
      </div>

      <div className="pt-workspace">
        <section className="pt-stage" aria-label="The page">
          <div className="pt-viewbar" role="group" aria-label="Which page">
            <button type="button" className={`btn btn-sm${view === 'first' ? ' btn-active' : ''}`} aria-pressed={view === 'first'} onClick={() => setView('first')}>
              Page 1
            </button>
            <button type="button" className={`btn btn-sm${view === 'later' ? ' btn-active' : ''}`} aria-pressed={view === 'later'} onClick={() => setView('later')}>
              Pages 2 onward
            </button>
            <span className="faint pt-viewnote">
              {view === 'first'
                ? `A one-page ${doc.label.toLowerCase()}: the lines, then what follows them, then the last page’s sign-offs.`
                : 'The lines run on from the top guide; the running header and the footer repeat.'}
            </span>
          </div>
          <Canvas
            layout={layout}
            view={view}
            selectedId={selectedId}
            values={values}
            sample={loaded.sample}
            fields={loaded.fields}
            logoUrl={logoUrl}
            canEdit={canEdit}
            onSelect={select}
            onLive={(next) => dispatch({ type: 'live', layout: next })}
            onSettle={(before) => dispatch({ type: 'settle', before })}
            onPatch={patchBlock}
            onRemove={remove}
          />
        </section>

        <aside className="pt-side" aria-label="Boxes">
          {canEdit && (
            <div className="pt-add">
              <span className="pt-add-label">Add</span>
              <button type="button" className="btn btn-sm" onClick={() => add('text')}>
                Text
              </button>
              <select
                className="pt-add-field"
                aria-label="Add a field"
                value=""
                onChange={(e) => {
                  const f = loaded.fields.find((x) => x.key === e.target.value);
                  if (f) add('text', `{{${f.key}}}`, f.label);
                }}
              >
                <option value="">Field…</option>
                <FieldOptions fields={loaded.fields} />
              </select>
              <button type="button" className="btn btn-sm" onClick={() => add('line')}>
                Line
              </button>
              <button type="button" className="btn btn-sm" onClick={() => add('box')}>
                Box
              </button>
              <button type="button" className="btn btn-sm" onClick={() => add('logo')}>
                Logo
              </button>
              {missing('totals') && (
                <button type="button" className="btn btn-sm" onClick={() => add('totals')}>
                  Totals
                </button>
              )}
              {missing('signoffs') && (
                <button type="button" className="btn btn-sm" onClick={() => add('signoffs')}>
                  Sign-offs
                </button>
              )}
            </div>
          )}

          <div className="pt-tabs" role="tablist" aria-label="Side panel">
            <button type="button" role="tab" id="pt-tab-box" aria-selected={tab === 'box'} aria-controls="pt-panel" className={tab === 'box' ? 'is-on' : ''} onClick={() => setTab('box')}>
              {selected ? 'Selected box' : 'Page'}
            </button>
            <button type="button" role="tab" id="pt-tab-boxes" aria-selected={tab === 'boxes'} aria-controls="pt-panel" className={tab === 'boxes' ? 'is-on' : ''} onClick={() => setTab('boxes')}>
              All boxes ({layout.blocks.length})
            </button>
          </div>
          <div className="pt-panel" id="pt-panel" role="tabpanel" aria-labelledby={tab === 'box' ? 'pt-tab-box' : 'pt-tab-boxes'}>
            {tab === 'boxes' ? (
              <Layers layout={layout} selectedId={selectedId} onSelect={select} />
            ) : selected ? (
              <Inspector
                key={selected.id}
                block={selected}
                layout={layout}
                fields={loaded.fields}
                columns={loaded.columns}
                known={known}
                values={values}
                canCompany={canCompany}
                canEdit={canEdit}
                onPatch={(patch, key) => patchBlock(selected.id, patch, key)}
                onRemove={() => remove(selected.id)}
                onDuplicate={() => duplicate(selected.id)}
                onLayer={(dir) => layer(selected.id, dir)}
              />
            ) : (
              <PageSettings layout={layout} canEdit={canEdit} onChange={(patch, key) => edit({ ...layout, ...patch }, key)} />
            )}
          </div>
        </aside>
      </div>
      {canEdit && (
        <div className="page-foot">
          {saveButton}
        </div>
      )}
    </div>
  );
}

// ── The canvas ───────────────────────────────────────────────────────────────

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function Canvas({
  layout,
  view,
  selectedId,
  values,
  sample,
  fields,
  logoUrl,
  canEdit,
  onSelect,
  onLive,
  onSettle,
  onPatch,
  onRemove,
}: {
  layout: Layout;
  view: View;
  selectedId: string | null;
  values: Record<string, string>;
  sample: Sample;
  fields: FieldDef[];
  logoUrl: string | null;
  canEdit: boolean;
  onSelect: (id: string | null) => void;
  onLive: (next: Layout) => void;
  onSettle: (before: Layout) => void;
  onPatch: (id: string, change: BlockChange, key?: string) => void;
  onRemove: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const drag = useRef<{ mode: DragMode; id: string | null; x0: number; y0: number; before: Layout } | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null);
  const page = pageSizeOf(layout);

  // The page fills the width it is given, between half size and a third over.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1.35, Math.max(0.45, (el.clientWidth - 2) / page.w)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.w]);

  const s = scale;
  const label = (key: string) => fields.find((f) => f.key === key)?.label ?? key;

  function start(e: ReactPointerEvent, mode: DragMode, id: string | null) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (id) onSelect(id);
    if (!canEdit) return;
    try {
      pageRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that is already gone; the drag still follows the page's own events */
    }
    drag.current = { mode, id, x0: e.clientX, y0: e.clientY, before: layout };
  }

  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x0) / s;
    const dy = (e.clientY - d.y0) / s;
    const out = dragTo(d.before, d.mode, d.id, dx, dy, e.altKey ? 0 : 5 / s, view);
    setGuides(out.guides);
    onLive(out.layout);
  }

  function end() {
    const d = drag.current;
    drag.current = null;
    setGuides(null);
    if (d) onSettle(d.before);
  }

  function onKey(e: ReactKeyboardEvent, b: Block) {
    if (!canEdit) return;
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const dir = arrows[e.key];
    if (dir) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        onPatch(b.id, (cur) => ({ w: Math.max(4, cur.w + dir[0]), h: cur.type === 'line' ? cur.h : Math.max(4, cur.h + dir[1]) }), 'size');
      } else {
        onPatch(b.id, (cur) => ({ x: cur.x + dir[0], y: cur.y + dir[1] }), 'position');
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && b.type !== 'items') {
      e.preventDefault();
      onRemove(b.id);
    } else if (e.key === 'Escape') {
      (e.currentTarget as HTMLElement).blur();
      onSelect(null);
    }
  }

  const items = layout.blocks.find((b): b is ItemsBlock => b.type === 'items');
  const pageStyle = { width: page.w * s, height: page.h * s, '--pt': s } as CSSProperties;
  const box = (x: number, y: number, w: number, h: number): CSSProperties => ({ left: x * s, top: y * s, width: w * s, height: h * s });

  return (
    <div className="pt-canvas" ref={wrapRef}>
      <div
        className="pt-page"
        ref={pageRef}
        style={pageStyle}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {/* Where the content stops on every page, and on pages 2+ where it starts. */}
        <div className="pt-guide" style={{ top: layout.flowBottom * s }}>
          {canEdit && <span className="pt-guide-grip" onPointerDown={(e) => start(e, 'flowBottom', null)} aria-hidden="true" />}
          <span className="pt-guide-label">Content stops here — the footer is below</span>
        </div>
        {view === 'later' && (
          <div className="pt-guide pt-guide-top" style={{ top: layout.flowTop * s }}>
            {canEdit && <span className="pt-guide-grip" onPointerDown={(e) => start(e, 'flowTop', null)} aria-hidden="true" />}
            <span className="pt-guide-label">The lines continue from here</span>
          </div>
        )}
        {view === 'later' && items && (
          <div className="pt-ghost" style={box(items.x, layout.flowTop, items.w, layout.flowBottom - layout.flowTop)}>
            <ItemsBody block={items} sample={sample} values={values} scale={s} rows={10} />
          </div>
        )}

        {layout.blocks.map((b) => {
          if (!shown(b, view)) return null;
          const isSel = b.id === selectedId;
          const geometry =
            b.type === 'line' ? { ...box(b.x, b.y, b.w, b.h), height: Math.max(8, b.h * s), marginTop: (b.h * s - Math.max(8, b.h * s)) / 2 } : box(b.x, b.y, b.w, b.h);
          return (
            <div
              key={b.id}
              className={`pt-block pt-block-${b.type}${isSel ? ' is-selected' : ''}${b.anchor === 'after' ? ' is-after' : ''}${b.anchor === 'last' ? ' is-last' : ''}`}
              style={geometry}
              role="button"
              tabIndex={0}
              aria-pressed={isSel}
              aria-label={`${b.name || TYPE_LABELS[b.type]}, ${ANCHOR_LABELS[b.anchor]}. Arrow keys move it, Ctrl and arrow keys size it.`}
              onPointerDown={(e) => start(e, 'move', b.id)}
              onFocus={() => {
                if (!isSel) onSelect(b.id);
              }}
              onKeyDown={(e) => onKey(e, b)}
            >
              <BlockBody block={b} values={values} sample={sample} scale={s} logoUrl={logoUrl} label={label} />
              {isSel && <span className="pt-tag">{ANCHOR_LABELS[b.anchor]}</span>}
              {isSel &&
                canEdit &&
                HANDLES.filter((h) => (b.type === 'line' ? h === 'e' || h === 'w' : true)).map((h) => (
                  <span key={h} className={`pt-handle pt-handle-${h}`} onPointerDown={(e) => start(e, h, b.id)} aria-hidden="true" />
                ))}
            </div>
          );
        })}

        {guides?.x !== undefined && <div className="pt-snap pt-snap-x" style={{ left: guides.x * s }} />}
        {guides?.y !== undefined && <div className="pt-snap pt-snap-y" style={{ top: guides.y * s }} />}
      </div>
    </div>
  );
}

// ── What each box shows on the page ──────────────────────────────────────────

function BlockBody({
  block,
  values,
  sample,
  scale,
  logoUrl,
  label,
}: {
  block: Block;
  values: Record<string, string>;
  sample: Sample;
  scale: number;
  logoUrl: string | null;
  label: (key: string) => string;
}) {
  switch (block.type) {
    case 'text':
      return <TextBody block={block} values={values} scale={scale} label={label} />;
    case 'line':
      return <span className="pt-rule" style={{ background: block.color, height: Math.max(1, block.h * scale) }} />;
    case 'box':
      return <span className="pt-fill" style={{ background: block.color }} />;
    case 'logo':
      return logoUrl ? (
        <img className={`pt-logo pt-logo-${block.align}`} src={logoUrl} alt="" draggable={false} />
      ) : (
        <span className="pt-placeholder">Logo — upload it in Company Settings</span>
      );
    case 'items':
      return <ItemsBody block={block} sample={sample} values={values} scale={scale} rows={3} />;
    case 'totals':
      return <TotalsBody block={block} sample={sample} scale={scale} />;
    case 'signoffs':
      return <SignoffsBody block={block} sample={sample} scale={scale} />;
  }
}

function TextBody({ block, values, scale, label }: { block: TextBlock; values: Record<string, string>; scale: number; label: (key: string) => string }) {
  const lines = resolveTemplate(block.text, values, block.bold);
  if (block.showIf && !(values[block.showIf] ?? '').trim()) {
    return <span className="pt-placeholder">Prints only when “{label(block.showIf)}” has something in it</span>;
  }
  if (!lines.some((l) => l.some((r) => r.text.trim()))) {
    return <span className="pt-placeholder">Nothing to print with the sample — its fields are empty</span>;
  }
  const size = fitSize(block, lines);
  const style: CSSProperties = {
    fontSize: size * scale,
    color: block.color,
    textAlign: block.align,
    letterSpacing: block.spacing * scale,
    fontStyle: block.italic ? 'italic' : undefined,
    textTransform: block.uppercase ? 'uppercase' : undefined,
  };
  return (
    <div className={`pt-text${block.fit ? ' is-fit' : ''}`} style={style}>
      {lines.map((line, i) => (
        <div key={i} style={i ? { marginTop: block.lineGap * scale } : undefined}>
          {line.length ? line.map((r, j) => (r.bold ? <b key={j}>{r.text}</b> : <span key={j}>{r.text}</span>)) : ' '}
        </div>
      ))}
      {block.multiPageOnly && <span className="pt-flag">only when there is more than one page</span>}
    </div>
  );
}

function cellText(cell: PdfCell | undefined): { title?: string; body?: string } {
  if (cell === undefined) return {};
  return typeof cell === 'object' ? cell : { body: cell };
}

function ItemsBody({ block, sample, values, scale, rows }: { block: ItemsBlock; sample: Sample; values: Record<string, string>; scale: number; rows: number }) {
  const total = block.columns.reduce((n, c) => n + c.width, 0) || 1;
  const hasGroup = block.columns.some((c) => c.key === 'group');
  const k = block.size / 9;
  const list = sample.rows.filter((r) => !('heading' in r && r.group && hasGroup));
  // Later pages are lines and more lines; page 1 shows the sample as it starts.
  const lines = list.filter((r) => 'cells' in r);
  const shownRows = rows > 3 && lines.length ? Array.from({ length: rows }, (_, i) => lines[i % lines.length]) : list.slice(0, rows);
  const grid = { gridTemplateColumns: block.columns.map((c) => `${(c.width / total) * 100}%`).join(' ') } as CSSProperties;
  const vars = { '--k': k, fontSize: block.size * scale } as CSSProperties;
  return (
    <div className="pt-items" style={vars}>
      <div className="pt-items-head" style={{ ...grid, color: block.headColor, borderColor: block.ruleColor, fontSize: (block.size - 0.5) * scale }}>
        {block.columns.map((c, i) => (
          <span key={i} style={{ textAlign: c.align }}>
            {resolveInline(c.label, values)}
          </span>
        ))}
      </div>
      {shownRows.map((row, i) =>
        'heading' in row ? (
          <div key={i} className="pt-items-heading" style={{ color: block.headingColor, borderColor: block.ruleColor, fontSize: (block.size + 0.5) * scale }}>
            {row.heading}
          </div>
        ) : (
          <div key={i} className="pt-items-row" style={{ ...grid, borderColor: block.ruleColor, color: block.textColor }}>
            {block.columns.map((c, n) => {
              const cell = cellText(row.cells[c.key]);
              return (
                <span key={n} style={{ textAlign: c.align }}>
                  {cell.title && <b>{cell.title}</b>}
                  {cell.body && <span className="pt-items-body" style={cell.title ? { color: block.bodyColor } : undefined}>{cell.body}</span>}
                </span>
              );
            })}
          </div>
        ),
      )}
      <span className="pt-flag pt-items-flag">The lines run on from here, onto as many pages as they need</span>
    </div>
  );
}

function TotalsBody({ block, sample, scale }: { block: TotalsBlock; sample: Sample; scale: number }) {
  const k = block.size / 9;
  const rows = sample.totals ?? [];
  if (!rows.length) return <span className="pt-placeholder">Totals</span>;
  return (
    <div className="pt-totals">
      {rows.map((r, i) => (
        <div
          key={i}
          className={`pt-totals-row${r.bold ? ' is-total' : ''}`}
          style={{
            height: (r.bold ? 30 : 24.5) * k * scale,
            color: r.bold ? block.accentColor : block.textColor,
            borderBottom: `${(r.bold ? 2 : 0.75) * scale}px solid ${r.bold ? block.accentColor : block.ruleColor}`,
            fontSize: (r.bold ? block.size + 2 : block.size) * scale,
          }}
        >
          <span style={{ width: block.labelWidth * scale }}>{r.label}</span>
          <span className="pt-totals-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function SignoffsBody({ block, sample, scale }: { block: SignoffsBlock; sample: Sample; scale: number }) {
  const people = sample.signatories;
  const n = people.length;
  const colW = Math.min(block.colWidth, block.w);
  const step = n > 1 ? (block.w - colW) / (n - 1) : 0;
  return (
    <div className="pt-signoffs" style={{ fontSize: block.size * scale, color: block.textColor }}>
      {people.map((p, i) => (
        <div
          key={i}
          className="pt-signoff"
          style={{ marginLeft: step * i * scale, width: (n <= 1 ? block.w : i === n - 1 ? colW : Math.max(colW, step - 10)) * scale }}
        >
          <b className="pt-signoff-role" style={{ color: block.headColor, fontSize: (block.size + 0.5) * scale }}>
            {p.role}
          </b>
          {p.name ? (
            <>
              <b className="pt-signoff-name" style={{ fontSize: block.nameSize * scale }}>
                {p.name}
              </b>
              {block.showPosition && p.position && <span>{p.position}</span>}
              {block.showPhone && p.phone && <span>{p.phone}</span>}
              {block.showEmail && p.email && <span>{p.email}</span>}
              <span>{p.at ? formatDateTime(p.at) : 'Pending'}</span>
            </>
          ) : (
            <span>Pending</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── The side panel ───────────────────────────────────────────────────────────

function FieldOptions({ fields }: { fields: FieldDef[] }) {
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {fields
            .filter((f) => f.group === g)
            .map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

const ANCHOR_ORDER: Anchor[] = ['first', 'after', 'last', 'every', 'later'];

function Layers({ layout, selectedId, onSelect }: { layout: Layout; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="pt-layers">
      {ANCHOR_ORDER.map((anchor) => {
        const blocks = layout.blocks.filter((b) => b.anchor === anchor).sort((a, b) => a.y - b.y || a.x - b.x);
        if (!blocks.length) return null;
        return (
          <div key={anchor} className="pt-layer-group">
            <h4>{ANCHOR_LABELS[anchor]}</h4>
            <ul>
              {blocks.map((b) => (
                <li key={b.id}>
                  <button type="button" className={b.id === selectedId ? 'is-selected' : ''} aria-pressed={b.id === selectedId} onClick={() => onSelect(b.id)}>
                    <span className="pt-layer-name">{b.name || (b.type === 'text' ? b.text.split('\n')[0].slice(0, 40) : TYPE_LABELS[b.type])}</span>
                    <span className="pt-layer-type faint">{TYPE_LABELS[b.type]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** A number typed freely ("1." included) and passed on once it reads as one. */
function NumberField({
  label,
  value,
  onChange,
  step = 0.5,
  min,
  max,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(pt(value)));
  useEffect(() => {
    if (Number(text) !== pt(value)) setText(String(pt(value)));
    // Only an outside change (a drag, an undo) rewrites what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint}>
      <NumberInput
        kind="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, n) : n);
        }}
      />
    </Field>
  );
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="field pt-color">
      <span className="pt-color-label">{label}</span>
      <div className="pt-color-row">
        <input type="color" value={value} disabled={disabled} aria-label={`${label}: pick a colour`} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        <input
          className="mono pt-color-hex"
          value={text}
          maxLength={7}
          disabled={disabled}
          aria-label={`${label}: colour as #RRGGBB`}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toUpperCase());
          }}
        />
      </div>
      <div className="pt-swatches">
        {SWATCHES.map((sw) => (
          <button
            key={sw.value}
            type="button"
            className="pt-swatch"
            style={{ background: sw.value }}
            title={`${sw.name} ${sw.value}`}
            aria-label={`${label}: ${sw.name}`}
            aria-pressed={value.toUpperCase() === sw.value}
            disabled={disabled}
            onClick={() => onChange(sw.value)}
          />
        ))}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, children, disabled }: { on: boolean; onChange: (v: boolean) => void; children: string; disabled?: boolean }) {
  return (
    <button type="button" className={`btn btn-sm${on ? ' btn-active' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}>
      {children}
    </button>
  );
}

function AlignChoice({ value, onChange, disabled }: { value: Align; onChange: (v: Align) => void; disabled?: boolean }) {
  return (
    <div className="pt-seg" role="group" aria-label="Alignment">
      {(['left', 'center', 'right'] as Align[]).map((a) => (
        <button key={a} type="button" className={`btn btn-sm${value === a ? ' btn-active' : ''}`} aria-pressed={value === a} disabled={disabled} onClick={() => onChange(a)}>
          {a === 'left' ? 'Left' : a === 'center' ? 'Centre' : 'Right'}
        </button>
      ))}
    </div>
  );
}

function PageSettings({ layout, canEdit, onChange }: { layout: Layout; canEdit: boolean; onChange: (patch: Partial<Layout>, key: string) => void }) {
  const page = pageSizeOf(layout);
  /** Turning the page keeps every box on the paper and the guides inside it. */
  function turn(orientation: Orientation) {
    if ((layout.orientation ?? 'portrait') === orientation) return;
    const next = orientation === 'landscape' ? { w: PAGE_HEIGHT, h: PAGE_WIDTH } : { w: PAGE_WIDTH, h: PAGE_HEIGHT };
    const flowTop = Math.min(layout.flowTop, next.h - 200);
    const flowBottom = Math.max(Math.min(layout.flowBottom, next.h), flowTop + 200);
    onChange(
      { orientation, flowTop, flowBottom, blocks: layout.blocks.map((b) => clampToPage(b, next)) },
      'orientation',
    );
  }
  return (
    <div className="pt-inspector">
      <p className="pt-intro">Choose a box on the page, or one under “All boxes”, to change it.</p>
      <h3 className="pt-section">The page</h3>
      <Field label="The paper" hint="Turning the page pulls in any box that would fall off it.">
        <select
          value={layout.orientation ?? 'portrait'}
          disabled={!canEdit}
          onChange={(e) => turn(e.target.value as Orientation)}
        >
          <option value="portrait">A4 upright (portrait)</option>
          <option value="landscape">A4 on its side (landscape)</option>
        </select>
      </Field>
      <NumberField
        label="On pages 2 onward the lines start at (pt from the top)"
        value={layout.flowTop}
        min={0}
        max={400}
        disabled={!canEdit}
        onChange={(v) => onChange({ flowTop: Math.min(v, layout.flowBottom - 200) }, 'flowTop')}
      />
      <NumberField
        label="On every page the content stops at (pt from the top)"
        value={layout.flowBottom}
        min={200}
        max={page.h}
        hint="The footer sits under this line. Both are the dashed guides on the page."
        disabled={!canEdit}
        onChange={(v) => onChange({ flowBottom: Math.max(v, layout.flowTop + 200) }, 'flowBottom')}
      />
      <h3 className="pt-section">How it works</h3>
      <ul className="pt-help">
        <li>Drag a box to move it, or a handle to size it. It snaps to the margins and to other boxes; hold Alt to place it freely.</li>
        <li>From the keyboard: Tab to a box, then the arrow keys move it (Shift for 10pt) and Ctrl with the arrows sizes it.</li>
        <li>Every box has a place: the first page, every page, pages 2 onward, after the lines, or the last page.</li>
        <li>Preview PDF prints the layout as it stands, saved or not. Save makes the document print with it.</li>
        <li>
          To use a layout from another G-CORE — the laptop’s on the live server — Export layout there and Import layout here, then
          preview it and Save. A push carries code, never a layout.
        </li>
      </ul>
    </div>
  );
}

function Inspector({
  block,
  layout,
  fields,
  columns,
  known,
  values,
  canCompany,
  canEdit,
  onPatch,
  onRemove,
  onDuplicate,
  onLayer,
}: {
  block: Block;
  layout: Layout;
  fields: FieldDef[];
  columns: { key: ColumnKey; label: string }[];
  known: Set<string>;
  values: Record<string, string>;
  canCompany: boolean;
  canEdit: boolean;
  onPatch: (patch: Patch, key?: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onLayer: (dir: 1 | -1) => void;
}) {
  const ro = !canEdit;
  const unknown = unknownFieldsIn(block, known);
  const index = layout.blocks.indexOf(block);
  return (
    <div className="pt-inspector">
      <div className="pt-inspector-head">
        <span className="pt-kind">{TYPE_LABELS[block.type]}</span>
        <Field label="Name">
          <input value={block.name ?? ''} maxLength={60} disabled={ro} placeholder={TYPE_LABELS[block.type]} onChange={(e) => onPatch({ name: e.target.value }, 'name')} />
        </Field>
      </div>

      {block.type === 'text' && (
        <TextSettings block={block} fields={fields} values={values} canCompany={canCompany} disabled={ro} onPatch={onPatch} />
      )}
      {unknown.length > 0 && (
        <div className="alert warn">
          Not a field of this document: {unknown.map((k) => `{{${k}}}`).join(', ')}. Saving is refused until it is fixed.
        </div>
      )}

      <h3 className="pt-section">Where it prints</h3>
      <Field label="Place" hint={ANCHOR_HINTS[block.anchor]}>
        <select value={block.anchor} disabled={ro || ANCHORS_FOR[block.type].length < 2} onChange={(e) => onPatch({ anchor: e.target.value as Anchor })}>
          {ANCHORS_FOR[block.type].map((a) => (
            <option key={a} value={a}>
              {ANCHOR_LABELS[a]}
            </option>
          ))}
        </select>
      </Field>
      <div className="pt-grid-2">
        <NumberField label="Across (pt)" value={block.x} min={0} disabled={ro} onChange={(v) => onPatch({ x: v }, 'x')} />
        <NumberField label="Down (pt)" value={block.y} min={0} disabled={ro} onChange={(v) => onPatch({ y: v }, 'y')} />
        <NumberField label={block.type === 'line' ? 'Length (pt)' : 'Width (pt)'} value={block.w} min={1} disabled={ro} onChange={(v) => onPatch({ w: v }, 'w')} />
        <NumberField
          label={block.type === 'line' ? 'Thickness (pt)' : 'Height (pt)'}
          value={block.h}
          min={block.type === 'line' ? 0.25 : 1}
          step={block.type === 'line' ? 0.25 : 0.5}
          disabled={ro}
          onChange={(v) => onPatch({ h: v }, 'h')}
        />
      </div>
      {block.type !== 'items' && (
        <Field label="Print it" hint="A box with a condition prints only when that field has something in it, and closes up otherwise.">
          <select value={block.showIf ?? ''} disabled={ro} onChange={(e) => onPatch({ showIf: e.target.value || null })}>
            <option value="">Always</option>
            <FieldOptions fields={fields.filter((f) => f.group !== 'Page')} />
          </select>
        </Field>
      )}

      {(block.type === 'line' || block.type === 'box') && (
        <ColorField label="Colour" value={block.color} disabled={ro} onChange={(v) => onPatch({ color: v }, 'color')} />
      )}
      {block.type === 'logo' && (
        <Field label="Inside its box">
          <AlignChoice value={block.align} disabled={ro} onChange={(v) => onPatch({ align: v })} />
        </Field>
      )}
      {block.type === 'items' && <ItemsSettings block={block} columns={columns} disabled={ro} onPatch={onPatch} />}
      {block.type === 'totals' && (
        <>
          <h3 className="pt-section">Totals</h3>
          <div className="pt-grid-2">
            <NumberField label="Type size" value={block.size} min={6} max={14} disabled={ro} onChange={(v) => onPatch({ size: v }, 'size')} />
            <NumberField label="Label width (pt)" value={block.labelWidth} min={20} disabled={ro} onChange={(v) => onPatch({ labelWidth: v }, 'labelWidth')} />
          </div>
          <ColorField label="Figures" value={block.textColor} disabled={ro} onChange={(v) => onPatch({ textColor: v }, 'textColor')} />
          <ColorField label="The total, and its rule" value={block.accentColor} disabled={ro} onChange={(v) => onPatch({ accentColor: v }, 'accentColor')} />
          <ColorField label="Rules" value={block.ruleColor} disabled={ro} onChange={(v) => onPatch({ ruleColor: v }, 'ruleColor')} />
          <p className="hint">With nothing to print — a quotation whose salesperson ticked “Hide total” — this box prints nothing and what follows closes up.</p>
        </>
      )}
      {block.type === 'signoffs' && (
        <>
          <h3 className="pt-section">Sign-offs</h3>
          <div className="pt-grid-2">
            <NumberField label="Name size (pt)" value={block.nameSize} min={6} max={18} disabled={ro} onChange={(v) => onPatch({ nameSize: v }, 'nameSize')} />
            <NumberField label="Details size (pt)" value={block.size} min={6} max={14} disabled={ro} onChange={(v) => onPatch({ size: v }, 'size')} />
            <NumberField label="Column width (pt)" value={block.colWidth} min={40} disabled={ro} onChange={(v) => onPatch({ colWidth: v }, 'colWidth')} />
          </div>
          <Checkbox checked={block.showPhone} onChange={(v) => !ro && onPatch({ showPhone: v })} label="The contact number, under the name" />
          <Checkbox checked={block.showEmail} onChange={(v) => !ro && onPatch({ showEmail: v })} label="The email, under the name" />
          <Checkbox checked={block.showPosition} onChange={(v) => !ro && onPatch({ showPosition: v })} label="The position, under the name" />
          <ColorField label="Headings" value={block.headColor} disabled={ro} onChange={(v) => onPatch({ headColor: v }, 'headColor')} />
          <ColorField label="Names and details" value={block.textColor} disabled={ro} onChange={(v) => onPatch({ textColor: v }, 'textColor')} />
          <p className="hint">
            One column a person: who prepared it, then every approval step, each dated once done and “Pending” until then. The contact
            number is the person’s phone in Admin › Users, else the mobile they keep on My Account.
          </p>
        </>
      )}

      {canEdit && (
        <div className="pt-box-actions">
          <button type="button" className="btn btn-sm" onClick={() => onLayer(-1)} disabled={index <= 0}>
            Send back
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onLayer(1)} disabled={index >= layout.blocks.length - 1}>
            Bring forward
          </button>
          {(block.type === 'text' || block.type === 'line' || block.type === 'box' || block.type === 'logo') && (
            <button type="button" className="btn btn-sm" onClick={onDuplicate}>
              Duplicate
            </button>
          )}
          {block.type !== 'items' && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onRemove} title="Undo (Ctrl+Z) brings it back">
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TextSettings({
  block,
  fields,
  values,
  canCompany,
  disabled,
  onPatch,
}: {
  block: TextBlock;
  fields: FieldDef[];
  values: Record<string, string>;
  canCompany: boolean;
  disabled: boolean;
  onPatch: (patch: Patch, key?: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // What this box has nothing for right now, and so leaves out.
  const empty = emptyFieldsIn([block], values);
  const fromCompany = empty.filter((k) => k.startsWith('company.'));
  const fromQuotation = empty.filter((k) => !k.startsWith('company.'));
  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;

  function insert(token: string, wrap?: boolean) {
    const ta = ref.current;
    const start = ta?.selectionStart ?? block.text.length;
    const end = ta?.selectionEnd ?? start;
    const chosen = block.text.slice(start, end);
    const piece = wrap ? `**${chosen || 'bold text'}**` : token;
    onPatch({ text: block.text.slice(0, start) + piece + block.text.slice(end) });
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const at = start + piece.length;
      ta.setSelectionRange(at, at);
    });
  }

  return (
    <>
      <Field label="What it prints" hint="Type the text, and put a field where the quotation’s own details go.">
        <textarea ref={ref} rows={5} value={block.text} disabled={disabled} spellCheck={false} onChange={(e) => onPatch({ text: e.target.value }, 'text')} />
      </Field>
      <div className="pt-insert">
        <select aria-label="Insert a field where the cursor is" value="" disabled={disabled} onChange={(e) => e.target.value && insert(`{{${e.target.value}}}`)}>
          <option value="">Insert a field…</option>
          <FieldOptions fields={fields} />
        </select>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => insert('', true)}>
          Bold the selection
        </button>
      </div>
      {fromCompany.length > 0 && (
        <p className="pt-left-out">
          Not printing now: {listOf(fromCompany.map((k) => COMPANY_SETTING_NAMES[k] ?? labelOf(k)))} — empty in Company Settings.{' '}
          {canCompany && <Link to="/admin/company">Open Company Settings</Link>}
        </p>
      )}
      {fromQuotation.length > 0 && (
        <p className="pt-left-out">
          Not printing with the sample: {listOf(fromQuotation.map(labelOf))} — a document that has {fromQuotation.length > 1 ? 'them' : 'it'} prints {fromQuotation.length > 1 ? 'them' : 'it'}.
        </p>
      )}
      <details className="pt-rules">
        <summary>How text and fields print</summary>
        <ul className="pt-help">
          <li>
            <code>{'{{customer.name}}'}</code> prints the customer’s name; <code>{'{{quotation.prNumber|—}}'}</code> prints “—” when there is none.
          </li>
          <li>A line whose fields are all empty is left out, so an unset fax never prints a bare “Fax:”.</li>
          <li>
            Parts of a line split by <code> | </code> drop out on their own: “Tel: … | Email: …” prints just the email when there is no phone.
          </li>
          <li>
            <code>**Delivery:**</code> prints “Delivery:” in bold.
          </li>
        </ul>
      </details>

      <h3 className="pt-section">Type</h3>
      <div className="pt-grid-2">
        <NumberField label="Size (pt)" value={block.size} min={4} max={72} disabled={disabled} onChange={(v) => onPatch({ size: v }, 'size')} />
        <NumberField label="Letter spacing (pt)" value={block.spacing} min={0} max={10} step={0.1} disabled={disabled} onChange={(v) => onPatch({ spacing: v }, 'spacing')} />
        <NumberField label="Space between lines (pt)" value={block.lineGap} min={0} max={40} disabled={disabled} onChange={(v) => onPatch({ lineGap: v }, 'lineGap')} />
      </div>
      <div className="pt-toggles">
        <Toggle on={block.bold} disabled={disabled} onChange={(v) => onPatch({ bold: v })}>
          Bold
        </Toggle>
        <Toggle on={block.italic} disabled={disabled} onChange={(v) => onPatch({ italic: v })}>
          Italic
        </Toggle>
        <Toggle on={block.uppercase} disabled={disabled} onChange={(v) => onPatch({ uppercase: v })}>
          CAPITALS
        </Toggle>
      </div>
      <Field label="Alignment">
        <AlignChoice value={block.align} disabled={disabled} onChange={(v) => onPatch({ align: v })} />
      </Field>
      <ColorField label="Colour" value={block.color} disabled={disabled} onChange={(v) => onPatch({ color: v }, 'color')} />
      <Checkbox checked={block.fit} onChange={(v) => !disabled && onPatch({ fit: v })} label="Shrink the type to keep each line on one line" />
      <Checkbox checked={block.multiPageOnly} onChange={(v) => !disabled && onPatch({ multiPageOnly: v })} label="Print only when the document runs to more than one page" />
    </>
  );
}

function ItemsSettings({
  block,
  columns,
  disabled,
  onPatch,
}: {
  block: ItemsBlock;
  columns: { key: ColumnKey; label: string }[];
  disabled: boolean;
  onPatch: (patch: Patch, key?: string) => void;
}) {
  const total = block.columns.reduce((n, c) => n + c.width, 0);
  const setColumns = (next: ItemsBlock['columns'], key?: string) => onPatch({ columns: next }, key);
  const change = (i: number, patch: Partial<ItemsBlock['columns'][number]>, key?: string) =>
    setColumns(block.columns.map((c, n) => (n === i ? { ...c, ...patch } : c)), key ? `col${i}.${key}` : undefined);
  const moveCol = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= block.columns.length) return;
    const next = [...block.columns];
    [next[i], next[j]] = [next[j], next[i]];
    setColumns(next);
  };
  return (
    <>
      <h3 className="pt-section">Columns</h3>
      <p className="hint">
        Widths are shares of the table: {pt(total)} pt now, spread across the table’s {pt(block.w)} pt. Headings may carry a field, as in “Unit price (
        {'{{quotation.currency}}'})”.
      </p>
      <ol className="pt-columns">
        {block.columns.map((c, i) => (
          <li key={i} className="pt-column">
            <div className="pt-column-row">
              <select value={c.key} disabled={disabled} aria-label={`Column ${i + 1}: what it prints`} onChange={(e) => change(i, { key: e.target.value as ColumnKey })}>
                {columns.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-sm btn-danger" disabled={disabled || block.columns.length < 2} aria-label={`Remove column ${i + 1}`} onClick={() => setColumns(block.columns.filter((_, n) => n !== i))}>
                ×
              </button>
            </div>
            <input value={c.label} disabled={disabled} aria-label={`Column ${i + 1}: heading`} onChange={(e) => change(i, { label: e.target.value }, 'label')} />
            <div className="pt-column-row">
              <NumberInput
                kind="decimal"
                min={1}
                step={0.5}
                value={pt(c.width)}
                disabled={disabled}
                aria-label={`Column ${i + 1}: width in points`}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1) change(i, { width: n }, 'width');
                }}
              />
              <select value={c.align} disabled={disabled} aria-label={`Column ${i + 1}: alignment`} onChange={(e) => change(i, { align: e.target.value as Align })}>
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
              </select>
              <button type="button" className="btn btn-sm" disabled={disabled || i === 0} aria-label={`Move column ${i + 1} left`} onClick={() => moveCol(i, -1)}>
                ←
              </button>
              <button type="button" className="btn btn-sm" disabled={disabled || i === block.columns.length - 1} aria-label={`Move column ${i + 1} right`} onClick={() => moveCol(i, 1)}>
                →
              </button>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled || block.columns.length >= 8}
        onClick={() => setColumns([...block.columns, { key: 'no', label: '#', width: 30, align: 'left' }])}
      >
        Add a column
      </button>
      {block.columns.some((c) => c.key === 'group') && (
        <p className="hint">With a Group column, a group prints on each line rather than as a heading over them.</p>
      )}
      <h3 className="pt-section">Type and colour</h3>
      <NumberField label="Size (pt)" value={block.size} min={6} max={14} disabled={disabled} onChange={(v) => onPatch({ size: v }, 'size')} />
      <ColorField label="Column headings" value={block.headColor} disabled={disabled} onChange={(v) => onPatch({ headColor: v }, 'headColor')} />
      <ColorField label="Subheadings" value={block.headingColor} disabled={disabled} onChange={(v) => onPatch({ headingColor: v }, 'headingColor')} />
      <ColorField label="Product names and figures" value={block.textColor} disabled={disabled} onChange={(v) => onPatch({ textColor: v }, 'textColor')} />
      <ColorField label="Descriptions" value={block.bodyColor} disabled={disabled} onChange={(v) => onPatch({ bodyColor: v }, 'bodyColor')} />
      <ColorField label="Rules" value={block.ruleColor} disabled={disabled} onChange={(v) => onPatch({ ruleColor: v }, 'ruleColor')} />
      <p className="hint">
        The table starts where it is on page 1 and carries on from the top guide on later pages, its headings repeated. What follows it moves with it.
      </p>
    </>
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

interface QuoteRow {
  id: string;
  number: string;
  subject: string;
  customer?: { name: string } | null;
}

interface OrderRow {
  id: string;
  number: string;
  customer?: { name: string } | null;
  quotation?: { subject: string } | null;
}

function PreviewControl({
  docType,
  label,
  value,
  onValue,
  picked,
  onPicked,
  busy,
  onPreview,
}: {
  docType: DocType;
  label: string;
  value: 'short' | 'long' | 'real';
  onValue: (v: 'short' | 'long' | 'real') => void;
  picked: { id: string; number: string; label: string } | null;
  onPicked: (q: { id: string; number: string; label: string } | null) => void;
  busy: boolean;
  onPreview: () => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<{ id: string; number: string; name: string; sub: string }[]>([]);
  const [problem, setProblem] = useState('');
  const lower = label.toLowerCase();

  useEffect(() => {
    if (value !== 'real' || picked) return;
    const t = setTimeout(() => {
      const load =
        docType === 'quotation'
          ? api
              .get<{ rows: QuoteRow[] }>(`/quotations${qs({ search, pageSize: 6 })}`)
              .then((r) => r.rows.map((x) => ({ id: x.id, number: x.number, name: x.customer?.name ?? '', sub: x.subject })))
          : api
              .get<{ rows: OrderRow[] }>(`/sales-orders${qs({ search, pageSize: 6 })}`)
              .then((r) => r.rows.map((x) => ({ id: x.id, number: x.number, name: x.customer?.name ?? '', sub: x.quotation?.subject ?? '' })));
      load
        .then((list) => {
          setRows(list);
          setProblem('');
        })
        .catch((err) =>
          setProblem(
            err instanceof ApiError && err.status === 403
              ? `Choosing a real ${lower} needs access to ${lower}s.`
              : `Could not search the ${lower}s.`,
          ),
        );
    }, 250);
    return () => clearTimeout(t);
  }, [search, value, picked, docType, lower]);

  return (
    <div className="pt-preview">
      <label className="pt-preview-label" htmlFor="pt-preview-with">
        Preview with
      </label>
      <select id="pt-preview-with" value={value} onChange={(e) => onValue(e.target.value as 'short' | 'long' | 'real')}>
        <option value="short">the sample, one page</option>
        <option value="long">the sample, several pages</option>
        <option value="real">a {lower}…</option>
      </select>
      {value === 'real' &&
        (picked ? (
          <span className="pt-picked">
            <span className="mono">{picked.number}</span> {picked.label}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onPicked(null)}>
              Change
            </button>
          </span>
        ) : (
          <div className="pt-picker">
            <input
              value={search}
              placeholder="Number, customer or name"
              aria-label={`Find the ${lower} to preview with`}
              onChange={(e) => setSearch(e.target.value)}
            />
            {(rows.length > 0 || problem) && (
              <ul className="pt-picker-list">
                {problem && <li className="faint">{problem}</li>}
                {rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => onPicked({ id: r.id, number: r.number, label: r.name || r.sub })}>
                      <span className="mono">{r.number}</span> {r.name} <span className="faint">{r.sub}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      <button type="button" className="btn" onClick={onPreview} disabled={busy}>
        Preview PDF
      </button>
    </div>
  );
}
