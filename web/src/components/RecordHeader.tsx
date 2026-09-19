import type { ReactNode } from 'react';
import { StatusBadge } from './ui';

/**
 * The header on a single-record page.
 *
 * Four things in a fixed order, because every record page was answering them
 * in its own layout and some were not answering them at all:
 *
 *   what kind of document it is, and its number
 *   what state it is in
 *   what it is about
 *   what it is worth, and what you can do about it
 *
 * The status sits beside the number rather than trailing the end of a
 * sentence. It is the first thing anybody opening a document wants to know,
 * and on most of these pages it was the last thing on the line.
 */

export interface RecordHeaderProps {
  /** The document kind, e.g. `Purchase Request`. Rendered uppercase. */
  type: string;
  /** Its number, e.g. `GT-PR-2026-0042`. */
  code: string;
  title: string;
  status: string;
  /** Pre-formatted — the caller knows whether this is money, hours or tonnes. */
  amount?: string;
  /**
   * What the amount IS. Required alongside `amount` because a fixed caption
   * would print "Total Contract Value" on a leave form: a purchase request has
   * an estimated total, an expense claim has a reimbursable total, and a
   * quotation has a contract value. They are not the same number.
   */
  amountLabel?: string;
  actions?: ReactNode;
}

export function RecordHeader({
  type,
  code,
  title,
  status,
  amount,
  amountLabel,
  actions,
}: RecordHeaderProps) {
  return (
    <header className="record-head">
      <div className="record-head-main">
        <div className="record-head-title">
          <span className="record-head-kind">
            {type} • <strong>{code}</strong>
          </span>
          <StatusBadge status={status} />
        </div>
        <h1>{title}</h1>
      </div>

      <div className="record-head-aside">
        {amount && (
          <div className="record-head-amount">
            <div className="record-head-amount-label">{amountLabel ?? 'Total'}</div>
            <div className="record-head-amount-value">{amount}</div>
          </div>
        )}
        {actions && <div className="record-head-actions">{actions}</div>}
      </div>
    </header>
  );
}
