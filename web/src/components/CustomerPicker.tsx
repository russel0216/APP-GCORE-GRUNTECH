import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { api, qs } from '../lib/api';
import { useToast } from './ui';
import { useAuth } from '../lib/auth';

export interface CustomerRef {
  id: string;
  name: string;
}

/**
 * "Create or choose a customer" — type, pick one of the matching customers, or
 * add the company as a new customer without leaving the form.
 *
 * The same lookup-or-add the lead form carries (Leads.tsx `LeadForm`): search
 * as you type against `/customers/lookup?q=` (debounced), capitals as they
 * type so the same firm is not filed three ways, and a quick-add that files
 * the name through the ordinary customer create (the sub-industry is typed
 * in later, on the customer — 2026-10-08, the owner's call). The lead form
 * keeps its own copy because its company name is also a free-text field of
 * the lead itself; here the text only ever names a customer record, so an
 * unpicked name is no customer at all (`null`).
 *
 * Keyboard: the matches are buttons (Tab or ArrowDown reaches them), Escape
 * closes the list, and focus leaving the whole picker closes it too.
 *
 * "Add as a new customer" is offered only to a holder of
 * `gops.customers.create` (the API refuses anyone else) and only where the
 * form allows it (`allowCreate` — the equipment register's Modify does not).
 * Inside a `Field` it is wired like an input (`fieldControl`): the label, the
 * hint and the error reach the text box.
 */
export function CustomerPicker({
  value,
  onChange,
  onError,
  inputId,
  invalid,
  describedBy,
  autoFocus,
  allowCreate = true,
  id,
  required,
  'aria-describedby': fieldDescribedBy,
  'aria-invalid': fieldInvalid,
}: {
  value: CustomerRef | null;
  onChange: (customer: CustomerRef | null) => void;
  onError?: (err: unknown) => void;
  inputId?: string;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  /** False where a new customer must not be filed from this form. */
  allowCreate?: boolean;
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
  const mayCreate = allowCreate && can('gops.customers.create');
  const [text, setText] = useState(value?.name ?? '');
  const [picking, setPicking] = useState(false);
  const [matches, setMatches] = useState<CustomerRef[]>([]);
  // The term the matches answer, so "nothing matches" — and the offer to add —
  // wait for the answer. A failed lookup answers too, as `failed`: "nothing
  // matches" is not what a refused or dropped lookup means.
  const [answered, setAnswered] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A customer chosen from outside (a preset, a lead) shows its name here.
  useEffect(() => {
    if (value) setText(value.name);
  }, [value]);

  useEffect(() => {
    const term = text.trim();
    if (!picking || term.length < 2 || value) {
      setMatches([]);
      setAnswered('');
      setFailed(false);
      return;
    }
    // A reply to an earlier term must not pass for this one's answer.
    let stale = false;
    const t = setTimeout(() => {
      api
        .get<CustomerRef[]>(`/customers/lookup${qs({ q: term })}`)
        .then((rows) => {
          if (stale) return;
          setMatches(rows);
          setFailed(false);
          setAnswered(term);
        })
        .catch(() => {
          if (stale) return;
          setMatches([]);
          setFailed(true);
          setAnswered(term);
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [text, picking, value]);

  function pick(c: CustomerRef) {
    setText(c.name);
    setPicking(false);
    setMatches([]);
    onChange(c);
    // The button pressed is about to disappear with the list; without this the
    // keyboard lands on <body> and the next Tab starts from the top of the page.
    inputRef.current?.focus();
  }

  async function createCustomer() {
    const name = text.trim();
    if (name.length < 2) return;
    setBusy(true);
    try {
      const created = await api.post<CustomerRef>('/customers', { name });
      toast('ok', `${name} added as a customer`);
      pick({ id: created.id, name: created.name });
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
      const first = menuRef.current?.querySelector<HTMLElement>('button, select');
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
  const open = picking && !value && term.length >= 2;
  // The lookup has answered for exactly what is typed.
  const settled = answered === term;
  const sameName = matches.some((m) => m.name === term);
  const offerCreate = mayCreate && settled && !failed && !sameName;
  // One line that says why nothing is listed — or nothing, while matches are.
  const notice = !settled
    ? null
    : failed
      ? 'Customers could not be listed.'
      : matches.length || mayCreate
        ? null
        : `No customer on file matches “${term}”.`;
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
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Create or choose a customer"
        aria-invalid={invalid || fieldInvalid || undefined}
        aria-describedby={[describedBy, fieldDescribedBy].filter(Boolean).join(' ') || undefined}
        aria-expanded={showMenu}
        aria-autocomplete="list"
        onFocus={() => setPicking(true)}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setText(e.target.value.toUpperCase());
          setPicking(true);
          if (value) onChange(null);
        }}
      />
      {value && (
        <span className="lookup-tick" title="Linked to a customer record">
          linked
        </span>
      )}

      {showMenu && (
        <ul className="lookup-menu" ref={menuRef}>
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => pick(c)}>
                {c.name}
              </button>
            </li>
          ))}
          {notice && <li className="lookup-none">{notice}</li>}
          {offerCreate && (
            <li className="lookup-new">
              <div className="lookup-new-row">
                <button type="button" onClick={createCustomer} disabled={busy}>
                  {matches.length ? 'Not one of these — ' : ''}add “{term}” as a new customer
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
(CustomerPicker as unknown as { fieldControl: boolean }).fieldControl = true;
