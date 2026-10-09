import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, qs } from '../../lib/api';
import { lineAmount, quotationTotals } from '../../lib/quotationMath';
import { formatMoney } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberInput } from '../../components/NumberInput';

/*
  The pieces the quotation editor and the sales order editor share
  (2026-10-08, the owner's call: the sales order is modified the way a
  quotation is). A line as the table edits it, its arithmetic view for
  lib/quotationMath, the payload both APIs take, and the cells — product with
  suggestions, cost and provider, the read-only header value. Leaving with
  unsaved changes is the Shell's question now (useUnsavedChanges in
  components/Navigation.tsx), so there is no leave bar of the editors' own.
  Nothing here knows which document it is in.
*/

export type ProviderKind = 'none' | 'user' | 'supplier';

export interface Line {
  /** Client-side identity for React and for field ids; never sent. */
  key: string;
  /** A subheading: its title is the heading; no quantity, price or cost. */
  isHeading: boolean;
  /** The product group, chosen from Admin › Categories (required on a priced line); never printed as a heading. */
  group: string;
  /**
   * The product's three boxes (2026-10-08): on paper they print as one
   * sentence — "SCHNEIDER ELECTRIC, CIRCUIT BREAKER, EZC100H3030". `title` is
   * that sentence, or the title a line typed before them carries.
   */
  brand: string;
  productType: string;
  partNumber: string;
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

export type Option = { id: string; name: string };
export type TaxOption = { rate: number; label: string };

/** What /quotations/suggest offers as a product is typed. */
export interface ProductSuggestion {
  title: string;
  /** The three boxes, where the line or item had them; null on a line typed as a title alone. */
  brand: string | null;
  productType: string | null;
  partNumber: string | null;
  description: string;
  unit: string;
  unitPrice: number | null;
  /** Only where the server decided this viewer may see it. */
  unitCost?: number | null;
  source: 'history' | 'item';
  uses: number;
  lastNumber?: string;
  itemCode?: string;
}

let keySeq = 0;
export const nextKey = () => `l${++keySeq}`;

export function blankLine(isHeading = false): Line {
  return {
    key: nextKey(),
    isHeading,
    group: '',
    brand: '',
    productType: '',
    partNumber: '',
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
export function isBlank(l: Line): boolean {
  if (l.isHeading) return !l.title.trim();
  return (
    !l.group.trim() &&
    !l.brand.trim() &&
    !l.productType.trim() &&
    !l.partNumber.trim() &&
    !l.title.trim() &&
    !l.description.trim() &&
    l.unitPrice.trim() === '' &&
    l.unitCost.trim() === '' &&
    !l.costNote.trim() &&
    !l.provider
  );
}

/** A typed number for the live figures: nothing, nonsense or below zero counts as 0. */
export const figure = (s: string) => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 0;
};
export const numberOk = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0;
export const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
/** A line's amount with the tax on — SCORO's grey figure under Amount. Shown, never stored. */
export const withTax = (amount: number, rate: number) => Math.round(amount * (1 + rate) * 100) / 100;

/** The mirror's view of a line — the same fields the server's arithmetic reads. */
export function moneyOf(l: Line) {
  if (l.isHeading) return { amount: 0, costAmount: null, providerUserId: null, providerSupplierId: null, isHeading: true };
  const qty = figure(l.quantity);
  return {
    amount: lineAmount(qty, figure(l.unitPrice)),
    costAmount: l.unitCost.trim() === '' ? null : lineAmount(qty, figure(l.unitCost)),
    providerUserId: l.providerKind === 'user' ? (l.provider?.id ?? null) : null,
    providerSupplierId: l.providerKind === 'supplier' ? (l.provider?.id ?? null) : null,
  };
}

/** A line as the API's itemSchema takes it. */
export function linePayload(l: Line) {
  if (l.isHeading) {
    return { isHeading: true, title: l.title.trim(), description: '', quantity: 0, unit: 'lot', unitPrice: 0, unitCost: null };
  }
  return {
    group: l.group.trim() || null,
    brand: l.brand.trim() || null,
    productType: l.productType.trim() || null,
    partNumber: l.partNumber.trim() || null,
    title: productSentence(l) ?? (l.title.trim() || null),
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

export const lineField = (key: string, field: string) => `qe-line-${key}-${field}`;

/** The three boxes as the paper prints them — the server's `productTitle`, mirrored. Null when all three are empty. */
export function productSentence(l: { brand: string; productType: string; partNumber: string }): string | null {
  const parts = [l.brand, l.productType, l.partNumber].map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** A group as the editor's dropdown offers it (Admin › Categories › Quotation groups). */
export interface KnownGroup {
  name: string;
  description: string | null;
  brand: string | null;
}

/** The group's row for a line's value, case-blind — the master's spelling wins. */
export function knownGroupOf(groups: KnownGroup[], value: string): KnownGroup | undefined {
  const key = value.trim().toLowerCase();
  return key ? groups.find((g) => g.name.trim().toLowerCase() === key) : undefined;
}

/** A read-only header value, laid out like a field. */
export function Static({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field qe-static">
      <span className="qe-static-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** A field around a control that is not a single element (the customer picker). */
export function LooseField({
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

export function CellError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <div className="qe-cell-error" id={id}>
      <span aria-hidden="true">⚠</span> {message}
    </div>
  );
}

/**
 * SCORO's "Cost and provider info", in the owner's layout (2026-10-09): the
 * two toggles for who carries the line's cost — one of our people (in-house)
 * or a supplier (outsourced); pressing the one that is on clears it — with
 * the person or supplier beside them on the first line; the unit cost and
 * the total cost side by side under it, each captioned; the notes last.
 * Either cost box may be typed: the total is quantity × unit cost, and a
 * typed total sets the unit cost to total ÷ quantity, to the centavo (a
 * quantity the division does not go into shows the centavo it lands on once
 * the box is left). Only the unit cost is sent; the server derives the
 * amount. Nothing is said while no provider is named (2026-10-08, the
 * owner's call).
 */
export function CostCell({
  line,
  n,
  costError,
  amount,
  onChange,
}: {
  line: Line;
  n: number;
  costError?: string;
  /** The line's cost as the mirror derives it (quantity × unit cost); null while no unit cost is typed. */
  amount: number | null;
  currency?: string;
  onChange: (patch: Partial<Line>) => void;
}) {
  const kinds: [Exclude<ProviderKind, 'none'>, 'person' | 'building', string][] = [
    ['user', 'person', 'In-house — one of our people'],
    ['supplier', 'building', 'Outsourced — a supplier'],
  ];
  const qty = figure(line.quantity);
  // The total box shows what was typed while it has focus, else the derived total.
  const [totalText, setTotalText] = useState(amount == null ? '' : String(amount));
  const [editingTotal, setEditingTotal] = useState(false);
  useEffect(() => {
    if (!editingTotal) setTotalText(amount == null ? '' : String(amount));
  }, [amount, editingTotal]);
  function typeTotal(text: string) {
    setTotalText(text);
    if (text.trim() === '') {
      onChange({ unitCost: '' });
      return;
    }
    const total = Number(text);
    if (!Number.isFinite(total) || total < 0 || qty <= 0) return;
    onChange({ unitCost: String(Math.round((total / qty) * 100) / 100) });
  }
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
          <span className="faint qe-provider-hint">Who carries the cost</span>
        )}
      </div>
      <div className="qe-cost-row">
        <label className="qe-cost-box">
          <NumberInput
            kind="money"
            id={lineField(line.key, 'unitCost')}
            className="qe-num"
            min={0}
            step="0.01"
            placeholder="0.00"
            aria-label={`Line ${n} unit cost`}
            aria-invalid={costError ? true : undefined}
            value={line.unitCost}
            onChange={(e) => onChange({ unitCost: e.target.value })}
          />
          <span className="qe-cost-caption">Unit cost</span>
        </label>
        <label className="qe-cost-box">
          <NumberInput
            kind="money"
            className="qe-num"
            min={0}
            step="0.01"
            placeholder="0.00"
            aria-label={`Line ${n} total cost`}
            title={qty > 0 ? undefined : 'Give the line a quantity first'}
            disabled={qty <= 0}
            value={totalText}
            onFocus={() => setEditingTotal(true)}
            onBlur={() => setEditingTotal(false)}
            onChange={(e) => typeTotal(e.target.value)}
          />
          <span className="qe-cost-caption">Total cost</span>
        </label>
      </div>
      <input
        aria-label={`Line ${n} cost notes`}
        placeholder="Notes"
        value={line.costNote}
        onChange={(e) => onChange({ costNote: e.target.value })}
      />
      <CellError message={costError} />
    </div>
  );
}

/** The contact person, beside the customer as SCORO has it. Nothing until the customer has contacts. */
export function ContactSelect({ contacts, value, onChange }: { contacts: Option[]; value: string; onChange: (v: string) => void }) {
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

export interface QuotationListRow {
  id: string;
  number: string;
  subject: string;
  customer: { name: string };
  latest: { revision: number; total: number } | null;
}

export function ProviderLookup({
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

/**
 * The Brand and Product type boxes: free text, with what was used before
 * offered underneath as it is typed (`/quotations/suggest/fields`) — a product
 * type under the brand typed first. A plain datalist: the keyboard reaches it
 * as any text box.
 */
function FieldSuggest({
  id,
  field,
  label,
  placeholder,
  value,
  brand,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  field: 'brand' | 'productType';
  label: string;
  placeholder: string;
  value: string;
  brand?: string;
  invalid?: boolean;
  describedBy?: string;
  onChange: (v: string) => void;
}) {
  const [options, setOptions] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) return;
    const t = setTimeout(() => {
      api
        .get<string[]>(`/quotations/suggest/fields${qs({ field, q: value.trim() || undefined, brand: field === 'productType' ? brand?.trim() || undefined : undefined })}`)
        .then(setOptions)
        .catch(() => setOptions([]));
    }, 200);
    return () => clearTimeout(t);
  }, [field, value, brand, focused]);
  const listId = `${id}-list`;
  return (
    <>
      <input
        id={id}
        className="qe-title"
        list={listId}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

/**
 * A line's product as three boxes (2026-10-08, the owner's call): Brand,
 * Product type and Part number — printed as one sentence. The part number is
 * the box with suggestions: past lines (latest price, unit and description,
 * and how often) and items from the item master, matched on any of the three
 * or the description; picking one fills all three. Keyboard: ArrowDown
 * reaches the list, arrows move in it, Escape closes it, and focus leaving
 * the box and its list closes it too.
 */
export function ProductCells({
  line,
  n,
  invalid,
  describedBy,
  onChange,
  onPick,
}: {
  line: Line;
  n: number;
  invalid?: boolean;
  describedBy?: string;
  onChange: (patch: Partial<Line>) => void;
  onPick: (sg: ProductSuggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<ProductSuggestion[]>([]);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const value = line.partNumber;

  useEffect(() => {
    const term = value.trim();
    if (!open || term.length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<ProductSuggestion[]>(`/quotations/suggest${qs({ q: term })}`)
        .then((rows) => setMatches(rows.filter((r) => (r.partNumber ?? r.title).toUpperCase() !== term.toUpperCase() || r.unitPrice != null)))
        .catch(() => setMatches([]));
    }, 220);
    return () => clearTimeout(t);
  }, [value, open]);

  function choose(sg: ProductSuggestion) {
    onPick(sg);
    setOpen(false);
    setMatches([]);
  }

  const buttons = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];

  return (
    <div className="qe-product-parts">
      <FieldSuggest
        id={lineField(line.key, 'brand')}
        field="brand"
        label={`Line ${n} brand`}
        placeholder="Brand"
        value={line.brand}
        onChange={(v) => onChange({ brand: v })}
      />
      <FieldSuggest
        id={lineField(line.key, 'productType')}
        field="productType"
        label={`Line ${n} product type`}
        placeholder="Prod."
        value={line.productType}
        brand={line.brand}
        invalid={invalid}
        describedBy={describedBy}
        onChange={(v) => onChange({ productType: v })}
      />
      <div
        className="lookup"
        onBlur={(e: FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <input
          ref={inputRef}
          id={lineField(line.key, 'partNumber')}
          className="qe-title"
          aria-label={`Line ${n} part number`}
          placeholder="Part No."
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open && matches.length > 0}
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange({ partNumber: e.target.value });
            setOpen(true);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Escape' && open) {
              e.preventDefault();
              setOpen(false);
            }
            if (e.key === 'ArrowDown' && matches.length) {
              e.preventDefault();
              buttons()[0]?.focus();
            }
          }}
        />
        {open && matches.length > 0 && (
          <ul className="lookup-menu qe-suggest" ref={menuRef}>
            {matches.map((sg, i) => (
              <li key={`${sg.source}-${sg.title}-${i}`}>
                <button
                  type="button"
                  onClick={() => choose(sg)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setOpen(false);
                      inputRef.current?.focus();
                    }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const list = buttons();
                      const next = list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
                      if (next) next.focus();
                      else if (e.key === 'ArrowUp') inputRef.current?.focus();
                    }
                  }}
                >
                  <span className="qe-suggest-name">{sg.title}</span>
                  <span className="faint qe-suggest-meta">
                    {sg.unitPrice != null ? `${formatMoney(sg.unitPrice)} / ${sg.unit}` : sg.unit}
                    {sg.source === 'item'
                      ? ` · item ${sg.itemCode ?? ''}`
                      : ` · quoted ${sg.uses}×${sg.lastNumber ? `, last on ${sg.lastNumber}` : ''}`}
                  </span>
                  {sg.description && <span className="faint qe-suggest-desc">{sg.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** What a suggestion puts in a line's boxes: its three parts where it has them, else the typed ones — a title-only line lands in Product type. */
export function partsFromSuggestion(l: Line, sg: ProductSuggestion): Partial<Line> {
  const legacy = !sg.brand && !sg.productType && !sg.partNumber;
  return {
    brand: sg.brand ?? l.brand,
    productType: sg.productType ?? (legacy ? sg.title : l.productType),
    partNumber: sg.partNumber ?? l.partNumber,
    title: sg.title,
  };
}

/**
 * SCORO's discount calculator (2026-10-08, the owner's call), opened in the
 * page under the totals — never a dialog. Excl tax / Incl tax columns: the
 * sum as it stands, the sum wanted (type in either column; the other
 * follows), and the discount that gets there, to six decimals. "Sum after
 * discount" shows the exact figure the percentage will produce, through the
 * editor's own arithmetic, before Insert puts it in the Discount box.
 */
export function DiscountCalculator({
  subtotal,
  vatRate,
  vatInclusive,
  currency,
  onInsert,
  onClose,
}: {
  /** The lines' sum before any discount. */
  subtotal: number;
  vatRate: number;
  vatInclusive: boolean;
  currency: string;
  onInsert: (pct: string) => void;
  onClose: () => void;
}) {
  const at = (pct: number) => {
    const t = quotationTotals({ lines: [{ amount: subtotal }], discountPct: pct, vatRate, vatInclusive });
    return { excl: t.netOfTax, incl: t.total };
  };
  const base = at(0);
  const [excl, setExcl] = useState(String(base.excl.toFixed(2)));
  const [incl, setIncl] = useState(String(base.incl.toFixed(2)));
  const [pct, setPct] = useState(0);

  /** The 6-decimal discount whose result lands on the sum wanted, in the column typed — the nearer of floor and ceiling. */
  function solve(wanted: number, column: 'excl' | 'incl'): number {
    const total = base[column];
    if (!(total > 0) || !Number.isFinite(wanted)) return 0;
    const raw = Math.min(100, Math.max(0, (1 - wanted / total) * 100));
    const lo = Math.floor(raw * 1e6) / 1e6;
    const hi = Math.min(100, Math.ceil(raw * 1e6) / 1e6);
    const cents = Math.round(wanted * 100);
    const off = (p: number) => Math.abs(Math.round(at(p)[column] * 100) - cents);
    return off(hi) < off(lo) ? hi : lo;
  }
  function typed(column: 'excl' | 'incl', text: string) {
    if (column === 'excl') setExcl(text);
    else setIncl(text);
    const wanted = Number(text);
    if (text.trim() === '' || !Number.isFinite(wanted)) return;
    const p = solve(wanted, column);
    setPct(p);
    const other = at(p);
    if (column === 'excl') setIncl(other.incl.toFixed(2));
    else setExcl(other.excl.toFixed(2));
  }
  const result = at(pct);
  const pctText = pct.toFixed(6);
  return (
    <div className="qe-discount-calc" role="group" aria-label="Discount calculator">
      <h4>Discount calculator</h4>
      <table>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Excl tax</th>
            <th scope="col">Incl tax</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Total sum</td>
            <td className="mono">{formatMoney(base.excl, currency)}</td>
            <td className="mono">{formatMoney(base.incl, currency)}</td>
          </tr>
          <tr>
            <td>Desired sum</td>
            <td>
              <NumberInput kind="money" min={0} step="0.01" aria-label="Desired sum, excluding tax" value={excl} onChange={(e) => typed('excl', e.target.value)} />
            </td>
            <td>
              <NumberInput kind="money" min={0} step="0.01" aria-label="Desired sum, including tax" value={incl} onChange={(e) => typed('incl', e.target.value)} />
            </td>
          </tr>
          <tr>
            <td>Discount</td>
            <td className="qe-calc-pct" colSpan={2}>
              {pctText} %
            </td>
          </tr>
          <tr>
            <td>Sum after discount</td>
            <td className="mono">{formatMoney(result.excl, currency)}</td>
            <td className="mono">{formatMoney(result.incl, currency)}</td>
          </tr>
        </tbody>
      </table>
      <div className="qe-calc-actions">
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onInsert(pctText.replace(/0+$/, '').replace(/\.$/, ''))}>
          Insert
        </button>
      </div>
    </div>
  );
}
