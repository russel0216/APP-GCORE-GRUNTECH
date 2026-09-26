/**
 * The icon set.
 *
 * Hand-drawn inline SVG, for the same reason there is no UI framework: an icon
 * package is a dependency, a build step and several hundred glyphs to ship so
 * that fourteen can be used. These fourteen are the ones the app actually
 * needs; add another when a screen needs it, not before.
 *
 * All on a 24×24 grid, stroked rather than filled, 1.75 units wide, with round
 * caps and joins. Stroke takes `currentColor`, so an icon is coloured by
 * whatever it sits inside and never carries a colour of its own.
 *
 * Decorative by default: `aria-hidden`, because these sit beside a label that
 * already says the thing. Pass a `title` only for an icon that is the ONLY
 * indication of something, and it becomes a labelled `img` instead.
 */

export type IconName =
  | 'money-in'
  | 'money-out'
  | 'people'
  | 'balance'
  | 'clock'
  | 'check'
  | 'document'
  | 'cart'
  | 'invoice'
  | 'box'
  | 'calendar'
  | 'alert'
  | 'chart'
  | 'wrench'
  | 'grid'
  | 'tag'
  | 'gear'
  | 'shield'
  | 'layers'
  | 'truck'
  | 'image'
  | 'book'
  | 'panel';

/** Path data only — the wrapper supplies the canvas and the stroke. */
const PATHS: Record<IconName, string> = {
  // An arrow landing in a tray: money coming to us.
  'money-in': 'M12 3v10m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  // The same arrow leaving.
  'money-out': 'M12 13V3m0 0 4 4m-4-4L8 7M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  people: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6m8 12v-1a4 4 0 0 0-3-3.87M15 7.13a4 4 0 0 1 0 7.75',
  balance: 'M12 4v16M7 8h10M5 8l-2.5 6h5zM19 8l-2.5 6h5zM8 20h8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18m0-14v5l3 2',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18m-3.5-9 2.5 2.5 4.5-5',
  document: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5M9 13h6m-6 4h4',
  cart: 'M3 4h2l2.4 10.4A2 2 0 0 0 9.3 16h7.6a2 2 0 0 0 2-1.6L20 7H6m4 12.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0m8 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
  invoice: 'M6 3v18l2-1.5L10 21l2-1.5L14 21l2-1.5L18 21V3l-2 1.5L14 3l-2 1.5L10 3 8 4.5zM9 8h6M9 12h6M9 16h3',
  box: 'M21 8.5v7a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 15.5v-7a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8.5M3.5 7.5 12 12m0 0 8.5-4.5M12 12v9.5',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m3-2v4m8-4v4M4 10h16',
  alert: 'M12 9v4m0 3.5v.5M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  chart: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  wrench: 'M15.7 7.3a3.5 3.5 0 0 0 4.6 4.6l-8.6 8.6a2.3 2.3 0 0 1-3.2-3.2zM15.7 7.3 13 4.6m0 0a3.5 3.5 0 0 0-4.6-4.6',
  grid: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z',
  tag: 'M3 11V4a1 1 0 0 1 1-1h7l9 9-8 8zM7.5 7.5h.01',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6m7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2-1.2L14.6 3H9.4L9 5.7a7.5 7.5 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2 1.2l.4 2.7h5.2l.4-2.7a7.5 7.5 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3 8.2-7.5 9.5-4.5-1.3-7.5-5-7.5-9.5V6zM9 12l2 2 4-4',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 18l9 5 9-5',
  truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7zM7.5 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m12 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
  // A framed picture: the mountain and the sun, which is the one shape
  // everybody reads as "image" without a label.
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m0 11 4.5-4.5 3 3L15 11l5 5M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
  panel: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m6 0v14',
  // An open book: two pages meeting at the spine, for the Academy.
  book: 'M12 7c-1.5-1.5-4-2-9-2v13c5 0 7.5.5 9 2m0-13c1.5-1.5 4-2 9-2v13c-5 0-7.5.5-9 2m0-13v13',
};

/**
 * Which icon stands for a menu section.
 *
 * Keyed on the section names the registry declares. This map lives here rather
 * than in the registry because an icon is presentation, the same as a colour —
 * the registry decides what the menu IS and who may see it, and nothing about
 * how it looks. A section with no entry falls back to a neutral panel glyph, so
 * adding a section to the registry can never break the sidebar.
 */
const SECTION_ICONS: Record<string, IconName> = {
  Overview: 'grid',
  Sales: 'tag',
  Project: 'truck',
  Aftermarket: 'wrench',
  'Service reports': 'document',
  'My day': 'clock',
  Records: 'layers',
  Administration: 'gear',
  'Money in': 'money-in',
  'Money out': 'money-out',
  Analysis: 'chart',
  Procurement: 'cart',
  Warehouse: 'box',
  'Master data': 'layers',
  People: 'people',
  Academy: 'book',
  Process: 'check',
  Configuration: 'gear',
};

export function sectionIcon(name: string | null | undefined): IconName {
  return (name && SECTION_ICONS[name]) || 'panel';
}

export function Icon({
  name,
  size = 18,
  title,
  className,
}: {
  name: IconName;
  size?: number;
  /** Supply ONLY when the icon is the sole indication of something. */
  title?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The icon in its tinted disc, as on a KPI card or a list row.
 *
 * The disc takes its colour from the accent it is given, at low alpha — the
 * reference dashboards use a solid pastel fill, which does not survive a black
 * background. A ring at 30% over a wash at 12% reads the same way on dark.
 */
export function IconBadge({
  name,
  accent = 'neon',
  size = 36,
}: {
  name: IconName;
  accent?: 'neon' | 'magenta' | 'ok' | 'warn' | 'danger' | 'info' | 'quiet';
  size?: number;
}) {
  return (
    <span className={`icon-badge ${accent}`} style={{ width: size, height: size }}>
      <Icon name={name} size={Math.round(size * 0.52)} />
    </span>
  );
}
