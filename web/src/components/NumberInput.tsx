import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { cleanNumberText, editNumberText, formatNumberText, isPartialNumber, type NumberKind } from '../lib/number';

/**
 * What `onChange` receives: the number as typed, commas removed — so a
 * handler written for `<input type="number">` (`Number(e.target.value)`, or
 * the string kept as it is) works unchanged.
 */
export interface NumberChange {
  target: { value: string };
  currentTarget: { value: string };
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step'> & {
  /** How it reads when not being edited — see `lib/number.ts`. */
  kind: NumberKind;
  value: number | string | null | undefined;
  onChange: (e: NumberChange) => void;
  min?: number | string;
  max?: number | string;
  /** What the arrow keys add or take away. Default 1. */
  step?: number | string;
};

/**
 * The one numeric input (2026-10-06, the owner's call: every numeric input
 * formats). Right-aligned, accepts commas, shows commas and the kind's
 * decimals once you leave it, and the plain number while you type. A text
 * box underneath, so `min`/`max` are checked through the browser's own
 * validity (a form's `checkValidity()` and `:invalid` still see them) and
 * the up/down arrows step the value as a number box's would.
 */
export function NumberInput({ kind, value, onChange, min, max, step, className, onFocus, onBlur, onKeyDown, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const lo = min === undefined || min === '' ? null : Number(min);
  const hi = max === undefined || max === '' ? null : Number(max);
  const allowNegative = lo === null || lo < 0;

  const emit = (text: string) => onChange({ target: { value: text }, currentTarget: { value: text } });

  // min/max through the browser's own validity, as type="number" had it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = editNumberText(value);
    const n = Number(text);
    let message = '';
    if (text !== '' && text !== '-' && Number.isFinite(n)) {
      if (lo !== null && n < lo) message = `Enter ${formatNumberText(lo, kind)} or more`;
      else if (hi !== null && n > hi) message = `Enter ${formatNumberText(hi, kind)} or less`;
    }
    el.setCustomValidity(message);
  }, [value, lo, hi, kind]);

  function arrow(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const by = step === undefined || step === '' || step === 'any' ? 1 : Number(step) || 1;
    const current = Number(cleanNumberText(editing ?? editNumberText(value))) || 0;
    let next = current + (e.key === 'ArrowUp' ? by : -by);
    if (lo !== null) next = Math.max(lo, next);
    if (hi !== null) next = Math.min(hi, next);
    // Step without float dust: 0.1 + 0.2 is 0.3 here.
    const places = String(by).split('.')[1]?.length ?? 0;
    const text = String(Number(next.toFixed(Math.max(places, (String(current).split('.')[1] ?? '').length))));
    setEditing(text);
    emit(text);
  }

  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={kind === 'count' || kind === 'plain' ? (allowNegative ? 'text' : 'numeric') : 'decimal'}
      autoComplete="off"
      className={className ? `num-input ${className}` : 'num-input'}
      value={editing ?? formatNumberText(value, kind)}
      aria-valuemin={lo ?? undefined}
      aria-valuemax={hi ?? undefined}
      onFocus={(e) => {
        setEditing(editNumberText(value));
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditing(null);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented) arrow(e);
      }}
      onChange={(e) => {
        const typed = e.target.value;
        const clean = cleanNumberText(typed);
        // A keystroke that cannot be part of a number is not taken.
        if (!isPartialNumber(clean, allowNegative)) return;
        setEditing(typed);
        emit(clean);
      }}
    />
  );
}

// `Field` wires its label to a DOM input; this says it may wire this one too.
(NumberInput as unknown as { fieldControl: boolean }).fieldControl = true;
