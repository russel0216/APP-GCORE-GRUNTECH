import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { api, qs } from '../lib/api';

/**
 * A text box that remembers (2026-10-12, the owner's call: "in all of the
 * input, even description, allow memory suggestion of previous input").
 *
 * As it is typed — two characters by default, at once where `minChars` is 0
 * — it asks `source` (`/quotations/suggest/fields`, `/sales-orders/suggest/
 * fields`) for what was typed in the same `field` before, on documents the
 * viewer may read, and lists it under the box. Picking one REPLACES the text,
 * which stays editable. Keyboard: ArrowDown (or Alt+ArrowDown in a textarea,
 * whose plain arrows move the caret) reaches the list, the arrows move in
 * it, Enter takes one, Escape closes it; focus leaving the box and its list
 * closes it too. A long text shows its first line, the whole in its title.
 *
 * `onChange` hands `{ target: { value } }`, as NumberInput does, so a
 * handler written for a plain box works unchanged. Inside a `Field` it is
 * wired like an input (`fieldControl`). `params` narrow the memory (a
 * product type under its brand, a description under its product).
 */
type Shared = {
  source: string;
  field: string;
  params?: Record<string, string | undefined>;
  /** Characters typed before the list is asked for; 0 lists the latest on focus. */
  minChars?: number;
  value: string;
  onChange: (e: { target: { value: string } }) => void;
};

type InputProps = Shared & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { multiline?: false };
type AreaProps = Shared & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { multiline: true };

export function MemoryInput(props: InputProps | AreaProps) {
  const { source, field, params, minChars = 2, value, onChange, multiline, ...rest } = props;
  const [open, setOpen] = useState(false);
  // Alt+ArrowDown asks for the list whatever has been typed.
  const [forced, setForced] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const menuRef = useRef<HTMLUListElement>(null);
  const boxRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const paramKey = JSON.stringify(params ?? {});

  useEffect(() => {
    const term = value.trim();
    if (!open || (!forced && term.length < minChars)) {
      setOptions([]);
      return;
    }
    // A reply to an earlier term must not pass for this one's.
    let stale = false;
    const t = setTimeout(() => {
      api
        .get<string[]>(`${source}${qs({ field, q: term || undefined, ...(JSON.parse(paramKey) as Record<string, string | undefined>) })}`)
        .then((rows) => {
          if (!stale) setOptions(rows);
        })
        .catch(() => {
          if (!stale) setOptions([]);
        });
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [source, field, paramKey, value, open, forced, minChars]);

  const buttons = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];

  function choose(text: string) {
    onChange({ target: { value: text } });
    setOpen(false);
    setForced(false);
    setOptions([]);
    // The button pressed goes with the list; the keyboard stays in the box.
    boxRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Escape' && open && options.length) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' && (!multiline || e.altKey)) {
      if (options.length) {
        e.preventDefault();
        buttons()[0]?.focus();
      } else if (e.altKey || !multiline) {
        e.preventDefault();
        setOpen(true);
        setForced(true);
      }
    }
  }

  const common = {
    ref: boxRef,
    value,
    autoComplete: 'off',
    'aria-autocomplete': 'list' as const,
    'aria-expanded': open && options.length > 0,
    onFocus: () => setOpen(true),
    onKeyDown,
    onChange: (e: { target: { value: string } }) => {
      onChange({ target: { value: e.target.value } });
      setOpen(true);
    },
  };

  return (
    <div
      className="lookup memory"
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setForced(false);
        }
      }}
    >
      {multiline ? (
        <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...common} />
      ) : (
        <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...common} />
      )}
      {open && options.length > 0 && (
        <ul className="lookup-menu memory-menu" ref={menuRef} aria-label="Typed before">
          {options.map((o) => {
            const first = o.split('\n')[0];
            return (
              <li key={o}>
                <button
                  type="button"
                  title={o === first ? undefined : o}
                  onClick={() => choose(o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpen(false);
                      boxRef.current?.focus();
                    }
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const list = buttons();
                      const next = list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
                      if (next) next.focus();
                      else if (e.key === 'ArrowUp') boxRef.current?.focus();
                    }
                  }}
                >
                  {first}
                  {o !== first && <span className="faint"> …</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
// Field wires its label, hint and error to the text box, as to a native input.
(MemoryInput as unknown as { fieldControl: boolean }).fieldControl = true;

/** Where the quotation editor's boxes remember from. */
export const QUOTATION_MEMORY = '/quotations/suggest/fields';
/** Where the sales order editor's boxes remember from. */
export const ORDER_MEMORY = '/sales-orders/suggest/fields';
