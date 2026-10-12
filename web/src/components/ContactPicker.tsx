import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './ui';

/** A customer's contact person, as `GET /customers/:id` sends them. */
export interface ContactRef {
  id: string;
  name: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

const keyOf = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** What the Attention line will print beside the name: the number and the email. */
export function contactReach(c: ContactRef): string {
  return [c.mobile || c.phone, c.email].filter((p) => p && p.trim()).join(' · ');
}

/**
 * "Create or choose a contact person" (2026-10-12, the owner's call: "allow
 * to add contact person; if it's not on the database allow also add, just
 * like … if customer can't find in the database") — the customer picker's
 * twin, on the chosen customer's own contacts.
 *
 * Type, and the customer's contacts that match are listed (name, position,
 * number); focused with nothing typed, all of them are. When what is typed
 * names nobody on file, the last row offers **add "X" as a new contact** to a
 * `gops.customers.edit_all` holder (the right the customer's own page asks).
 * It opens a small panel under the box — never a dialog — asking the
 * position, mobile and email, the last two being what the quotation's
 * Attention line prints; Add contact files them through the ordinary
 * `POST /customers/:id/contacts` (which refuses a name the customer already
 * has) and picks the new contact. Under the box, the chosen contact's number
 * and email, so the person sees what will print.
 *
 * Without a customer the box is disabled. Keyboard: ArrowDown reaches the
 * list, Escape closes it. Inside a `Field` it is wired like an input.
 */
export function ContactPicker({
  customerId,
  contacts,
  value,
  onChange,
  onAdded,
  onError,
  allowCreate = true,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  customerId: string | null;
  contacts: ContactRef[];
  /** The chosen contact's id, '' for none. */
  value: string;
  onChange: (contactId: string) => void;
  /** A contact just filed: the caller adds it to its list. */
  onAdded: (contact: ContactRef) => void;
  onError?: (err: unknown) => void;
  allowCreate?: boolean;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const mayCreate = allowCreate && can('gops.customers.edit_all');
  const chosen = contacts.find((c) => c.id === value) ?? null;
  const [text, setText] = useState(chosen?.name ?? '');
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<{ name: string; position: string; mobile: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A contact chosen from outside (a lead's, the customer's primary) shows its name.
  useEffect(() => {
    if (!picking) setText(chosen?.name ?? '');
  }, [chosen?.name, picking]);
  // A different customer starts afresh.
  useEffect(() => {
    setAdding(null);
  }, [customerId]);

  const term = text.trim();
  const typedKey = keyOf(term);
  const matches = contacts.filter((c) => {
    if (!typedKey || (chosen && keyOf(chosen.name) === typedKey)) return true;
    return [c.name, c.position ?? '', c.mobile ?? '', c.phone ?? '', c.email ?? ''].some((p) => keyOf(p).includes(typedKey));
  });
  const exact = contacts.some((c) => keyOf(c.name) === typedKey);
  const offerCreate = mayCreate && !!customerId && term.length >= 2 && !exact;
  const showMenu = picking && !!customerId && (matches.length > 0 || offerCreate || contacts.length === 0);

  function pick(c: ContactRef | null) {
    setText(c?.name ?? '');
    setPicking(false);
    onChange(c?.id ?? '');
    inputRef.current?.focus();
  }

  function startAdding() {
    setAdding({ name: term, position: '', mobile: '', email: '' });
    setPicking(false);
  }

  async function addContact() {
    if (!adding || !customerId) return;
    if (adding.name.trim().length < 2) {
      toast('error', 'Give the contact a name');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<ContactRef>(`/customers/${customerId}/contacts`, {
        name: adding.name.trim(),
        position: adding.position.trim() || null,
        mobile: adding.mobile.trim() || null,
        email: adding.email.trim() || null,
      });
      toast('ok', `${created.name} added as a contact`);
      onAdded(created);
      setAdding(null);
      setText(created.name);
      onChange(created.id);
    } catch (err) {
      if (onError) onError(err);
      else toast('error', err instanceof Error ? err.message : 'The contact could not be added');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && picking) {
      e.preventDefault();
      setPicking(false);
      setText(chosen?.name ?? '');
    }
    if (e.key === 'ArrowDown') {
      setPicking(true);
      const first = menuRef.current?.querySelector<HTMLElement>('button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
    if (e.key === 'Enter') {
      // The page's form must not submit from here.
      e.preventDefault();
      const only = matches.length === 1 ? matches[0] : contacts.find((c) => keyOf(c.name) === typedKey);
      if (only) pick(only);
      else if (offerCreate) startAdding();
    }
  }

  const reach = chosen ? contactReach(chosen) : '';
  const field = (key: 'name' | 'position' | 'mobile' | 'email', label: string, type = 'text') => (
    <label className="contact-add-field">
      <span>{label}</span>
      <input
        type={type}
        value={adding![key]}
        autoComplete="off"
        onChange={(e) => setAdding((a) => (a ? { ...a, [key]: e.target.value } : a))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void addContact();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setAdding(null);
            inputRef.current?.focus();
          }
        }}
      />
    </label>
  );

  return (
    <div className="contact-picker">
      <div
        className="lookup"
        onBlur={(e: FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setPicking(false);
            // Typing that named nobody is not a choice: the box shows the chosen one again.
            if (!adding) setText(chosen?.name ?? '');
          }
        }}
      >
        <input
          ref={inputRef}
          id={id}
          value={text}
          disabled={!customerId}
          autoComplete="off"
          placeholder={customerId ? 'Create or choose a contact person' : 'Choose the customer first'}
          aria-label={id ? undefined : 'Contact person'}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-autocomplete="list"
          aria-expanded={showMenu}
          onFocus={() => setPicking(true)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setText(e.target.value);
            setPicking(true);
          }}
        />
        {showMenu && (
          <ul className="lookup-menu" ref={menuRef}>
            {value && (
              <li>
                <button type="button" onClick={() => pick(null)}>
                  <span className="faint">— none —</span>
                </button>
              </li>
            )}
            {matches.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => pick(c)}>
                  {c.name}
                  {c.position ? <span className="faint">, {c.position}</span> : null}
                  {contactReach(c) && <span className="faint contact-reach-line">{contactReach(c)}</span>}
                </button>
              </li>
            ))}
            {!matches.length && !offerCreate && (
              <li className="lookup-none">
                {contacts.length ? `No contact of this customer matches “${term}”.` : 'This customer has no contacts on file yet.'}
              </li>
            )}
            {offerCreate && (
              <li className="lookup-new">
                <button type="button" onClick={startAdding}>
                  {matches.length ? 'Not one of these — ' : ''}add “{term}” as a new contact
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
      {adding && (
        <div className="contact-add" role="group" aria-label="New contact person">
          {field('name', 'Name')}
          {field('position', 'Position')}
          {field('mobile', 'Mobile', 'tel')}
          {field('email', 'Email', 'email')}
          <div className="contact-add-actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void addContact()} disabled={busy}>
              {busy ? 'Adding…' : 'Add contact'}
            </button>
          </div>
        </div>
      )}
      {chosen && !adding && (
        <div className="faint contact-reach">
          {reach || 'No number or email on file — the Attention line prints the name only'}
        </div>
      )}
    </div>
  );
}
(ContactPicker as unknown as { fieldControl: boolean }).fieldControl = true;
