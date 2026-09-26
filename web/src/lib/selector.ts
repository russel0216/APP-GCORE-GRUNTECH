/**
 * Naming an element on screen, so a drag can become a CSS rule.
 *
 * The layout editor cannot move a card by moving the DOM: React owns the DOM
 * and repaints it on the next render. So a gesture has to be recorded as a
 * rule instead, and a rule needs a selector that will still find the same
 * element after a reload.
 *
 * The selector is built from class names where the element has a meaningful
 * one, and from `:nth-of-type` where it does not. It is scoped to the screen
 * it was made on — `[data-route="/g-ops"] …` — so nudging a card on the
 * dashboard does not silently move the equivalent card on every other page.
 *
 * It is positional, and that is the honest limit: it names "the second card
 * in the first panel", not "the On hold card". Restructure that screen in
 * code and the rule may land somewhere else or stop matching. The editor
 * shows the selector it is about to write for exactly that reason.
 */

/** Where the editor stops climbing. Everything above is app chrome. */
const ROOT_ATTR = 'data-route';

/**
 * Classes worth naming an element by.
 *
 * A class earns its place here by being structural — the kind of thing
 * somebody points at and calls a card, a panel, a heading. Utility and state
 * classes (`row`, `stack`, `changed`, `active`) are skipped: they say how a
 * thing is arranged or how it is feeling, not which thing it is.
 */
const MEANINGFUL = [
  'kpi-card',
  'panel-block',
  'card',
  'page-head',
  'card-title',
  'panel-blurb',
  'token-row',
  'sidebar',
  'topbar',
  'content',
  'data-table',
  'record-head',
  'chart',
  'bar-row',
  'donut',
  'funnel',
  'stat',
  'btn',
  'badge',
];

const SKIP = new Set(['row', 'stack', 'fill', 'grid', 'grid-2', 'grid-3', 'grid-4', 'active', 'changed', 'open']);

/**
 * The class to name this element by, or null if it has none worth using.
 *
 * A known structural class wins, because those are the ones with friendly
 * names and the ones least likely to be renamed. Failing that, ANY class that
 * is not a utility will do — the allowlist alone meant every component built
 * after it was written fell back to its tag name, so the donut's legend was
 * pointed at as `ul`: correct at the time, and pointing at the wrong element
 * the moment a second list appears on the screen.
 */
function classFor(el: Element): string | null {
  const classes = [...el.classList].filter((c) => !SKIP.has(c) && !c.startsWith('le-'));
  const known = MEANINGFUL.find((m) => classes.includes(m));
  return known ?? classes[0] ?? null;
}

/**
 * One step of the path: a class or a tag, made unique among its siblings.
 *
 * `:nth-child`, not `:nth-of-type`. The two only agree when every sibling
 * shares a tag, which here they often did — `.kpi-card:nth-of-type(2)` means
 * "has that class AND is the second DIV", so the moment a heading or a
 * caption sits alongside, the count is against a different set than the one
 * it was measured from. `:nth-child` counts the position this element
 * actually occupies, which is the thing being pointed at.
 */
function step(el: Element): string {
  const cls = classFor(el);
  const simple = cls ? `.${cls}` : el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return simple;
  const kin = [...parent.children].filter((c) =>
    cls ? c.classList.contains(cls) : c.tagName === el.tagName,
  );
  if (kin.length === 1) return simple;
  return `${simple}:nth-child(${[...parent.children].indexOf(el) + 1})`;
}

/**
 * A selector for this element, scoped to the screen it is on.
 *
 * Returns null for anything outside the routed content — the top bar and the
 * sidebar are the same on every screen, and an edit made to them from one
 * page would follow you around the app without saying so.
 */
export function selectorFor(el: Element): string | null {
  const root = el.closest(`[${ROOT_ATTR}]`) as HTMLElement | null;
  if (!root || root === el) return null;

  const route = root.getAttribute(ROOT_ATTR);
  if (!route) return null;

  const parts: string[] = [];
  let node: Element | null = el;
  // A depth stop: past about eight steps the selector is longer than it is
  // useful, and the extra precision is spent on wrappers nobody named.
  while (node && node !== root && parts.length < 8) {
    parts.unshift(step(node));
    node = node.parentElement;
  }
  if (!parts.length) return null;

  const scope = `[${ROOT_ATTR}="${route}"]`;

  /*
    The shortest tail that still picks out this element and nothing else.

    The full path names every wrapper between here and the page root, which
    is both unreadable — nobody recognises `div > div:nth-child(2) > div` as
    their card — and brittle, since any layout div added above it breaks the
    chain. The last step or two is usually enough, and it survives the
    kind of change that would otherwise invalidate the rule.
  */
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = `${scope} ${parts.slice(i).join(' ')}`;
    const found = document.querySelectorAll(candidate);
    if (found.length === 1 && found[0] === el) return candidate;
  }
  return `${scope} ${parts.join(' > ')}`;
}

/**
 * A selector for everything of this KIND, anywhere in the application.
 *
 * `selectorFor` names one element on one screen — "the second card in the
 * first panel of /g-ops/leads/cmu929…". That is right for nudging one box and
 * useless for styling, because the next lead has a different id, so a new
 * record would inherit nothing. This names the class instead: every card
 * heading, every metric card, on every screen and every record that exists
 * now or is created later.
 *
 * Scoped to `[data-route]` — the routed page body — so a rule can never reach
 * the top bar, the sidebar, or the editor's own controls.
 */
export function globalSelectorFor(el: Element): string | null {
  const cls = classFor(el);
  if (cls) return `[data-route] .${cls}`;

  /*
    No class of its own — which is most of a form. A field's label, its input,
    a heading inside a dialog: all bare tags, and all things somebody
    reasonably wants to restyle everywhere at once. Naming the nearest
    ancestor that DOES have a class gives `.field label`, which is every field
    label in the application and is what was meant.
  */
  const path: string[] = [el.tagName.toLowerCase()];
  let node: Element | null = el.parentElement;
  while (node && path.length < 4) {
    const parentClass = classFor(node);
    if (parentClass) return `[data-route] .${parentClass} ${path.join(' ')}`;
    path.unshift(node.tagName.toLowerCase());
    node = node.parentElement;
  }
  return null;
}

/** How many elements a selector would style on the page as it stands. */
export function countMatches(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/** Whether a selector still finds exactly the element it was written for. */
export function matchesUniquely(selector: string, el: Element): boolean {
  try {
    const found = document.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Tags that mean something on their own, whatever classes they carry. */
const SEMANTIC = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'button', 'a', 'table', 'img', 'ul', 'ol',
  'section', 'header', 'main', 'nav', 'form', 'label',
  // Form controls. A click on an input used to climb past it to the field
  // wrapper, so the box itself could never be picked up or resized — which is
  // the one part of a form somebody actually wants to make wider.
  'input', 'select', 'textarea',
]);

/**
 * Whether this element is worth handing somebody as a selection.
 *
 * A layout is full of wrappers that exist only to hold a flex direction. They
 * can be named and moved, and doing so is almost never what was meant — the
 * click that landed on one was aimed at the card it is inside, or at nothing
 * at all. So a pick climbs past them to something with a name: a card, a
 * heading, a button, a panel.
 */
export function isNameable(el: Element): boolean {
  return classFor(el) !== null || SEMANTIC.has(el.tagName.toLowerCase());
}

/** A short, readable name for the inspector — "Card", "Heading", "Button". */
export function describe(el: Element): string {
  const cls = classFor(el);
  const names: Record<string, string> = {
    'kpi-card': 'Metric card',
    'panel-block': 'Panel',
    card: 'Card',
    'page-head': 'Page header',
    'card-title': 'Card heading',
    'panel-blurb': 'Panel description',
    'token-row': 'Setting row',
    'data-table': 'Table',
    'record-head': 'Record header',
    'bar-row': 'Chart row',
    btn: 'Button',
    badge: 'Badge',
  };
  if (cls && names[cls]) return names[cls];
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'Heading';
  if (tag === 'p') return 'Paragraph';
  if (tag === 'button') return 'Button';
  if (tag === 'a') return 'Link';
  if (tag === 'table') return 'Table';
  if (tag === 'img') return 'Image';
  return cls ? cls.replace(/-/g, ' ') : tag;
}
