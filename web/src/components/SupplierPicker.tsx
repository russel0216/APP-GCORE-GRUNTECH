import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { api, qs } from '../lib/api';
import { useToast } from './ui';
import { useAuth } from '../lib/auth';

export interface SupplierRef {
  id: string;
  name: string;
  code?: string;
}

/**
 * "Create or choose a supplier" — the customer picker's twin for the other
 * side of the ledger (2026-10-10, the owner's call: "Separate Customer to
 * Supplier"). Type, pick one of the matching suppliers, or add the company
 * as a new supplier without leaving the form.
 *
 * Search as you type against `/suppliers/lookup?q=` (debounced; active
 * suppliers only, by name or code, 25 at a time — which is why a `<select>`
 * of the whole master was the wrong shape: the first 25 of 300 is not a
 * choice). The lookup needs `gchain.suppliers.view_all`; the form that
 * offers the picker decides whether the viewer holds it, as every form here
 * already did. A name is kept as typed — suppliers are filed as their
 * letterhead spells them ("Atlas Copco (Philippines) Inc."), and the lookup
 * matches case-blind anyway.
 *
 * "Add as a new supplier" files the name through the ordinary
 * `POST /suppliers` (the code is issued by numbering; everything else —
 * TIN, terms, address — is typed in later on the supplier record). It is
 * offered only to a holder of `gchain.suppliers.create` (the API refuses
 * anyone else) and only where the form allows it (`allowCreate` — the
 * partner form does not: "A new company" is its own way to file one).
 *
 * `disabled` is for a supplier the document has decided — a purchase order
 * from an awarded canvass, a bill matched to an order: the name shows,
 * nothing opens. `exclude` leaves out suppliers already on the list the
 * form adds to (a canvass's).
 *
 * The menu never opens empty, and it never offers "add as a new supplier"
 * against a lookup that has not answered: the offer waits for the answer to
 * what is typed, so a quick click cannot file a company the lookup was about
 * to find. When every match is already on the list it says so (whoever the
 * viewer is), and when the lookup fails — a 403 for a role without
 * `gchain.suppliers.view_all`, a dropped connection — it says "Suppliers
 * could not be listed" and offers no add button, because "nothing matches"
 * is not what a failed lookup means.
 *
 * Keyboard: the matches are buttons (Tab or ArrowDown reaches them), Escape
 * closes the list, and focus leaving the whole picker closes it too. Inside
 * a `Field` it is wired like an input (`fieldControl`): the label, the hint
 * and the error reach the text box.
 */
export function SupplierPicker({
  value,
  onChange,
  onError,
  inputId,
  invalid,
  describedBy,
  autoFocus,
  allowCreate = true,
  disabled,
  exclude,
  id,
  required,
  'aria-describedby': fieldDescribedBy,
  'aria-invalid': fieldInvalid,
}: {
  value: SupplierRef | null;
  onChange: (supplier: SupplierRef | null) => void;
  onError?: (err: unknown) => void;
  inputId?: string;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  /** False where a new supplier must not be filed from this form. */
  allowCreate?: boolean;
  /** The document has decided its supplier: show it, offer nothing. */
  disabled?: boolean;
  /** Ids never offered — suppliers already on the list this form adds to. */
  exclude?: string[];
  /** Set by `Field` (it wins over `inputId`, so the label points at the box). */
  id?: string;
  required?: boolean;
  /** Set by `Field`. */
  'aria-describedby'?: string;
  /** Set by `Field`. */
  'aria-invalid'?: boolean;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const mayCreate = allowCreate && can('gchain.suppliers.create');
  const [text, setText] = useState(value?.name ?? '');
  const [picking, setPicking] = useState(false);
  // What the lookup answered, before `exclude` takes its share.
  const [rows, setRows] = useState<SupplierRef[]>([]);
  // The term the rows answer, so "nothing matches" — and the offer to add —
  // wait for the answer. A failed lookup answers too, as `failed`.
  const [answered, setAnswered] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A supplier chosen from outside (a preset, an awarded canvass) shows its name here.
  useEffect(() => {
    if (value) setText(value.name);
  }, [value]);

  useEffect(() => {
    const term = text.trim();
    if (!picking || disabled || term.length < 2 || value) {
      setRows([]);
      setAnswered('');
      setFailed(false);
      return;
    }
    // A reply to an earlier term must not pass for this one's answer.
    let stale = false;
    const t = setTimeout(() => {
      api
        .get<SupplierRef[]>(`/suppliers/lookup${qs({ q: term })}`)
        .then((found) => {
          if (stale) return;
          setRows(found);
          setFailed(false);
          setAnswered(term);
        })
        .catch(() => {
          if (stale) return;
          setRows([]);
          setFailed(true);
          setAnswered(term);
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [text, picking, value, disabled]);

  function pick(s: SupplierRef) {
    setText(s.name);
    setPicking(false);
    setRows([]);
    onChange(s);
    // The button pressed is about to disappear with the list; without this the
    // keyboard lands on <body> and the next Tab starts from the top of the page.
    inputRef.current?.focus();
  }

  async function createSupplier() {
    const name = text.trim();
    if (name.length < 2) return;
    setBusy(true);
    try {
      const created = await api.post<SupplierRef>('/suppliers', { name });
      toast('ok', `${name} added as a supplier`);
      pick({ id: created.id, name: created.name, code: created.code });
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && picking) {
      e.preventDefault();
      setPicking(false);
    }
    if (e.key === 'ArrowDown' && picking) {
      const first = menuRef.current?.querySelector<HTMLElement>('button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPicking(false);
  }

  const term = text.trim();
  const open = picking && !disabled && !value && term.length >= 2;
  const matches = exclude?.length ? rows.filter((r) => !exclude.includes(r.id)) : rows;
  // Judged on everything found: a supplier already on the list is not "new".
  const sameName = rows.some((r) => r.name.toLowerCase() === term.toLowerCase());
  // The lookup has answered for exactly what is typed.
  const settled = answered === term;
  // One line that says why nothing is listed — or nothing, while matches are.
  const notice = !settled
    ? null
    : failed
      ? 'Suppliers could not be listed.'
      : matches.length
        ? null
        : rows.length
          ? `Every supplier matching “${term}” is already on this list.`
          : mayCreate
            ? null // the add button is the message
            : `No supplier on file matches “${term}”.`;
  const offerCreate = mayCreate && settled && !failed && !sameName;
  // Never an empty bordered box: the menu opens only with something in it.
  const showMenu = open && (matches.length > 0 || notice !== null || offerCreate);
  return (
    <div
      className="lookup"
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && picking) setPicking(false);
      }}
    >
      <input
        ref={inputRef}
        id={id ?? inputId}
        value={text}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={mayCreate ? 'Create or choose a supplier' : 'Choose a supplier'}
        aria-invalid={invalid || fieldInvalid || undefined}
        aria-describedby={[describedBy, fieldDescribedBy].filter(Boolean).join(' ') || undefined}
        aria-expanded={showMenu}
        aria-autocomplete="list"
        onFocus={() => setPicking(true)}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setText(e.target.value);
          setPicking(true);
          if (value) onChange(null);
        }}
      />
      {value && (
        <span className="lookup-tick" title="Linked to a supplier record">
          linked
        </span>
      )}

      {showMenu && (
        <ul className="lookup-menu" ref={menuRef}>
          {matches.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => pick(s)}>
                {s.name}
                {s.code && <span className="muted"> · {s.code}</span>}
              </button>
            </li>
          ))}
          {notice && <li className="lookup-none">{notice}</li>}
          {offerCreate && (
            <li className="lookup-new">
              <div className="lookup-new-row">
                <button type="button" onClick={createSupplier} disabled={busy}>
                  {matches.length ? 'Not one of these — ' : ''}add “{term}” as a new supplier
                </button>
              </div>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
// Field wires its label, hint and error to the text box, as to a native input.
(SupplierPicker as unknown as { fieldControl: boolean }).fieldControl = true;
