import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { api, qs } from '../lib/api';
import { useToast } from './ui';

export interface CustomerRef {
  id: string;
  name: string;
}

/**
 * "Create or choose a client" — type, pick one of the matching customers, or
 * add the company as a new customer without leaving the form.
 *
 * The same lookup-or-add the lead form carries (Leads.tsx `LeadForm`): search
 * as you type against `/customers/lookup?q=` (debounced), capitals as they
 * type so the same firm is not filed three ways, and the quick-add asks for
 * the industry right beside the button because the server refuses a customer
 * without one. The lead form keeps its own copy because its company name is
 * also a free-text field of the lead itself; here the text only ever names a
 * customer record, so an unpicked name is no customer at all (`null`).
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
  /* null = not loaded yet; [] = none set up, which is said plainly. */
  const [industries, setIndustries] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [industryId, setIndustryId] = useState('');
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A customer chosen from outside (a preset, a lead) shows its name here.
  useEffect(() => {
    if (value) setText(value.name);
  }, [value]);

  useEffect(() => {
    if (!picking || industries !== null) return;
    api
      .get<{ id: string; code: string; name: string }[]>('/reference/industries?active=true')
      .then(setIndustries)
      .catch(() => setIndustries([]));
  }, [picking, industries]);

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
    if (name.length < 2 || !industryId) return;
    setBusy(true);
    try {
      const created = await api.post<CustomerRef>('/customers', { name, industryId });
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
        placeholder="Create or choose a client"
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
              {industries !== null && industries.length === 0 ? (
                <span className="lookup-note">
                  A new customer needs an industry, and none are set up yet. Ask an administrator to
                  add them under Admin › Categories.
                </span>
              ) : (
                <div className="lookup-new-row">
                  <select
                    aria-label="Industry of the new customer"
                    value={industryId}
                    onChange={(e) => setIndustryId(e.target.value)}
                  >
                    <option value="">Industry…</option>
                    {(industries ?? []).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.code} — {i.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={createCustomer}
                    disabled={busy || !industryId}
                    title={industryId ? undefined : 'Pick the industry first'}
                  >
                    {matches.length ? 'Not one of these — ' : ''}add “{term}” as a new customer
                  </button>
                </div>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
