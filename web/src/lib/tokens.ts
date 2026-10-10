/**
 * The catalogue of what the Appearance screen may change.
 *
 * Deliberately a list, not "every custom property we can find". A token here
 * is one somebody might reasonably want to move; the derived ones (shadows,
 * the focus ring, the rgb triples) follow from these, and exposing them would
 * only be a way to make the app inconsistent with itself.
 *
 * No defaults are written down. The screen reads them off the live stylesheet
 * instead, so this file cannot drift out of step with styles.css — which it
 * certainly would, because the two get edited months apart.
 */

export type TokenKind = 'length' | 'colour' | 'font' | 'text';

/** Which block an override is written into — see `appearanceCss`. */
export type Scope = 'tokens' | 'dark' | 'day';

export interface TokenDef {
  /** Property name without the leading `--`. */
  name: string;
  label: string;
  kind: TokenKind;
  hint?: string;
  /** Slider bounds, for the lengths where dragging one makes sense. */
  min?: number;
  max?: number;
}

export interface TokenGroup {
  key: string;
  title: string;
  blurb: string;
  scope: Scope | 'theme';
  tokens: TokenDef[];
}

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    key: 'layout',
    title: 'Layout & size',
    blurb:
      'The frame every screen is drawn in. These were fixed numbers scattered through the stylesheet until this screen needed them.',
    scope: 'tokens',
    tokens: [
      {
        name: 'topbar-h',
        label: 'Top bar height',
        kind: 'length',
        min: 40,
        max: 96,
        hint: 'Everything sticky measures itself against this',
      },
      { name: 'topbar-pad', label: 'Top bar side padding', kind: 'length', min: 0, max: 48 },
      {
        name: 'sidebar-sections-w',
        label: 'Sidebar width',
        kind: 'length',
        min: 140,
        max: 380,
        hint: 'Every module whose menu is grouped into sections — which is all of them but Insights',
      },
      {
        name: 'sidebar-w',
        label: 'Sidebar width, ungrouped menu',
        kind: 'length',
        min: 160,
        max: 380,
        hint: 'Insights, whose menu is a flat list and gets a little more room',
      },
      { name: 'rail-w', label: 'Collapsed sidebar width', kind: 'length', min: 44, max: 120 },
      { name: 'content-pad-y', label: 'Page padding, top and bottom', kind: 'length', min: 0, max: 64 },
      { name: 'content-pad-x', label: 'Page padding, sides', kind: 'length', min: 0, max: 80 },
      { name: 'card-pad-y', label: 'Card padding, top and bottom', kind: 'length', min: 0, max: 48 },
      { name: 'block-gap', label: 'Space between cards', kind: 'length', min: 0, max: 48 },
      { name: 'card-pad-x', label: 'Card padding, sides', kind: 'length', min: 0, max: 48 },
      {
        name: 'page-head-basis',
        label: 'Page title minimum width',
        kind: 'text',
        hint: 'Below this the title stops sharing its row with the controls beside it, and they wrap',
      },
      { name: 'home-max-w', label: 'Launcher width', kind: 'length', min: 720, max: 1800 },
      {
        name: 'wordmark-h',
        label: 'Launcher wordmark height',
        kind: 'text',
        hint: 'A clamp: smallest, preferred, largest — it shrinks first on a short screen',
      },
    ],
  },
  {
    key: 'spacing',
    title: 'Spacing scale',
    blurb:
      'Every gap, margin and padding in the app is one of these eight steps. Changing one moves it everywhere at once, which is the point of them.',
    scope: 'tokens',
    tokens: [
      { name: 's-1', label: 'Step 1 — hairline', kind: 'length', min: 0, max: 16 },
      { name: 's-2', label: 'Step 2', kind: 'length', min: 0, max: 24 },
      { name: 's-3', label: 'Step 3', kind: 'length', min: 0, max: 32 },
      { name: 's-4', label: 'Step 4 — the common one', kind: 'length', min: 0, max: 40 },
      { name: 's-5', label: 'Step 5', kind: 'length', min: 0, max: 48 },
      { name: 's-6', label: 'Step 6', kind: 'length', min: 0, max: 56 },
      { name: 's-7', label: 'Step 7', kind: 'length', min: 0, max: 72 },
      { name: 's-8', label: 'Step 8 — widest', kind: 'length', min: 0, max: 96 },
    ],
  },
  {
    key: 'type',
    title: 'Text sizes',
    blurb:
      'Seven sizes, and every piece of text in the app uses one of them. Body text is "Base"; the smallest is what document numbers and timestamps are set in.',
    scope: 'tokens',
    tokens: [
      { name: 'fs-xs', label: 'Extra small — captions, timestamps', kind: 'length', min: 8, max: 20 },
      { name: 'fs-sm', label: 'Small', kind: 'length', min: 8, max: 22 },
      { name: 'fs-md', label: 'Medium — table text', kind: 'length', min: 9, max: 24 },
      { name: 'fs-base', label: 'Base — body text', kind: 'length', min: 10, max: 26 },
      { name: 'fs-lg', label: 'Large — card titles', kind: 'length', min: 11, max: 30 },
      { name: 'fs-xl', label: 'Extra large — page titles', kind: 'length', min: 13, max: 40 },
      { name: 'fs-2xl', label: 'Largest', kind: 'length', min: 15, max: 56 },
    ],
  },
  {
    key: 'fonts',
    title: 'Typefaces',
    blurb:
      'Three stacks. Keep a system fallback at the end of each — if the first name will not load, the app still has something to draw with.',
    scope: 'tokens',
    tokens: [
      { name: 'body', label: 'Body', kind: 'font', hint: 'Almost all text' },
      { name: 'display', label: 'Display', kind: 'font', hint: 'Headings and the wordmark' },
      {
        name: 'mono',
        label: 'Monospace',
        kind: 'font',
        hint: 'Document numbers, codes, amounts in tables',
      },
    ],
  },
  {
    key: 'shape',
    title: 'Corners',
    blurb: 'How rounded things are. Set all three to 0 for square corners throughout.',
    scope: 'tokens',
    tokens: [
      { name: 'radius-sm', label: 'Small — buttons, inputs, pills', kind: 'length', min: 0, max: 24 },
      { name: 'radius', label: 'Medium — cards', kind: 'length', min: 0, max: 32 },
      { name: 'radius-lg', label: 'Large — modals, panels', kind: 'length', min: 0, max: 40 },
    ],
  },
  {
    key: 'colour',
    title: 'Colour',
    blurb:
      'The launcher is dark and the screens behind the menu are daylight, so each keeps its own set. Pick which one you are editing.',
    scope: 'theme',
    tokens: [
      { name: 'bg', label: 'Page background', kind: 'colour' },
      {
        name: 'topbar-bg',
        label: 'Top bar background',
        kind: 'colour',
        hint: 'Slightly see-through by default so the page shows under it — the picker will make it solid',
      },
      { name: 'surface', label: 'Card background', kind: 'colour' },
      { name: 'surface-2', label: 'Raised background', kind: 'colour', hint: 'Buttons, table heads' },
      { name: 'surface-3', label: 'Highest background', kind: 'colour' },
      { name: 'line', label: 'Border', kind: 'colour' },
      { name: 'line-soft', label: 'Border, faint', kind: 'colour' },
      { name: 'text', label: 'Text', kind: 'colour' },
      { name: 'muted', label: 'Text, secondary', kind: 'colour' },
      {
        name: 'faint',
        label: 'Text, faintest',
        kind: 'colour',
        hint: 'Keep this above 4.5:1 against the card — it carries real information',
      },
      {
        name: 'neon',
        label: 'Accent',
        kind: 'colour',
        hint: 'Headings, links, the active menu item',
      },
      { name: 'magenta', label: 'Accent, secondary', kind: 'colour' },
      { name: 'ok', label: 'Good', kind: 'colour' },
      { name: 'warn', label: 'Warning', kind: 'colour' },
      { name: 'danger', label: 'Bad', kind: 'colour' },
      { name: 'info', label: 'Information', kind: 'colour' },
    ],
  },
];

/**
 * Colours that also exist as a space-separated triple, because tints are
 * written `rgb(var(--neon-rgb) / 0.12)`. Change one without the other and
 * every wash of that colour keeps the old hue — so the screen sets both.
 */
export const RGB_TWINS = new Set(['neon', 'magenta', 'danger', 'warn', 'info']);

/**
 * Tokens that are really the same decision as another one.
 *
 * `--neon-dim` is the accent again, a shade down, and it colours every card
 * title in the app. Left to itself it stayed the old colour while everything
 * around it changed, which reads as a bug rather than a choice — and on the
 * daylight theme the two are the same value anyway. Setting the accent sets
 * both; anyone who wants them genuinely different can say so in custom CSS.
 */
export const FOLLOWERS: Record<string, string[]> = {
  neon: ['neon-dim'],
};

/** `#39ff9d` becomes `57 255 157`. Null for anything that is not a plain hex. */
export function hexToTriple(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** `<input type="color">` only accepts `#rrggbb`; a computed value may be anything. */
export function toHexInput(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return (
      '#' +
      v
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')
    );
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (rgb) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
  }
  return '#000000';
}

/** Splits `16px` into its number and unit, or null when it is not that simple. */
export function splitLength(value: string): { n: number; unit: string } | null {
  const m = /^(-?[\d.]+)(px|rem|em|%|vh|vw)?$/.exec(value.trim());
  if (!m) return null;
  return { n: Number(m[1]), unit: m[2] ?? 'px' };
}
