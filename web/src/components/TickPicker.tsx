import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

export interface TickChoice {
  value: string;
  label: string;
  /** A second line under the label (a team's full name). */
  hint?: string;
}

/**
 * Pick several (2026-10-12, the owner's call: "the product group, sales
 * personnel and team have tick box"). A box the size of a select that reads
 * what is ticked — `none` ("Everyone") when nothing is, the names when one
 * or two are, "3 salespeople" past that — and opens a panel under it with a
 * tick box per choice and Clear. Nothing ticked means no filter.
 *
 * Keyboard: Enter, Space or ArrowDown opens it and focuses the first box;
 * Escape closes it and returns to the button; focus leaving the whole picker
 * closes it. The button carries `aria-expanded`; the panel is a group named
 * by the picker's label. Inside a `Field` it is wired like a select
 * (`fieldControl`): the label points at the button.
 */
export function TickPicker({
  choices,
  value,
  onChange,
  none,
  noun,
  label,
  id,
  'aria-describedby': describedBy,
}: {
  choices: TickChoice[];
  value: string[];
  onChange: (value: string[]) => void;
  /** What the box reads with nothing ticked: "Everyone", "Every team". */
  none: string;
  /** The plural for a count: "salespeople", "teams", "product groups". */
  noun: string;
  /** The panel's accessible name; defaults to `noun`. */
  label?: string;
  /** Set by `Field`. */
  id?: string;
  /** Set by `Field`. */
  'aria-describedby'?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [open]);

  const ticked = new Set(value);
  const names = choices.filter((c) => ticked.has(c.value)).map((c) => c.label);
  // A value no longer among the choices still counts, so the box never says less than the filter does.
  const shown =
    value.length === 0 ? none : value.length <= 2 && names.length === value.length ? names.join(', ') : `${value.length} ${noun}`;

  const toggle = (v: string) => onChange(ticked.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  return (
    <div className="tick-picker" ref={rootRef} onBlur={onBlur} onKeyDown={onKey}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={`tick-picker-btn${value.length ? ' has-value' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={describedBy}
        title={names.length > 2 ? names.join(', ') : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="tick-picker-text">{shown}</span>
        <span className="tick-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="tick-menu" id={panelId} ref={panelRef} role="group" aria-label={label ?? noun}>
          {choices.length === 0 ? (
            <p className="muted tick-menu-empty">Nothing to choose from in this view.</p>
          ) : (
            <ul>
              {choices.map((c) => (
                <li key={c.value}>
                  <label className="checkbox">
                    <input type="checkbox" checked={ticked.has(c.value)} onChange={() => toggle(c.value)} />
                    <span>
                      {c.label}
                      {c.hint && <span className="tick-menu-hint">{c.hint}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="tick-menu-foot">
            <span className="faint">{value.length ? `${value.length} ticked` : `All ${noun}`}</span>
            <span className="row">
              {value.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => onChange([])}>
                  Clear
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => close(true)}>
                Done
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

(TickPicker as unknown as { fieldControl: boolean }).fieldControl = true;
