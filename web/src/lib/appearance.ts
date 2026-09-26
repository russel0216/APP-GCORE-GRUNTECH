/**
 * Appearance — design token overrides, applied to the live document.
 *
 * G-Core's look is CSS custom properties in `styles.css`. This module holds
 * the OVERRIDES on top of them and writes them into a single `<style>`
 * element. Nothing here copies a default: an absent token means "whatever the
 * stylesheet says", so clearing one genuinely restores it and the defaults
 * keep living in the one file that owns them.
 *
 * Three buckets, because the app has two themes:
 *
 *   tokens  `:root`                      — spacing, type, layout, shape.
 *                                          Theme-independent, so one value.
 *   dark    `:root:not([data-theme=day])` — colour on the launcher.
 *   day     `[data-theme='day']`          — colour on the screens behind the menu.
 *
 * The `:not()` matters. `:root` and `[data-theme='day']` have equal
 * specificity, so a plain `:root` override wins on source order and would
 * repaint the daylight screens with the launcher's colours as a side effect
 * of changing one. Scoping the dark block to "not day" keeps each theme's
 * colours to itself.
 */

export interface Appearance {
  tokens: Record<string, string>;
  dark: Record<string, string>;
  day: Record<string, string>;
  /**
   * Per-element overrides from the layout editor, keyed by CSS selector.
   * This is how a drag survives: the gesture becomes a rule, not a change to
   * the DOM, because React owns the DOM and would paint over it on the next
   * render.
   */
  rules: Record<string, Record<string, string>>;
  /** Free-form CSS, appended last. The escape hatch. */
  css: string;
}

export const EMPTY_APPEARANCE: Appearance = {
  tokens: {},
  dark: {},
  day: {},
  rules: {},
  css: '',
};

const STYLE_ID = 'gcore-appearance';

/**
 * Cached so a reload paints the customised app immediately, instead of
 * showing the stock one for the half-second `/auth/me` takes to answer. The
 * server's copy replaces it as soon as that lands.
 */
const CACHE_KEY = 'gcore_appearance';

function asMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function asRules(v: unknown): Record<string, Record<string, string>> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [sel, decls] of Object.entries(v as Record<string, unknown>)) {
    const clean = asMap(decls);
    if (Object.keys(clean).length) out[sel] = clean;
  }
  return out;
}

export function normalise(value: unknown): Appearance {
  const raw = (value ?? {}) as Partial<Appearance>;
  return {
    tokens: asMap(raw.tokens),
    dark: asMap(raw.dark),
    day: asMap(raw.day),
    rules: asRules(raw.rules),
    css: typeof raw.css === 'string' ? raw.css : '',
  };
}

export function cachedAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? normalise(JSON.parse(raw)) : EMPTY_APPEARANCE;
  } catch {
    return EMPTY_APPEARANCE;
  }
}

function cache(appearance: Appearance): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(appearance));
  } catch {
    /* private mode — the app still works, it just repaints on each load */
  }
}

function block(selector: string, map: Record<string, string>): string {
  const lines = Object.entries(map)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `  --${k}: ${v.trim()};`);
  return lines.length ? `${selector} {\n${lines.join('\n')}\n}` : '';
}

/**
 * One element's rule, from the layout editor.
 *
 * Marked `!important` because these are corrections to a stylesheet that has
 * every right to be more specific than a generated selector. Without it a
 * dragged card would snap back the moment it happened to sit inside a rule
 * with two classes in it, which reads as the editor being broken rather than
 * as a specificity contest.
 */
function rule(selector: string, decls: Record<string, string>): string {
  const lines = Object.entries(decls)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `  ${k}: ${v.trim()} !important;`);
  return lines.length ? `${selector} {\n${lines.join('\n')}\n}` : '';
}

/** The stylesheet an appearance amounts to. */
export function appearanceCss(appearance: Appearance): string {
  return [
    block(':root', appearance.tokens),
    block(":root:not([data-theme='day'])", appearance.dark),
    block("[data-theme='day']", appearance.day),
    ...Object.entries(appearance.rules).map(([sel, decls]) => rule(sel, decls)),
    appearance.css.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** True when nothing is overridden — used to say so rather than showing an empty box. */
export function isEmpty(a: Appearance): boolean {
  return (
    !Object.keys(a.tokens).length &&
    !Object.keys(a.dark).length &&
    !Object.keys(a.day).length &&
    !Object.keys(a.rules).length &&
    !a.css.trim()
  );
}

/** Writes the appearance into the document, creating the style element once. */
export function applyAppearance(appearance: Appearance, { persist = true } = {}): void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = appearanceCss(appearance);
  if (persist) cache(appearance);
}

/**
 * What the stylesheet says a token is, with every override lifted off.
 *
 * Read from the live document rather than from a table of defaults, so this
 * cannot fall out of step with styles.css. The overrides go back immediately;
 * the browser coalesces the two writes, so nothing flickers.
 */
export function stylesheetDefaults(names: string[]): Record<string, string> {
  const el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  const saved = el?.textContent ?? '';
  if (el) el.textContent = '';
  const computed = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of names) out[n] = computed.getPropertyValue(`--${n}`).trim();
  if (el) el.textContent = saved;
  return out;
}
