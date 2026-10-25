/**
 * Reading Odoo's product export (2026-10-25, the owner's migration: "I'm
 * migrating this data of inventory from Odoo so that the inventory will
 * reflect in G-CORE"). Pure — no database — so verify-chain pins every rule
 * here against rows written as Odoo writes them.
 *
 * The export is Odoo's product list as it comes: Name, Internal Reference,
 * Responsible, Sales Price, Cost, Product Category, Product Type, Quantity On
 * Hand, Forecasted Quantity, Unit. In Gruntech's Odoo the two main fields are
 * used the other way round: **Name is the code** ("OOP - 213.53-E
 * 100PSI/0-7BAR", a category prefix and the part number) and **Internal
 * Reference is the description**, usually starting with the brand ("WIKA,
 * BOURDON TUBE PRESSURE GAUGE …"). The owner's answers:
 *
 *   1. one warehouse, at the main office;
 *   2. vehicles, office assets and every tools category go to G-HR › Asset
 *      Management, never inventory;
 *   3. every product comes in as an item, stocked or not;
 *   4. the product group is G-CORE's own eight, and the valuation is read by
 *      BRAND too — "Trading" for an item that declares none;
 *   5. rows sharing a Name are merged;
 *   6. a stocked item with no cost comes in at 0;
 *   7. the unit is pcs;
 *   8. no reorder levels.
 */

/** The column headers of Odoo's product export, as it writes them. */
export const ODOO_HEADERS = {
  name: 'Name',
  reference: 'Internal Reference',
  responsible: 'Responsible',
  price: 'Sales Price',
  cost: 'Cost',
  category: 'Product Category',
  type: 'Product Type',
  onHand: 'Quantity On Hand',
  forecast: 'Forecasted Quantity',
  unit: 'Unit',
} as const;

/** What a stocked item with no brand reads as in the valuation (the owner's word). */
export const NO_BRAND_LABEL = 'Trading';

/** One text, trimmed and single-spaced. */
export function tidy(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, ' ').trim();
}

/** The key rows are merged by: the Name, case- and space-blind. */
export function odooKey(name: string): string {
  return tidy(name).toUpperCase();
}

/** A figure as Odoo (or Excel) wrote it: "1,500,000.00", "3080", "" → 0. */
export function odooNumber(v: string | null | undefined): number {
  const s = tidy(v).replace(/,/g, '');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
  return n;
}

// ── Assets and tools: G-HR, never inventory ──────────────────────────────────

export interface AssetCategory {
  /** The employee the category names ("Jhay-r Catuday Tools" → "Jhay-r Catuday"), else null. */
  holder: string | null;
  /** "(Resigned)" — never issued to them; HR confirms where it went. */
  resigned: boolean;
  /** Where it is when the category says (a site, "C/O" aside). */
  site: string | null;
  /** The company's own tools or property, issued to nobody. */
  kind: 'vehicle' | 'office' | 'site' | 'tools';
}

/** Company property kept in Odoo as a product category. */
const PROPERTY_CATEGORIES: Record<string, AssetCategory['kind']> = {
  'ASSET VEHICLE': 'vehicle',
  'ASSET - OFFICE EQUIPMENT': 'office',
  'ASSET - OFFICE FURNITURE & FIXTURES': 'office',
  'ASSET - LAGUNA OFFICE': 'office',
  'ASSET - GN POWER': 'site',
  'OSMAK ASSET': 'site',
  'SHOP TOOLS': 'tools',
  'SERVICE TOOLS': 'tools',
  'OFFICE TOOLS': 'tools',
  'WAREHOUSE TOOLS': 'tools',
};

/** A category holding one person's tools under their name alone ("Jonel pada"). */
const PERSON_CATEGORIES = new Set(['JONEL PADA']);

/**
 * Is this Odoo category company property or somebody's tools — G-HR's — and
 * whose? Null for a product category.
 */
export function assetCategory(category: string | null | undefined): AssetCategory | null {
  const raw = tidy(category);
  if (!raw) return null;
  const up = raw.toUpperCase();
  const parens = [...raw.matchAll(/\(([^)]*)\)/g)].map((m) => tidy(m[1]));
  const resigned = parens.some((p) => /^resigned$/i.test(p));
  const careOf = parens.map((p) => /^c\/o\s+(.+)$/i.exec(p)?.[1]).find(Boolean) ?? null;
  const site = parens.filter((p) => !/^resigned$/i.test(p) && !/^c\/o\s/i.test(p)).join(', ') || null;
  const bare = tidy(raw.replace(/\([^)]*\)/g, ' '));

  const kind = PROPERTY_CATEGORIES[up];
  if (kind) return { holder: null, resigned: false, site: kind === 'site' ? tidy(bare.replace(/^asset\s*-\s*/i, '').replace(/\basset\b/i, '')) || null : null, kind };
  if (/^asset\b/i.test(raw)) return { holder: null, resigned: false, site: null, kind: 'office' };
  // "Office Maintenance Tools (C/O Jeric)": the company's, in someone's care.
  if (careOf) return { holder: tidy(careOf), resigned, site, kind: 'tools' };
  if (/\btools?$/i.test(bare)) {
    const holder = tidy(bare.replace(/\btools?$/i, ''));
    return { holder: holder || null, resigned, site, kind: 'tools' };
  }
  if (PERSON_CATEGORIES.has(up)) return { holder: raw, resigned, site, kind: 'tools' };
  return null;
}

/** Odoo's own placeholder rows ("INVENTORY 1" under "Template") — not products. */
export function isTemplateCategory(category: string | null | undefined): boolean {
  return tidy(category).toUpperCase() === 'TEMPLATE';
}

/** The asset type an asset row takes — names from `ASSET_TYPES` in shared/assets.ts. */
export function odooAssetType(category: AssetCategory, text: string): string {
  const t = ` ${text.toUpperCase()} `;
  if (category.kind === 'vehicle') return 'Company Vehicle';
  if (/\b(LAPTOP|NOTEBOOK|MACBOOK)\b/.test(t)) return 'Office Laptop';
  if (/\b(PHONE|IPHONE|CELLPHONE|MOBILE|SMARTPHONE)\b/.test(t)) return 'Mobile Phone';
  if (category.kind === 'tools') {
    if (/\b(DRILL|GRINDER|CORDLESS|IMPACT|SAW|METER|TESTER|MEGGER|WELDING|ROTARY|HAMMER DRILL|CLAMP METER|MULTIMETER|INVERTER)\b/.test(t)) {
      return 'Power Tools / Testing';
    }
    return 'Safety Gear & Tool Kit';
  }
  return 'Other';
}

/** A vehicle's plate from its name: "2016 Mazda 2 (NDW 8142)", "2014 Mazda CX-5 AAO1742". */
export function plateFrom(text: string): string | null {
  const m = /\b([A-Z]{3})\s?(\d{3,4})\b/.exec(text.toUpperCase());
  return m ? `${m[1]} ${m[2]}` : null;
}

// ── Product groups: G-CORE's eight ───────────────────────────────────────────

/** The owner's eight inventory categories (the seed's INVENTORY_CATEGORIES), by code. */
export const GROUP_CODES = ['PMP', 'CTL', 'INS', 'PRT', 'CNS', 'FLT', 'DRY', 'PIP'] as const;
export type GroupCode = (typeof GROUP_CODES)[number];

/** An Odoo category that says what the product is. */
const CATEGORY_GROUP: Record<string, GroupCode> = {
  'SCHNEIDER PRODUCTS AND VFD': 'CTL',
  'NIDEC CONTROL TECHNIQUE': 'CTL',
  SIEMENS: 'CTL',
  'PANEL ASSEMBLED & FABRICATION': 'CTL',
  'PREVOST AND FITTINGS': 'PIP',
  'GEORG FISCHER': 'PIP',
  'COVNA VALVE': 'PIP',
  'PUMPS, PUMP PARTS AND MOTOR': 'PMP',
  WILO: 'PMP',
  'KSB PUMPS': 'PMP',
  'LIGAO PUMPS': 'PMP',
  'SAER PUMPS': 'PMP',
  'DOMNICK HUNTER COMPRESSED AIR PARTS': 'FLT',
  'SULLAIR COMPRESSOR PARTS & OTHER COMPRESSOR PARTS': 'PRT',
  'SUTO PRODUCTS, OTHER INSTRUMENTS': 'INS',
  HORIBA: 'INS',
  'LEIPOLE PRODUCT': 'INS',
  'SURE PURITY': 'DRY',
  CONSUMABLES: 'CNS',
  'OFFICE CONSUMABLE': 'CNS',
  'MARKETING MATERIALS': 'CNS',
};

/** Omega's Odoo prefixes: filters, dryers, compressors, else parts. */
const OMEGA_PREFIX: Record<string, GroupCode> = {
  OFE: 'FLT',
  OFH: 'FLT',
  OAE: 'FLT',
  OWS: 'FLT',
  OCS: 'FLT',
  OAD: 'DRY',
  ODD: 'DRY',
  ACP: 'PMP',
};

/**
 * What a product is, read off its words — for the categories that say
 * nothing ("Other Product & Product for project", "Trading", a demo unit).
 * First match wins; nothing matched is Parts & Hardware.
 */
const WORD_GROUPS: [RegExp, GroupCode][] = [
  [/\bDRYERS?\b/, 'DRY'],
  [/\b(FILTERS?|ELEMENTS?|SEPARATORS?|STRAINERS?)\b/, 'FLT'],
  [/\b(PUMPS?|MOTORS?|COMPRESSORS?|BLOWERS?)\b/, 'PMP'],
  [/\b(GAUGES?|METERS?|SENSORS?|TRANSMITTERS?|ANALY[SZ]ERS?|THERMOMETERS?|FLOWMETERS?|INSTRUMENTS?|LOGGERS?|DETECTORS?)\b/, 'INS'],
  [/\b(BREAKERS?|CONTACTORS?|RELAYS?|VFD|INVERTERS?|DRIVES?|PANELS?|ENCLOSURES?|CABLES?|WIRES?|TERMINALS?|LUGS|SWITCH(ES)?|PLC|HMI|TRANSFORMERS?|FUSES?|CONDUITS?|STARTERS?|BREAKER)\b/, 'CTL'],
  [/\b(VALVES?|PIPES?|ELBOWS?|FLANGES?|TEES?|COUPLINGS?|REDUCERS?|FITTINGS?|NIPPLES?|UNIONS?|HOSES?|GASKETS?|BUSHINGS?)\b/, 'PIP'],
  [/\b(TAPES?|OILS?|GREASE|LUBRICANTS?|DESICCANTS?|PAINTS?|SEALANTS?|SOLVENTS?|ELECTRODES?|RAGS?|BROCHURES?|FLYERS?|TARPAULINS?|STICKERS?|UNIFORMS?|SHIRTS?)\b/, 'CNS'],
];

export function odooGroup(category: string | null | undefined, name: string, reference: string): GroupCode {
  const cat = tidy(category).toUpperCase();
  if (cat === 'OMEGA') {
    const prefix = /^([A-Z]{2,5})\s*-/.exec(tidy(name).toUpperCase())?.[1];
    return (prefix && OMEGA_PREFIX[prefix]) || 'PRT';
  }
  const fixed = CATEGORY_GROUP[cat];
  if (fixed) return fixed;
  const words = ` ${tidy(reference)} ${tidy(name)} `.toUpperCase();
  for (const [re, code] of WORD_GROUPS) if (re.test(words)) return code;
  return 'PRT';
}

// ── Brands ───────────────────────────────────────────────────────────────────

/**
 * The brands the export names, each spelling → the one brand. Read off the
 * first words of Internal Reference ("SCHNEIDER ELECTRIC, …"); a misspelt or
 * shortened brand ("SCHNDEIDER ELECTRIC", "SUTO", "GF") is folded into its
 * brand, and a description that starts with a thing rather than a maker
 * ("STAINLESS STEEL", "GI", "TERMINAL LUGS") is not on the list.
 */
const BRAND_SPELLINGS: Record<string, string[]> = {
  'SCHNEIDER ELECTRIC': ['SCHNEIDER', 'SCHNDEIDER ELECTRIC', 'SCHNEDIER ELECTRIC', 'SCHNEIDER ELETRIC', 'SCHNIEDER ELECTRIC'],
  'OMEGA AIR': ['OMEGA'],
  'MEGA AIR': [],
  PREVOST: [],
  TESCOP: [],
  'GEORG FISCHER': ['GEORGE FISCHER', 'GEORG FISHER', 'GF', 'FISCHER'],
  'PHELPS DODGE': [],
  KSB: ['KSB PUMPS'],
  'CONTROL TECHNIQUES': ['CONTROL TECHNIQUE'],
  NIDEC: [],
  'SUTO-ITEC': ['SUTO', 'SUTO ITEC', 'SUTO - ITEC', 'SUTO -ITEC', 'SUTO- ITEC'],
  WILO: [],
  GRUNDFOS: [],
  SULLAIR: [],
  LIGAO: ['LIGAO PUMPS', 'LIGAO PUMP'],
  STANLEY: [],
  MCGILL: [],
  'DOMNICK HUNTER': [],
  EIFEL: [],
  SIEMENS: [],
  COVNA: [],
  HELIOS: [],
  ORIVAL: [],
  LOTUS: [],
  SHIRTGUY: [],
  SHIELDCON: [],
  AMCAREMED: [],
  SMITH: ['SMITH USA'],
  WEG: [],
  INGCO: [],
  BAUER: ['BAUER COMPRESSOR'],
  LEIPOLE: [],
  CNP: [],
  ERA: [],
  CBMTEC: ['CMBTEC'],
  GIBSON: [],
  SAER: ['SAER PUMP'],
  HORIBA: [],
  TECOFI: [],
  'SURE PURITY': [],
  PARKER: [],
  OMNI: [],
  OPTIBELT: [],
  'JOHN DEERE': ['JHON DEERE'],
  WOODWELL: [],
  DAEJIN: [],
  MASTRA: [],
  JAINSON: [],
  WIKA: [],
  MAKITA: [],
  KSS: [],
  RUSTECH: [],
  IRWIN: ['IRWIN MARPLES'],
  COMPAIR: [],
  TIBOX: [],
  UNIQLO: [],
  'FRANKLIN ELECTRIC': ['FRANKLIN'],
  ACER: [],
  BELDEN: [],
  GENDIESEL: [],
  SPEARS: [],
  ATLANTA: [],
  ARMAK: [],
  'SPEC-MASTER': [],
  COBALT: [],
  OMRON: [],
  NIHONWELD: [],
  EMERALD: [],
  BOSCH: [],
  HAILAN: [],
  DURAFLEX: [],
  BOYSEN: [],
  PHILFLEX: [],
  PANASONIC: [],
  GOULDS: [],
  DEWALT: [],
  DUWELL: [],
  FLUKE: [],
  LENOVO: [],
  'PHOENIX CONTACT': [],
  'RS PRO': [],
  ABB: [],
  VECAS: [],
  'BLUE EAGLE': [],
  NICHI: [],
  MITSUBISHI: [],
  NUTORK: [],
  'ATLAS COPCO': [],
  EASYFLOW: [],
  KETER: [],
  SENTRY: [],
  RIDGID: [],
  MIKROPOR: [],
  MONTRELEC: [],
  MERSEN: [],
  KITZ: [],
  CLARKE: [],
  CALY: [],
  'ITC ANDELI': ['ANDELI'],
  INCA: [],
  ELECTROWELD: [],
  BLOX: [],
  SUNRISE: [],
  JUILONG: [],
  SMARTUBE: [],
  'CARLO GAVAZZI': ['CARLOO GAVZZI'],
  SUPERTUFF: [],
  'POWER CRAFT': ['POWERCRAFT'],
  'ELMO RIETSCHLE': [],
  PANTHER: [],
  TELEMECANIQUE: [],
  POWERHOUSE: [],
  'EXXON MOBIL': [],
  MAZAKI: [],
  LUTRON: [],
  TRUPER: [],
  HILLS: [],
  'MR DIY': [],
  MAXSELL: [],
  YAMATO: [],
  ASUS: [],
  YANTAI: [],
  WESS: [],
  HMS: [],
  APOLLO: [],
  AQMATIC: [],
  DANFOSS: [],
  AMETEK: [],
  GULF: [],
  'GARDNER DENVER': [],
  'WELD-ON': [],
  WEBER: [],
  SAKURA: [],
  PROMINENT: [],
  COMMEX: [],
  'CLAYTON MARK': [],
  'ORION WIRE': [],
  BROTHER: [],
  GUILDER: [],
  DAB: [],
  EUROBOARD: [],
  ORIENTCRAFT: [],
  GRUNTECH: [],
  '3M': [],
  'BLACK+DECKER': [],
  HILTI: [],
  HONEYWELL: [],
  INESIS: [],
  ARMAFLEX: [],
  LONA: [],
  PANDUIT: [],
  MEIKO: [],
  CHAMP: [],
  CROWN: [],
  ANDEROL: [],
  FILTRAFINE: [],
  RITHERM: [],
  PEMKO: [],
  MOLDEX: [],
  SIKA: [],
  LAZARUS: [],
  SMC: [],
  TYROLIT: [],
  'WD-40': [],
  ROYU: ['ROYU BRAND'],
  SENSUS: [],
  'AQUA TEDELA': [],
  DAIDEN: [],
  EJET: [],
  SYSTRONICS: [],
  GREENFIELD: [],
  'SK-S': [],
  TORPEDO: [],
  'AQUA FLOW': [],
  'BEST GUARD USA': [],
};

const SPELLING: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [brand, spellings] of Object.entries(BRAND_SPELLINGS)) {
    m.set(brand, brand);
    for (const s of spellings) m.set(s, brand);
  }
  return m;
})();
/** Longest spelling first, so "SCHNEIDER ELECTRIC" wins over "SCHNEIDER". */
const SPELLINGS_BY_LENGTH = [...SPELLING.keys()].sort((a, b) => b.length - a.length);

/** A product category that names the maker of everything in it. */
const CATEGORY_BRAND: Record<string, string> = {
  OMEGA: 'OMEGA AIR',
  'GEORG FISCHER': 'GEORG FISCHER',
  'NIDEC CONTROL TECHNIQUE': 'CONTROL TECHNIQUES',
  'DOMNICK HUNTER COMPRESSED AIR PARTS': 'DOMNICK HUNTER',
  WILO: 'WILO',
  'KSB PUMPS': 'KSB',
  'LIGAO PUMPS': 'LIGAO',
  'COVNA VALVE': 'COVNA',
  'SAER PUMPS': 'SAER',
  SIEMENS: 'SIEMENS',
  'SUTO PRODUCTS, OTHER INSTRUMENTS': 'SUTO-ITEC',
  HORIBA: 'HORIBA',
  'LEIPOLE PRODUCT': 'LEIPOLE',
  'SURE PURITY': 'SURE PURITY',
};

/**
 * The brand a product declares: the maker at the start of its description
 * (a listed spelling, followed by a comma, a full stop, a dash, a space or
 * nothing), else its Odoo category's maker, else none — which the valuation
 * reads as Trading.
 */
export function odooBrand(reference: string, name: string, category: string | null | undefined): string | null {
  for (const text of [tidy(reference), tidy(name).replace(/^[A-Z]{2,5}\s*-\s*/, '')]) {
    const up = text.toUpperCase();
    if (!up) continue;
    for (const s of SPELLINGS_BY_LENGTH) {
      if (up === s || (up.startsWith(s) && /^[\s,.:;\-–(/]/.test(up.slice(s.length)))) return SPELLING.get(s)!;
    }
  }
  return CATEGORY_BRAND[tidy(category).toUpperCase()] ?? null;
}

// ── One item out of the rows that share a Name ───────────────────────────────

export interface OdooItem {
  key: string;
  /** Odoo's Name, kept whole as the part number — what the team searches by. */
  partNumber: string;
  name: string;
  brand: string | null;
  group: GroupCode;
  /** The Odoo category, kept on the item's notes. */
  odooCategory: string | null;
  /** On hand, the rows added up; a negative row counts as 0. */
  quantity: number;
  /** Pesos a unit, to the centavo: the stocked rows' weighted average, else the highest cost given. */
  unitCost: number;
  /** Rows merged into this one (1 when it stood alone). */
  rows: number;
  negativeRows: number;
}

export interface OdooRow {
  name: string;
  reference: string;
  category: string | null;
  cost: number;
  onHand: number;
}

export function readOdooRow(row: Record<string, string>): OdooRow {
  return {
    name: tidy(row[ODOO_HEADERS.name]),
    reference: tidy(row[ODOO_HEADERS.reference]),
    category: tidy(row[ODOO_HEADERS.category]) || null,
    cost: odooNumber(row[ODOO_HEADERS.cost]),
    onHand: odooNumber(row[ODOO_HEADERS.onHand]),
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;
const qty3 = (n: number) => Math.round(n * 1000) / 1000;

/** The rows sharing one Name (the owner's call: "merge them"), as one item. */
export function mergeOdooRows(rows: OdooRow[]): OdooItem {
  const first = rows[0];
  const reference = rows.map((r) => r.reference).find(Boolean) ?? '';
  const category = rows.map((r) => r.category).find(Boolean) ?? null;
  const stocked = rows.filter((r) => r.onHand > 0);
  const quantity = qty3(stocked.reduce((s, r) => s + r.onHand, 0));
  const unitCost = quantity > 0 ? cents(stocked.reduce((s, r) => s + r.onHand * r.cost, 0) / quantity) : cents(Math.max(0, ...rows.map((r) => r.cost)));
  return {
    key: odooKey(first.name),
    partNumber: first.name,
    name: reference || first.name,
    brand: odooBrand(reference, first.name, category),
    group: odooGroup(category, first.name, reference),
    odooCategory: category,
    quantity,
    unitCost,
    rows: rows.length,
    negativeRows: rows.filter((r) => r.onHand < 0).length,
  };
}

/**
 * Odoo's tools categories name their holders by nickname (2026-10-25, the
 * owner's call: "add Rj Tagalog and the other unmatched holders' names").
 * Each Odoo spelling is read as the full name on the organisation chart; a
 * holder with no employee record yet (Jayson Duan, Jc de Leon Tugay,
 * Ramonito Rexcis) stays unmatched until HR adds one — the import run again
 * then issues what it left Available. Keys are `flat`, values full names.
 */
export const HOLDER_ALIASES: Record<string, string> = {
  rjtagalog: 'Rolando Tagalog',
  jhayrcatuday: 'Rodrigo Catuday',
  bhadzugaban: 'Salvador Ugaban',
  bhongcayuto: 'Reagan Cajoto',
  johnrussel: 'Jhon Russel Balicas',
};

/**
 * Who the category names, among the active employees: an alias's full name
 * (`HOLDER_ALIASES`) first, then first and last name
 * equal (case-, space- and punctuation-blind), else the one employee whose
 * last name is the holder's last word and whose first name starts as the
 * holder's first word does ("Ric Martinez" → Ricardo Martinez), else the
 * one employee whose first name alone it is ("Jeric"). Never a guess between
 * two: null.
 */
export function matchHolder<T extends { firstName: string; lastName: string }>(holder: string, people: T[]): T | null {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const alias = HOLDER_ALIASES[flat(holder)];
  if (alias) holder = alias;
  const words = tidy(holder).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return null;
  const whole = flat(holder);
  const one = (list: T[]) => (list.length === 1 ? list[0] : null);
  const exact = people.filter((p) => flat(`${p.firstName}${p.lastName}`) === whole);
  if (exact.length) return one(exact);
  if (words.length === 1) return one(people.filter((p) => flat(p.firstName) === whole || flat(p.firstName.split(' ')[0]) === whole));
  const last = flat(words[words.length - 1]);
  const firstWord = flat(words[0]);
  return one(
    people.filter((p) => {
      const lastWords = p.lastName.toLowerCase().split(/\s+/);
      const pLast = flat(lastWords[lastWords.length - 1]);
      const pFirst = flat(p.firstName);
      return pLast === last && firstWord.length >= 2 && (pFirst.startsWith(firstWord) || firstWord.startsWith(pFirst));
    }),
  );
}
