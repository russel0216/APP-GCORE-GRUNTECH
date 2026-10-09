import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { openPdf } from '../lib/api';
import { Menu } from './Menu';
import { useConfirm, type ConfirmApi, type ConfirmSpec } from './Confirm';
import { StatusBadge, useToast, type Tone } from './ui';

/**
 * The header on a single-record page — every record page, in every module
 * (2026-10-09, the owner's call: "uniformity of button location — modify,
 * delete, back").
 *
 * Left: what kind of document it is and its number, its status beside the
 * number, what it is about, and one line of who and what it belongs to.
 * Right: what it is worth, then the buttons, ALWAYS in this order —
 *
 *   [next steps …]  [Print]  [⋯]  [Modify]
 *
 * - Next steps are what moves the document on (Submit for approval, Issue,
 *   Receive goods, Release cash). The one main step is `btn-primary`.
 * - Print is the record's paper, one word on every page.
 * - ⋯ holds the rarer actions (Duplicate, New revision, Reopen …) and, last
 *   and in red, the destructive ones (Cancel …, Delete). A destructive item
 *   asks in the confirm bar under this header before anything happens.
 * - Modify is always the right-most button, so it is found in the same place
 *   on every record. A record that cannot be modified now has none.
 *
 * Back is never here: the Shell draws "← Back to …" above the header, on
 * every page, in one place.
 */

export interface MoreItem {
  label: string;
  /** A second, smaller line: what it does, or why it is not available. */
  hint?: string;
  onSelect?: () => void;
  /** A link instead of a handler (Duplicate opens the editor with a preset). */
  to?: string;
  disabled?: boolean;
  /** Destructive: drawn after the others, in red. */
  danger?: boolean;
  /** When set, choosing the item opens the confirm bar instead of acting at once. */
  confirm?: ConfirmSpec;
}

export interface RecordActionsProps {
  /** Next steps — Submit for approval, Issue, Receive goods. The main one is btn-primary. */
  actions?: ReactNode;
  /** "Print": a full `/api/…/pdf` path (opened with openPdf) or a handler. */
  print?: string | (() => void);
  /** "Modify": a path (an editor page) or a handler (a modal). Always the right-most button. */
  modify?: string | (() => void);
  /** The ⋯ menu: everything rarer, then the destructive items. */
  more?: (MoreItem | false | null | undefined)[];
  /**
   * The page's own `useConfirm()`, when its next-step buttons ask too, so a
   * page has one bar in one place. RecordHeader renders its `bar` under the
   * header: the page must not render it again. Without it the header keeps
   * its own for the ⋯ items.
   */
  confirm?: ConfirmApi;
}

export interface RecordHeaderProps extends RecordActionsProps {
  /** The document kind, e.g. `Purchase Request`. Rendered uppercase. */
  type: string;
  /** Its number, e.g. `GT-PR-2026-0042`. Left out for a record with none. */
  code?: string;
  title: ReactNode;
  status?: string;
  /** A status written as words rather than an enum (e.g. "Active"). */
  statusLabel?: string;
  /** A module's own statuses, forwarded to `statusTone()` — see rule 12. */
  statusExtra?: Record<string, Tone>;
  /** One line under the title: the customer, the project it belongs to, who and when. */
  meta?: ReactNode;
  /** Pre-formatted — the caller knows whether this is money, hours or tonnes. */
  amount?: string;
  /**
   * What the amount IS. Required alongside `amount` because a fixed caption
   * would print "Total Contract Value" on a leave form.
   */
  amountLabel?: string;
}

/** The right-hand cluster on its own, in the fixed order. RecordHeader uses it. */
export function RecordActions({ actions, print, modify, more, confirm }: RecordActionsProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const items = (more ?? []).filter((i): i is MoreItem => !!i);
  const plain = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);

  function choose(item: MoreItem) {
    if (item.disabled) return;
    setOpen(false);
    if (item.confirm) {
      confirm?.ask(item.confirm);
      return;
    }
    if (item.to) navigate(item.to);
    else item.onSelect?.();
  }

  const menuItem = (item: MoreItem) => (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      className={item.danger ? 'menu-danger' : undefined}
      aria-disabled={item.disabled || undefined}
      onClick={() => choose(item)}
    >
      {item.label}
      {item.hint && <span className="menu-pop-why">{item.hint}</span>}
    </button>
  );

  return (
    <div className="record-head-actions">
      {actions}
      {print && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            typeof print === 'string'
              ? openPdf(print, (message) => toast('error', message || 'The PDF could not be opened'))
              : print()
          }
        >
          Print
        </button>
      )}
      {items.length > 0 && (
        <div className="menu-wrap record-head-more">
          <button
            type="button"
            className="btn btn-icon"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="More actions"
            title="More actions"
            onClick={() => setOpen((o) => !o)}
          >
            ⋯
          </button>
          {open && (
            <Menu label="More actions" onClose={() => setOpen(false)}>
              {plain.map(menuItem)}
              {plain.length > 0 && danger.length > 0 && <div role="separator" />}
              {danger.map(menuItem)}
            </Menu>
          )}
        </div>
      )}
      {modify &&
        (typeof modify === 'string' ? (
          <button type="button" className="btn" onClick={() => navigate(modify)}>
            Modify
          </button>
        ) : (
          <button type="button" className="btn" onClick={modify}>
            Modify
          </button>
        ))}
    </div>
  );
}

export function RecordHeader({
  type,
  code,
  title,
  status,
  statusLabel,
  statusExtra,
  meta,
  amount,
  amountLabel,
  actions,
  print,
  modify,
  more,
  confirm,
}: RecordHeaderProps) {
  const own = useConfirm();
  const bar = confirm ?? own;
  const hasActions = !!(actions || print || modify || (more ?? []).some(Boolean));
  return (
    <>
      <header className="record-head">
        <div className="record-head-main">
          <div className="record-head-title">
            <span className="record-head-kind">
              {type}
              {code && (
                <>
                  {' '}
                  • <strong>{code}</strong>
                </>
              )}
            </span>
            {status && <StatusBadge status={status} extra={statusExtra} label={statusLabel} />}
          </div>
          <h1>{title}</h1>
          {meta && <div className="record-head-meta">{meta}</div>}
        </div>

        <div className="record-head-aside">
          {amount && (
            <div className="record-head-amount">
              <div className="record-head-amount-label">{amountLabel ?? 'Total'}</div>
              <div className="record-head-amount-value">{amount}</div>
            </div>
          )}
          {hasActions && (
            <RecordActions actions={actions} print={print} modify={modify} more={more} confirm={bar} />
          )}
        </div>
      </header>
      {/* The confirm bar, under the header — the page's own when it passed one, so never render `confirm.bar` again. */}
      {bar.bar}
    </>
  );
}
