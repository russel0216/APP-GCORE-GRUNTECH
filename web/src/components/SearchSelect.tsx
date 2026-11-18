import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useAuth } from '../lib/auth';
import { CREATE_LABEL, CREATE_RIGHT, CreatePopup, type CreateKind } from './CreatePopup';

/**
 * A select you TYPE in (2026-11-18, the owner's call: "make all the search bar
 * type, then suggested already on the database … if none appear a suggestion
 * to create one, popup window so it will retain on the page where I am").
 *
 * A drop-in for a native `<select>` that picks a RECORD (a project, a
 * warehouse, a person, a sales order): it takes the same `<option>` /
 * `<optgroup>` children, the same `value`, and calls `onChange` with
 * `{ target: { value } }`, so a handler written for a select works unchanged
 * (NumberInput's rule). Typing narrows the list, blind to capitals and extra
 * spaces; an option with value "" ("— none —") stays listed first.
 *
 * `create` adds the escape hatch under the list: "+ New …" with what was
 * typed, which the caller answers by opening the record's own New form in a
 * popup — the page underneath stays as it was.
 *
 * Keyboard: ArrowDown / ArrowUp walk the list, Enter picks, Escape closes and
 * puts the chosen name back; focus leaving the box does the same. Inside a
 * `Field` it is wired like a select (`fieldControl`).
 */

interface Opt {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function collect(children: ReactNode, group: string | undefined, out: Opt[]) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as {
      children?: ReactNode;
      value?: string | number;
      label?: string;
      disabled?: boolean;
    };
    if (child.type === Fragment) collect(props.children, group, out);
    else if (child.type === 'optgroup') collect(props.children, props.label ?? group, out);
    else if (child.type === 'option') {
      const label = textOf(props.children).replace(/\s+/g, ' ').trim();
      out.push({
        value: props.value === undefined ? label : String(props.value),
        label,
        group,
        disabled: props.disabled,
      });
    }
  });
}

// Records filed from a picker this session, so the box that made one can list
// it before the page's own list is fetched again. Keyed by kind (a contact's
// by its customer too).
const made = new Map<string, Opt[]>();

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function SearchSelect({
  value,
  onChange,
  children,
  id,
  required,
  disabled,
  autoFocus,
  className,
  style,
  placeholder,
  title,
  create: createProp,
  createKind,
  createCustomerId,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  value: string | number | null | undefined;
  onChange: (e: { target: { value: string } }) => void;
  children?: ReactNode;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  /** What an empty box reads; defaults to the "" option's label. */
  placeholder?: string;
  title?: string;
  /** "+ New …" under the list — the caller opens the New form in a popup. */
  create?: { label: string; onCreate: (typed: string) => void };
  /**
   * Offer "+ New warehouse / contact / item": the record's own New form opens
   * in a popup, and what is saved is listed here and chosen. Shown only to
   * someone who may file one.
   */
  createKind?: CreateKind;
  /** The customer a new contact belongs to (`createKind="contact"`). */
  createCustomerId?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
}) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const { can } = useAuth();
  const madeKey = createKind === 'contact' ? `contact:${createCustomerId ?? ''}` : (createKind ?? '');
  const [creating, setCreating] = useState<string | null>(null);
  const [madeCount, setMadeCount] = useState(0);
  const mayMake =
    !!createKind && can(CREATE_RIGHT[createKind]) && (createKind !== 'contact' || !!createCustomerId);
  const create =
    createProp ?? (mayMake && createKind ? { label: CREATE_LABEL[createKind], onCreate: setCreating } : undefined);
  const options = useMemo(() => {
    const out: Opt[] = [];
    collect(children, undefined, out);
    for (const o of made.get(madeKey) ?? []) if (!out.some((x) => x.value === o.value)) out.push(o);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, madeKey, madeCount]);
  const current = String(value ?? '');
  const chosen = options.find((o) => o.value === current);
  const blank = options.find((o) => o.value === '');
  const shown = chosen && chosen.value !== '' ? chosen.label : '';

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const needle = fold(term ?? '');
  const matches = useMemo(
    () => (needle ? options.filter((o) => o.value === '' || fold(o.label).includes(needle)) : options),
    [options, needle],
  );
  const real = matches.filter((o) => o.value !== '');

  useEffect(() => {
    setActive(0);
  }, [needle, open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function close() {
    setOpen(false);
    setTerm(null);
  }

  function pick(o: Opt) {
    if (o.disabled) return;
    close();
    if (o.value !== current) onChange({ target: { value: o.value } });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (matches.length ? (a + step + matches.length) % matches.length : 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const o = matches[active];
      if (o) pick(o);
      else if (create && term?.trim()) {
        const typed = term.trim();
        close();
        create.onCreate(typed);
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
  }

  let lastGroup: string | undefined;
  return (
    <div className={`lookup search-select${className ? ` ${className}` : ''}`} style={style} ref={rootRef} onBlur={onBlur}>
      <input
        ref={inputRef}
        id={id ?? autoId}
        role="combobox"
        value={term ?? shown}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        title={title}
        placeholder={placeholder ?? blank?.label ?? 'Type to search…'}
        aria-label={ariaLabel}
        aria-invalid={invalid === true || invalid === 'true' || undefined}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
      />
      <span className="search-select-caret" aria-hidden="true">
        ▾
      </span>

      {open && !disabled && (
        <ul className="lookup-menu" id={listId} ref={menuRef} role="listbox">
          {matches.map((o, i) => {
            const head = o.group !== lastGroup && o.group ? o.group : null;
            lastGroup = o.group;
            return (
              <Fragment key={`${o.group ?? ''}|${o.value}|${i}`}>
                {head && <li className="search-select-group">{head}</li>}
                <li role="option" aria-selected={o.value === current}>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={o.disabled}
                    data-active={i === active}
                    className={o.value === current ? 'is-chosen' : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(o)}
                  >
                    {o.label || '—'}
                  </button>
                </li>
              </Fragment>
            );
          })}
          {real.length === 0 && (
            <li className="lookup-none">{needle ? `Nothing matches “${(term ?? '').trim()}”.` : 'Nothing to choose from yet.'}</li>
          )}
          {create && (
            <li className="lookup-new">
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const typed = (term ?? '').trim();
                  close();
                  create.onCreate(typed);
                }}
              >
                + {create.label}
                {term?.trim() ? ` “${term.trim()}”` : ''}
              </button>
            </li>
          )}
        </ul>
      )}

      {creating !== null && createKind && (
        <CreatePopup
          kind={createKind}
          typed={creating}
          customerId={createCustomerId}
          onClose={() => setCreating(null)}
          onCreated={(c) => {
            made.set(madeKey, [...(made.get(madeKey) ?? []), { value: c.id, label: c.label }]);
            setMadeCount((n) => n + 1);
            setCreating(null);
            onChange({ target: { value: c.id } });
          }}
        />
      )}
    </div>
  );
}
// Field wires its label, hint and error to it as it does to a native select.
(SearchSelect as unknown as { fieldControl: boolean }).fieldControl = true;
