/**
 * How a typed number reads and prints in an input — DOM-free, so the verify
 * scripts can import it. `components/NumberInput.tsx` is the one input that
 * uses it; nothing else formats a number being edited.
 *
 * - money, quantity, percent: commas and at least 2 decimals (1,250.00)
 * - count: commas, no decimals unless the value has some (1,250; 7.5)
 * - decimal: commas, only the decimals the value has (0.55; 1,000)
 * - plain: no commas — a year or a sequence number is not an amount
 *
 * A value is never rounded for display: one with more decimals than the
 * minimum shows them all (a 3-dp quantity reads 1.125, not 1.13), because an
 * input that hides part of what it holds misleads whoever reads it.
 */
export type NumberKind = 'money' | 'quantity' | 'percent' | 'count' | 'decimal' | 'plain';

const MIN_DECIMALS: Record<NumberKind, number> = {
  money: 2,
  quantity: 2,
  percent: 2,
  count: 0,
  decimal: 0,
  plain: 0,
};

/** The digits a person may have typed: commas and spaces dropped. */
export function cleanNumberText(text: string): string {
  return text.replace(/[,\s]/g, '');
}

/** True for a number on its way to being typed: "", "-", "12.", ".5". */
export function isPartialNumber(text: string, allowNegative = true): boolean {
  return (allowNegative ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/).test(text);
}

/** The value as an input shows it when it is not being edited. */
export function formatNumberText(value: number | string | null | undefined, kind: NumberKind): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'number' ? String(value) : cleanNumberText(value);
  if (raw === '' || raw === '-') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(value);
  // The decimals the value itself carries, from its plain spelling.
  const plain = /e/i.test(raw) ? n.toFixed(10).replace(/0+$/, '') : raw;
  const dot = plain.indexOf('.');
  const own = dot < 0 ? 0 : plain.length - dot - 1;
  const decimals = Math.min(10, Math.max(MIN_DECIMALS[kind], own));
  if (kind === 'plain') return n.toFixed(decimals);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** The value as the input shows it WHILE it is being edited: no commas, as stored. */
export function editNumberText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : cleanNumberText(value);
}
