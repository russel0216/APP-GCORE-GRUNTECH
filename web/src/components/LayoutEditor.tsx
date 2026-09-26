import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { applyAppearance, normalise, type Appearance } from '../lib/appearance';
import {
  countMatches,
  describe,
  globalSelectorFor,
  isNameable,
  matchesUniquely,
  selectorFor,
} from '../lib/selector';
import { useToast } from './ui';

/**
 * The layout editor — drag a thing where you want it, drag its edge to resize.
 *
 * The gesture cannot move the DOM, because React owns the DOM and repaints it
 * on the next render. So every gesture is recorded as a CSS rule against a
 * selector for the element (see lib/selector.ts), stored with the rest of the
 * appearance, and applied from the same stylesheet — which is why a nudge
 * survives a reload, and why it applies for everyone rather than only on the
 * machine it was made on.
 *
 * What a drag actually writes:
 *
 *   moving    `translate(x, y)` — the element is LIFTED off the layout, not
 *             re-flowed into a new place. Everything around it stays where it
 *             was, which is usually what somebody nudging a card wants, and
 *             is the only honest option: a flex row has no coordinates to
 *             drop something into.
 *   resizing  `width` / `height` in pixels.
 *
 * Both are corrections on top of a responsive layout, so a big nudge that
 * looks right on a wide screen can look wrong on a narrow one. Small ones are
 * safe; if something needs to move a long way, that is a layout change and
 * belongs in the code.
 */

type Mode = 'idle' | 'moving' | 'resizing';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Selection {
  el: HTMLElement;
  /** This element, on this screen. */
  selector: string;
  /** Everything of the same kind, everywhere — null when it has no class to go on. */
  global: string | null;
  name: string;
  box: Box;
}

/**
 * What a gesture is allowed to write.
 *
 * The last five are not things anybody asks for — they are what a width or a
 * height needs around it before it means anything. See `companions()`.
 */
type Prop =
  | 'transform'
  | 'width'
  | 'height'
  | 'flex'
  | 'min-width'
  | 'max-width'
  | 'min-height'
  | 'max-height'
  // Type. These are the ones worth setting app-wide rather than per box.
  | 'font-family'
  | 'font-size'
  | 'font-weight'
  | 'font-style'
  | 'text-transform'
  | 'letter-spacing'
  | 'text-align'
  | 'color';

/** The three stacks the app is built on, under the names somebody would use. */
const FONTS: { label: string; value: string }[] = [
  { label: 'Body', value: 'var(--body)' },
  { label: 'Display', value: 'var(--display)' },
  { label: 'Mono', value: 'var(--mono)' },
];

const WEIGHTS: { label: string; value: string }[] = [
  { label: 'Normal', value: '400' },
  { label: 'Medium', value: '500' },
  { label: 'Bold', value: '700' },
];

/** Theme colours by their job, so a change follows the theme rather than fixing a hex. */
const COLOURS: { label: string; value: string }[] = [
  { label: 'Text', value: 'var(--text)' },
  { label: 'Muted', value: 'var(--muted)' },
  { label: 'Faint', value: 'var(--faint)' },
  { label: 'Accent', value: 'var(--neon)' },
  { label: 'Warning', value: 'var(--warn)' },
  { label: 'Bad', value: 'var(--danger)' },
];

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * The rules a size needs beside it to actually apply.
 *
 * `width` is not the last word on how wide something is. A flex item takes
 * its main-axis size from `flex-basis`, so `.donut-legend { flex: 1 }` — a
 * basis of 0% that grows — ignored an explicit width entirely: the editor
 * wrote `width: 381px`, the panel reported it, and the box did not move.
 * `flex: none` hands the decision back to `width`. A `min-width` does the
 * same job from the other end, clamping anything dragged below it, which is
 * why those go too.
 *
 * Only written when they are needed: `flex` on an element whose parent is
 * actually a flex container, and the clamps only on the axis being resized.
 */
function companions(el: HTMLElement, axis: 'width' | 'height'): Partial<Record<Prop, string>> {
  const out: Partial<Record<Prop, string>> = {};
  const parent = el.parentElement;
  if (parent && getComputedStyle(parent).display.includes('flex')) out.flex = 'none';
  if (axis === 'width') {
    out['min-width'] = '0';
    /*
      `100%`, never `none`.

      A dragged width is a fixed number of pixels and the column around it is
      not — collapse the sidebar and the column can end up narrower than the
      width that was set. `max-width: none` was here first, to stop an
      existing maximum clamping the drag, and it also removed the only thing
      keeping the element inside its parent: a funnel set to 680px in a 397px
      column overflowed it and painted its right-hand column, the drop-off
      percentage, underneath the cards beside it.

      `100%` keeps the drag honest at the width it was made and lets the
      element give way when there is less room, which is the behaviour
      everything else on the page already has.
    */
    out['max-width'] = '100%';
  } else {
    out['min-height'] = '0';
    out['max-height'] = 'none';
  }
  return out;
}

/** `translate(12px, -4px)` back into numbers, so a second drag continues the first. */
function readTranslate(value: string | undefined): { x: number; y: number } {
  if (!value) return { x: 0, y: 0 };
  const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(value);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

export function LayoutEditor() {
  const { me, refresh } = useAuth();
  const toast = useToast();

  const [on, setOn] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  /* Which corner the panel is in, and whether it is rolled up out of the way. */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [dodge, setDodge] = useState(false);
  const [minimised, setMinimised] = useState(false);
  /*
    Which selector a change is written against.

    'one'  this element on this screen — right for nudging a box into place.
    'all'  everything of the same kind, everywhere — right for type, and the
           only scope that reaches a record created tomorrow. A lead's route
           carries its id, so a rule written against 'one' on a lead page
           applies to that lead and no other.
  */
  const [scope, setScope] = useState<'one' | 'all'>('one');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
    The dot grid. 0 is off; anything else is the step in pixels, and 8 is the
    default because the app's spacing scale is built on a 4px base and 8 is
    the step most of it actually lands on. Remembered per viewer — it is a
    working preference, not a setting anybody else should inherit.
  */
  const [grid, setGrid] = useState(() => {
    try {
      // `Number(null)` is 0, not NaN — read as "grid off" on a first visit and
      // quietly defaulted the whole feature to disabled. The absent key has to
      // be checked before the value is parsed.
      const raw = localStorage.getItem('gcore_le_grid');
      if (raw === null) return 8;
      const saved = Number(raw);
      return Number.isFinite(saved) && saved >= 0 ? saved : 8;
    } catch {
      return 8;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('gcore_le_grid', String(grid));
    } catch {
      /* a preference that cannot be saved is still a preference */
    }
  }, [grid]);

  /* The dots are drawn in document space, so they hold still as the page scrolls. */
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!on) return;
    const read = () => setScroll({ x: window.scrollX, y: window.scrollY });
    read();
    window.addEventListener('scroll', read, { passive: true });
    return () => window.removeEventListener('scroll', read);
  }, [on]);

  /**
   * The nearest grid line to a DOCUMENT coordinate.
   *
   * Document, not viewport: two cards nudged at different scroll positions
   * have to land on the same lines, or the grid aligns things to wherever the
   * page happened to be sitting rather than to each other.
   */
  const snap = useCallback(
    (docValue: number) => (grid > 0 ? Math.round(docValue / grid) * grid : docValue),
    [grid],
  );

  /* The appearance being edited, and the copy last saved. */
  const draft = useRef<Appearance | null>(null);
  const saved = useRef<Appearance | null>(null);

  /*
    The super admin alone — the seeded System Administrator.

    Not `admin.appearance.edit_all`, which several admin roles hold: that
    permission opens the Appearance screen, where a change is a considered one
    made against a labelled setting. This is a pointer dragging a live page,
    and a stray one lands on everybody's screen. Gating it in the UI is the
    whole gate, and that is not a hole: the endpoint behind it is the same one
    the Appearance screen uses, so nobody gains anything they could not
    already do there — they just do not get the drag tool.
  */
  const allowed = !!me?.user.isSuperAdmin;

  /* Load once, the first time the editor is switched on. */
  useEffect(() => {
    if (!on || draft.current) return;
    api
      .get<Appearance>('/appearance')
      .then((a) => {
        draft.current = normalise(a);
        saved.current = normalise(a);
      })
      .catch(() => {
        draft.current = normalise(null);
        saved.current = normalise(null);
      });
  }, [on]);

  /*
    Undo, one step at a time.

    A step is a GESTURE, not a state change: a drag fires a write on every
    pointer move, and undoing a card back across the screen a pixel at a time
    would be undo in name only. So the stack is pushed once when a gesture
    starts, and the dozens of writes that follow land on top of that single
    entry. A keyboard nudge is its own gesture, because each press is its own
    decision.

    Snapshots of the whole rule set rather than inverse operations — it is a
    small object, and a snapshot cannot drift out of step with the thing it
    claims to undo.
  */
  type Rules = Appearance['rules'];
  const history = useRef<Rules[]>([]);
  const future = useRef<Rules[]>([]);
  const [steps, setSteps] = useState({ back: 0, forward: 0 });

  const HISTORY_LIMIT = 60;

  const paint = useCallback(() => {
    if (draft.current) applyAppearance(draft.current, { persist: false });
  }, []);

  /** Whether the draft still says the same thing as the last save. */
  const recheck = useCallback(() => {
    setDirty(JSON.stringify(draft.current?.rules) !== JSON.stringify(saved.current?.rules));
    setSteps({ back: history.current.length, forward: future.current.length });
  }, []);

  /** Marks the start of one undoable change. Call before the first write of a gesture. */
  const beginStep = useCallback(() => {
    if (!draft.current) return;
    history.current.push(JSON.parse(JSON.stringify(draft.current.rules)) as Rules);
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    // A new edit is a new branch; whatever was undone is no longer ahead of us.
    future.current = [];
    setSteps({ back: history.current.length, forward: 0 });
  }, []);

  /**
   * Writes several properties at once and repaints.
   *
   * Batched rather than one call per property, so a resize and the rules that
   * make it apply land in a single paint and count as a single undo step —
   * otherwise stepping back from a drag would peel off `min-width` first and
   * leave the element half-changed.
   */
  const writeMany = useCallback(
    (selector: string, patch: Partial<Record<Prop, string | null>>) => {
      const a = draft.current;
      if (!a) return;
      const decls = { ...(a.rules[selector] ?? {}) };
      for (const [prop, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete decls[prop];
        else decls[prop] = value;
      }

      const rules = { ...a.rules };
      if (Object.keys(decls).length) rules[selector] = decls;
      else delete rules[selector];

      draft.current = { ...a, rules };
      paint();
      recheck();
    },
    [paint, recheck],
  );

  const write = useCallback(
    (selector: string, prop: Prop, value: string | null) => writeMany(selector, { [prop]: value }),
    [writeMany],
  );

  /** A width or a height, together with whatever has to be true for it to apply. */
  const writeSize = useCallback(
    (selector: string, el: HTMLElement, axis: 'width' | 'height', px: number) => {
      writeMany(selector, { [axis]: `${px}px`, ...companions(el, axis) });
    },
    [writeMany],
  );

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (!previous || !draft.current) return;
    future.current.push(JSON.parse(JSON.stringify(draft.current.rules)) as Rules);
    draft.current = { ...draft.current, rules: previous };
    paint();
    recheck();
  }, [paint, recheck]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !draft.current) return;
    history.current.push(JSON.parse(JSON.stringify(draft.current.rules)) as Rules);
    draft.current = { ...draft.current, rules: next };
    paint();
    recheck();
  }, [paint, recheck]);

  /* ── Picking something ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!on) return;

    function pick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      // The editor's own furniture is not part of the page being edited.
      if (!target || target.closest('.le-ui')) return;
      e.preventDefault();
      e.stopPropagation();

      /*
        Climb until something can be named, rather than refusing the click.

        A click lands wherever the pointer was, which is often a wrapper with
        no class or a gap between cards. Telling somebody off for that is
        noise: they were pointing at the thing, not at the div. So the nearest
        nameable ancestor is what gets picked, and a click that resolves to
        nothing at all just clears the selection — which is what clicking
        empty space means everywhere else.
      */
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        if (node.closest('.le-ui')) break;
        if (!isNameable(node)) continue;
        const selector = selectorFor(node);
        if (selector && matchesUniquely(selector, node)) {
          setSel({
            el: node,
            selector,
            global: globalSelectorFor(node),
            name: describe(node),
            box: boxOf(node),
          });
          return;
        }
      }
      setSel(null);
    }

    /*
      Mousedown is swallowed as well as click.

      A dialog closes when you press on its backdrop, and that listener is on
      mousedown — so picking something inside a modal, or missing it slightly,
      dismissed the whole dialog mid-edit. In edit mode you are not using the
      application, you are changing it, so the page's own handlers stay out of
      the way; the editor's own controls are exempt.
    */
    function swallow(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('.le-ui')) return;
      e.preventDefault();
      e.stopPropagation();
    }

    document.addEventListener('click', pick, true);
    document.addEventListener('mousedown', swallow, true);
    return () => {
      document.removeEventListener('click', pick, true);
      document.removeEventListener('mousedown', swallow, true);
    };
  }, [on]);

  /* The outline follows the element as the page scrolls or reflows. */
  useEffect(() => {
    if (!sel) return;
    let frame = 0;
    const follow = () => {
      setSel((s) => (s ? { ...s, box: boxOf(s.el) } : s));
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [sel?.el]);

  /*
    The panel gets out of the way of whatever you are working on.

    It lives in the bottom-right corner, which is exactly where a card on the
    right-hand side of a record ends up — and a panel on top of a card is a
    card you cannot pick up, let alone drag. When the selection would sit
    underneath it, the panel moves to the other corner.

    The test is against where the panel WOULD be on the right, not where it
    currently is. Testing its current position makes the answer depend on the
    answer: it dodges left, no longer overlaps, dodges back, and flickers
    between the two for as long as you look at it.
  */
  useEffect(() => {
    if (!on) return;
    const el = panelRef.current;
    if (!el || !sel) {
      setDodge(false);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 16;
    const home = {
      left: window.innerWidth - margin - w,
      right: window.innerWidth - margin,
      top: window.innerHeight - margin - h,
      bottom: window.innerHeight - margin,
    };
    const b = sel.box;
    const overlaps =
      b.left < home.right &&
      b.left + b.width > home.left &&
      b.top < home.bottom &&
      b.top + b.height > home.top;
    setDodge(overlaps);
  }, [on, sel?.box.left, sel?.box.top, sel?.box.width, sel?.box.height]);

  /* Escape clears the selection, the arrows move it, Ctrl+Z steps back. */
  useEffect(() => {
    if (!on) return;

    const key = (e: KeyboardEvent) => {
      // Never steal a key from something being typed into.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;

      const z = e.key.toLowerCase() === 'z';
      if ((e.ctrlKey || e.metaKey) && z && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && ((z && e.shiftKey) || e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') {
        setSel(null);
        return;
      }

      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = arrows[e.key];
      if (!dir || !sel) return;

      e.preventDefault();

      /*
        One press is one step of the grid, so nudging keeps whatever alignment
        the grid gave you. Shift is the long stride, Alt resizes instead of
        moving — and with the grid off a step is a single pixel, which is the
        only sensible reading of "one" when there is no rhythm to follow.
      */
      const base = grid > 0 ? grid : 1;
      const stride = e.shiftKey ? base * 4 : base;
      const [dx, dy] = dir;

      beginStep();

      if (e.altKey) {
        const box = boxOf(sel.el);
        if (dx) writeSize(sel.selector, sel.el, 'width', Math.max(24, Math.round(box.width + dx * stride)));
        if (dy) writeSize(sel.selector, sel.el, 'height', Math.max(16, Math.round(box.height + dy * stride)));
        return;
      }

      const from = readTranslate(draft.current?.rules[sel.selector]?.transform);
      const x = from.x + dx * stride;
      const y = from.y + dy * stride;
      write(sel.selector, 'transform', x === 0 && y === 0 ? null : `translate(${x}px, ${y}px)`);
    };

    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [on, sel, grid, beginStep, write, undo, redo]);

  /* ── Dragging ───────────────────────────────────────────────────────── */

  function startMove(e: React.PointerEvent) {
    if (!sel) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const from = readTranslate(draft.current?.rules[sel.selector]?.transform);
    const box = boxOf(sel.el);
    /*
      Where the element's top-left would sit with no translate at all. The
      snap works on the EDGE rather than on the offset: rounding the offset
      moves things in tidy steps but never lines two of them up, because they
      started at different places. Rounding the edge puts them on the same
      line, which is what a grid is for.
    */
    const originX = box.left + window.scrollX - from.x;
    const originY = box.top + window.scrollY - from.y;
    setMode('moving');
    beginStep();

    const move = (ev: PointerEvent) => {
      const wantX = originX + from.x + (ev.clientX - start.x);
      const wantY = originY + from.y + (ev.clientY - start.y);
      const x = Math.round(snap(wantX) - originX);
      const y = Math.round(snap(wantY) - originY);
      write(sel.selector, 'transform', x === 0 && y === 0 ? null : `translate(${x}px, ${y}px)`);
    };
    const up = () => {
      setMode('idle');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e: React.PointerEvent, handle: Handle) {
    if (!sel) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const from = boxOf(sel.el);
    const t0 = readTranslate(draft.current?.rules[sel.selector]?.transform);
    // Document-space edges, so the snap lands on the same lines as a move does.
    const left0 = from.left + window.scrollX;
    const top0 = from.top + window.scrollY;
    const right0 = left0 + from.width;
    const bottom0 = top0 + from.height;
    setMode('resizing');
    beginStep();

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let w = from.width;
      let h = from.height;
      let tx = t0.x;
      let ty = t0.y;

      /*
        Dragging a west or north handle has to move the element as well as
        resize it. Width alone anchors the left edge, so pulling the left
        handle leftwards would have grown the card out of its RIGHT side —
        the edge under the pointer would stay put while the opposite one
        moved, which feels like the handle is broken. Shifting the translate
        by the same amount keeps the edge you are holding under the pointer.
      */
      if (handle.includes('e')) w = snap(right0 + dx) - left0;
      if (handle.includes('w')) {
        const newLeft = snap(left0 + dx);
        w = right0 - newLeft;
        tx = t0.x + (newLeft - left0);
      }
      if (handle.includes('s')) h = snap(bottom0 + dy) - top0;
      if (handle.includes('n')) {
        const newTop = snap(top0 + dy);
        h = bottom0 - newTop;
        ty = t0.y + (newTop - top0);
      }

      if (handle.includes('e') || handle.includes('w')) {
        writeSize(sel.selector, sel.el, 'width', Math.max(24, Math.round(w)));
      }
      if (handle.includes('n') || handle.includes('s')) {
        writeSize(sel.selector, sel.el, 'height', Math.max(16, Math.round(h)));
      }
      if (handle.includes('w') || handle.includes('n')) {
        const x = Math.round(tx);
        const y = Math.round(ty);
        write(sel.selector, 'transform', x === 0 && y === 0 ? null : `translate(${x}px, ${y}px)`);
      }
    };
    const up = () => {
      setMode('idle');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ── Saving ─────────────────────────────────────────────────────────── */

  async function save() {
    if (!draft.current) return;
    setBusy(true);
    try {
      const sent = Object.keys(draft.current.rules);
      const stored = await api.put<Appearance>('/appearance', draft.current);
      const clean = normalise(stored);

      /*
        The server sanitises selectors before storing them, and for a while it
        rejected every one the editor produced — the route scope contains a
        `/` and the whitelist did not. It reported a clean 200 either way, so
        the save looked like it worked and the layout snapped back on reload.
        Comparing what came back against what went is how that stays visible.
      */
      const dropped = sent.filter((s) => !clean.rules[s]);

      draft.current = clean;
      saved.current = normalise(clean);
      applyAppearance(clean);
      await refresh();
      recheck();
      if (dropped.length) {
        toast(
          'error',
          `Saved, but ${dropped.length} element${dropped.length === 1 ? '' : 's'} could not be stored — the selector was refused`,
        );
      } else {
        toast('ok', 'Layout saved for everyone');
      }
    } catch {
      toast('error', 'That could not be saved');
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    if (!saved.current) return;
    draft.current = normalise(saved.current);
    applyAppearance(draft.current, { persist: false });
    history.current = [];
    future.current = [];
    setSteps({ back: 0, forward: 0 });
    setDirty(false);
    toast('ok', 'Back to the saved layout');
  }

  /**
   * Every edit made to the screen you are on, dropped in one step.
   *
   * Selectors are scoped by route, so "this screen" is just the rules whose
   * selector carries this route. Recovering from a layout that went wrong
   * should not mean hunting down each element that was touched.
   */
  function clearScreen() {
    const a = draft.current;
    if (!a) return;
    const scope = `[data-route="${window.location.pathname}"]`;
    const rules = Object.fromEntries(
      Object.entries(a.rules).filter(([selector]) => !selector.startsWith(scope)),
    );
    if (Object.keys(rules).length === Object.keys(a.rules).length) {
      toast('ok', 'Nothing has been changed on this screen');
      return;
    }
    beginStep();
    draft.current = { ...a, rules };
    paint();
    recheck();
    setSel(null);
  }

  function resetElement() {
    if (!sel || !target) return;
    const a = draft.current;
    if (!a) return;
    beginStep();
    const rules = { ...a.rules };
    delete rules[target];
    draft.current = { ...a, rules };
    paint();
    recheck();
  }

  /**
   * One typographic property, written through whichever scope is chosen.
   *
   * Passing null clears it — every control here is a toggle, so pressing the
   * weight you are already on puts it back to whatever the stylesheet says
   * rather than pinning the same value twice.
   */
  function styleIt(prop: Prop, value: string | null) {
    if (!target) return;
    beginStep();
    write(target, prop, value);
  }

  function nudgeFont(by: number) {
    if (!sel || !target) return;
    const current = parseFloat(getComputedStyle(sel.el).fontSize) || 14;
    beginStep();
    write(target, 'font-size', `${Math.max(6, Math.round(current + by))}px`);
  }

  /* Leaving edit mode puts back whatever was last saved. */
  function close() {
    if (dirty && saved.current) {
      applyAppearance(saved.current, { persist: false });
      draft.current = normalise(saved.current);
      setDirty(false);
    }
    setSel(null);
    setOn(false);
  }

  if (!allowed) return null;

  if (!on) {
    return (
      <button
        className="le-ui le-launch"
        onClick={() => setOn(true)}
        title="Move and resize things on this screen"
      >
        Modify layout
      </button>
    );
  }

  const rules = draft.current?.rules ?? {};
  /* Where a change lands: this one element, or everything of its kind. */
  const target = sel ? (scope === 'all' && sel.global ? sel.global : sel.selector) : null;
  const edited = target ? rules[target] : undefined;
  const reach = target ? countMatches(target) : 0;
  /*
    A record's URL carries its id, so a one-off rule on this page applies to
    this lead and to no other — and to nothing created later. Worth saying
    where it is true rather than letting somebody find out next week.
  */
  const perRecord = /\/[a-z0-9]{20,}$/i.test(window.location.pathname);
  /* What the element is actually set in right now, override or not. */
  const currentFontSize = sel ? Math.round(parseFloat(getComputedStyle(sel.el).fontSize) || 14) : 0;

  return (
    <>
      {/* A frame around the page, so it is obvious the app is in edit mode. */}
      <div className="le-ui le-frame" aria-hidden="true" />

      {/*
        The dots. Offset by the scroll position so they belong to the page
        rather than to the window — scroll down and they stay over the same
        places, which is the only way the lines mean anything between one
        drag and the next.
      */}
      {grid > 0 && (
        <div
          className="le-ui le-grid"
          aria-hidden="true"
          style={{
            backgroundSize: `${grid}px ${grid}px`,
            backgroundPosition: `${-scroll.x % grid}px ${-scroll.y % grid}px`,
          }}
        />
      )}

      {sel && (
        <div
          className={`le-ui le-select${mode !== 'idle' ? ' busy' : ''}`}
          style={{
            left: sel.box.left,
            top: sel.box.top,
            width: sel.box.width,
            height: sel.box.height,
          }}
          onPointerDown={startMove}
        >
          <span className="le-tag">{sel.name}</span>
          {HANDLES.map((h) => (
            <span
              key={h}
              className={`le-handle le-${h}`}
              onPointerDown={(e) => startResize(e, h)}
            />
          ))}
        </div>
      )}

      <div
        ref={panelRef}
        className={`le-ui le-panel${dodge ? ' dodged' : ''}${minimised ? ' rolled' : ''}${
          mode !== 'idle' ? ' gesturing' : ''
        }`}
        role="dialog"
        aria-label="Layout editor"
      >
        <div className="le-panel-head">
          <span className="le-title">
            <button
              className="le-roll"
              onClick={() => setMinimised((m) => !m)}
              aria-expanded={!minimised}
              title={minimised ? 'Show the controls' : 'Roll up, out of the way'}
            >
              {minimised ? '▸' : '▾'}
            </button>
            <strong>Modify layout</strong>
          </span>
          <div className="row" style={{ gap: 'var(--s-1)' }}>
            <button
              className="btn btn-sm"
              onClick={undo}
              disabled={!steps.back}
              title="Undo one change (Ctrl+Z)"
              aria-label="Undo one change"
            >
              ↶
            </button>
            <button
              className="btn btn-sm"
              onClick={redo}
              disabled={!steps.forward}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              ↷
            </button>
            <button className="btn btn-sm btn-ghost" onClick={close}>
              Done
            </button>
          </div>
        </div>

        <div className="le-row">
          <span>Snap to grid</span>
          <div className="row" style={{ gap: 'var(--s-1)' }}>
            {[0, 4, 8, 16].map((g) => (
              <button
                key={g}
                className={`btn btn-sm${grid === g ? ' btn-active' : ''}`}
                onClick={() => setGrid(g)}
              >
                {g === 0 ? 'Off' : g}
              </button>
            ))}
          </div>
        </div>

        {!sel ? (
          <p className="le-hint">
            Click anything on the page to pick it up. Then drag it to move it, or pull an edge to
            resize it. Edges land on the dots.
          </p>
        ) : (
          <>
            <div className="le-picked">
              <strong>{sel.name}</strong>
              <code title={target ?? ''}>{target}</code>
            </div>

            <div className="le-row">
              <span>Applies to</span>
              <div className="row" style={{ gap: 'var(--s-1)' }}>
                <button
                  className={`btn btn-sm${scope === 'one' ? ' btn-active' : ''}`}
                  onClick={() => setScope('one')}
                >
                  This one
                </button>
                <button
                  className={`btn btn-sm${scope === 'all' ? ' btn-active' : ''}`}
                  onClick={() => setScope('all')}
                  disabled={!sel.global}
                  title={sel.global ?? 'This element has no class to match others by'}
                >
                  Everywhere
                </button>
              </div>
            </div>

            <p className="le-hint">
              {scope === 'all'
                ? `Every ${sel.name.toLowerCase()} in the application — ${reach} on this screen, and any record made later.`
                : perRecord
                  ? 'This record only. A new lead has its own address, so it will not inherit this — use Everywhere for type.'
                  : `This one element on this screen — ${reach} match${reach === 1 ? '' : 'es'}.`}
            </p>

            <div className="le-type">
              <div className="le-row">
                <span>Font</span>
                <div className="row" style={{ gap: 'var(--s-1)' }}>
                  {FONTS.map((f) => (
                    <button
                      key={f.value}
                      className={`btn btn-sm${edited?.['font-family'] === f.value ? ' btn-active' : ''}`}
                      onClick={() => styleIt('font-family', f.value)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="le-row">
                <span>Size</span>
                <div className="row" style={{ gap: 'var(--s-1)' }}>
                  <button className="btn btn-sm" onClick={() => nudgeFont(-1)} aria-label="Smaller">
                    −
                  </button>
                  <span className="le-readout">{currentFontSize}px</span>
                  <button className="btn btn-sm" onClick={() => nudgeFont(1)} aria-label="Bigger">
                    +
                  </button>
                </div>
              </div>

              <div className="le-row">
                <span>Weight</span>
                <div className="row" style={{ gap: 'var(--s-1)' }}>
                  {WEIGHTS.map((w) => (
                    <button
                      key={w.value}
                      className={`btn btn-sm${edited?.['font-weight'] === w.value ? ' btn-active' : ''}`}
                      onClick={() => styleIt('font-weight', w.value)}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="le-row">
                <span>Style</span>
                <div className="row" style={{ gap: 'var(--s-1)' }}>
                  <button
                    className={`btn btn-sm${edited?.['font-style'] === 'italic' ? ' btn-active' : ''}`}
                    onClick={() =>
                      styleIt('font-style', edited?.['font-style'] === 'italic' ? null : 'italic')
                    }
                  >
                    <em>I</em>
                  </button>
                  <button
                    className={`btn btn-sm${edited?.['text-transform'] === 'uppercase' ? ' btn-active' : ''}`}
                    title="Upper case"
                    onClick={() =>
                      styleIt(
                        'text-transform',
                        edited?.['text-transform'] === 'uppercase' ? null : 'uppercase',
                      )
                    }
                  >
                    AA
                  </button>
                  {['left', 'center', 'right'].map((a) => (
                    <button
                      key={a}
                      className={`btn btn-sm${edited?.['text-align'] === a ? ' btn-active' : ''}`}
                      title={`Align ${a}`}
                      onClick={() => styleIt('text-align', edited?.['text-align'] === a ? null : a)}
                    >
                      {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="le-row">
                <span>Colour</span>
                <div className="row" style={{ gap: 'var(--s-1)' }}>
                  {COLOURS.map((c) => (
                    <button
                      key={c.value}
                      className={`le-swatch${edited?.color === c.value ? ' on' : ''}`}
                      style={{ background: c.value }}
                      title={c.label}
                      aria-label={c.label}
                      onClick={() => styleIt('color', edited?.color === c.value ? null : c.value)}
                    />
                  ))}
                </div>
              </div>
            </div>

            {edited && (
              <ul className="le-changes">
                {Object.entries(edited).map(([k, v]) => (
                  <li key={k}>
                    <code>{k}</code>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            )}

            <button className="btn btn-sm btn-ghost" onClick={resetElement} disabled={!edited}>
              Put this one back
            </button>

            <dl className="le-keys">
              <dt>Arrows</dt>
              <dd>move by {grid > 0 ? `${grid}px` : '1px'}</dd>
              <dt>Shift</dt>
              <dd>four steps at once</dd>
              <dt>Alt</dt>
              <dd>resize instead of move</dd>
              <dt>Ctrl+Z</dt>
              <dd>back one change</dd>
            </dl>
          </>
        )}

        <button className="btn btn-sm btn-ghost" onClick={clearScreen}>
          Clear this screen&rsquo;s edits
        </button>

        <div className="le-panel-foot">
          <button className="btn btn-sm" onClick={revert} disabled={!dirty || busy}>
            Discard
          </button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="le-note">
          Saved for everyone. A nudge is a correction on top of a responsive layout — small moves
          travel well, large ones may not at other window sizes.
        </p>
      </div>
    </>
  );
}
