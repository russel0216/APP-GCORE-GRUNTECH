import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, qs } from '../../lib/api';
import { lineAmount } from '../../lib/quotationMath';
import { formatMoney } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { NumberInput } from '../../components/NumberInput';

/*
  The pieces the quotation editor and the sales order editor share
  (2026-10-08, the owner's call: the sales order is modified the way a
  quotation is). A line as the table edits it, its arithmetic view for
  lib/quotationMath, the payload both APIs take, and the cells — product with
  suggestions, cost and provider, the read-only header value, the leave bar.
  Nothing here knows which document it is in.
*/

export type ProviderKind = 'none' | 'user' | 'supplier';

export interface Line {
  /** Client-side identity for React and for field ids; never sent. */
  key: string;
  /** A subheading: its title is the heading; no quantity, price or cost. */
  isHeading: boolean;
  /** SCORO's group — "Gruntech Installation", "Trading". Suggested from Admin › Categories; never printed as a heading. */
  group: string;
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
    title: l.title.trim() || null,
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

/** A read-only header value, laid out like a field. */
export function Static({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field qe-static">
      <span className="qe-static-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** A field around a control that is not a single element (the client picker). */
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
 * SCORO's "Cost and provider info": two toggles for who carries the line's
 * cost — one of our people (in-house) or a supplier (outsourced); pressing the
 * one that is on clears it — the person or supplier beside them, then the
 * notes and the unit cost. The line's cost (quantity × unit cost) sits under.
 */
export function CostCell({
  line,
  n,
  costError,
  amount,
  currency,
  onChange,
}: {
  line: Line;
  n: number;
  costError?: string;
  amount: number | null;
  currency: string;
  onChange: (patch: Partial<Line>) => void;
}) {
  const kinds: [Exclude<ProviderKind, 'none'>, 'person' | 'building', string][] = [
    ['user', 'person', 'In-house — one of our people'],
    ['supplier', 'building', 'Outsourced — a supplier'],
  ];
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
          <span className="faint qe-kind-none">No provider named</span>
        )}
      </div>
      <div className="qe-cost-row">
        <input
          aria-label={`Line ${n} cost notes`}
          placeholder="Notes"
          value={line.costNote}
          onChange={(e) => onChange({ costNote: e.target.value })}
        />
        <NumberInput
          kind="money"
          id={lineField(line.key, 'unitCost')}
          className="qe-num"
          min={0}
          step="0.01"
          placeholder="Unit cost"
          aria-label={`Line ${n} unit cost`}
          aria-invalid={costError ? true : undefined}
          value={line.unitCost}
          onChange={(e) => onChange({ unitCost: e.target.value })}
        />
      </div>
      <div className="mono faint qe-cost-sum">{amount == null ? 'not costed' : formatMoney(amount, currency)}</div>
      <CellError message={costError} />
    </div>
  );
}

/** The contact person, beside the client as SCORO has it. Nothing until the client has contacts. */
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

/** Leaving with unsaved work, asked in the page rather than in a dialog. */
export function LeaveBar({ onLeave, onStay }: { onLeave: () => void; onStay: () => void }) {
  return (
    <div className="alert warn row qe-leave" role="alert">
      <span>You have changes that are not saved.</span>
      <button type="button" className="btn btn-sm btn-danger" onClick={onLeave}>
        Leave without saving
      </button>
      <button type="button" className="btn btn-sm" autoFocus onClick={onStay}>
        Keep editing
      </button>
    </div>
  );
}

/**
 * A line's product, with what was quoted before offered as it is typed: past
 * lines (latest price, unit and description, and how often) and items from the
 * item master. Keyboard: ArrowDown reaches the list, arrows move in it, Escape
 * closes it, and focus leaving the box and its list closes it too.
 */
export function ProductInput({
  id,
  label,
  value,
  invalid,
  describedBy,
  onChange,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  invalid?: boolean;
  describedBy?: string;
  onChange: (v: string) => void;
  onPick: (sg: ProductSuggestion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<ProductSuggestion[]>([]);
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
        .get<ProductSuggestion[]>(`/quotations/suggest${qs({ q: term })}`)
        .then((rows) => setMatches(rows.filter((r) => r.title.toUpperCase() !== term.toUpperCase() || r.unitPrice != null)))
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
        placeholder="Product"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open && matches.length > 0}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
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
  );
}
