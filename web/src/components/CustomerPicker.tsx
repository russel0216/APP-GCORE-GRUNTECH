import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { api, qs } from '../lib/api';
import { useToast } from './ui';

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
 */
export function CustomerPicker({
  value,
  onChange,
  onError,
  inputId,
  invalid,
  describedBy,
  autoFocus,
}: {
  value: CustomerRef | null;
  onChange: (customer: CustomerRef | null) => void;
  onError?: (err: unknown) => void;
  inputId?: string;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState(value?.name ?? '');
  const [picking, setPicking] = useState(false);
  const [matches, setMatches] = useState<CustomerRef[]>([]);
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
      return;
    }
    const t = setTimeout(() => {
      api
        .get<CustomerRef[]>(`/customers/lookup${qs({ q: term })}`)
        .then(setMatches)
        .catch(() => setMatches([]));
    }, 180);
    return () => clearTimeout(t);
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
        id={inputId}
        value={text}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Create or choose a customer"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-expanded={open}
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

      {open && (
        <ul className="lookup-menu" ref={menuRef}>
          {matches.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => pick(c)}>
                {c.name}
              </button>
            </li>
          ))}
          {!matches.some((m) => m.name === term) && (
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
