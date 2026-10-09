import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

/*
  The one way to ask before doing something that cannot be taken back
  (2026-10-09, the owner's call: "uniformity of button location — modify,
  delete, back"). Delete, Cancel, Reopen, Mark lost, Approve: every one asks
  in the page, in the same bar, under the record's header — never a browser
  `confirm()`, never a dialog of its own, never not at all.

  The bar says what is about to happen, what it means, takes a reason where
  the document keeps one, and offers two buttons in a fixed order: "Keep it"
  (the safe default, focused) and the action itself. A refusal from the
  server is shown in the bar, which stays open so the person can read it.
*/

export interface ConfirmSpec {
  /** One sentence: what is about to happen. "Delete GT-LEAD-2026-0213?" */
  title: string;
  /** What it means: what goes, what stays, who is told. */
  body?: ReactNode;
  /** The button that does it: "Delete", "Cancel order", "Approve". */
  confirmLabel: string;
  /** Ask for a reason. 'required' refuses an empty one. */
  reason?: 'required' | 'optional';
  /** The reason box's label. Defaults to "Reason". */
  reasonLabel?: string;
  /** Red (the default) for what destroys or withdraws; primary for a decision such as Approve. */
  tone?: 'danger' | 'primary';
  /** Does it. A thrown error is shown in the bar; the bar closes when this resolves. */
  onConfirm: (reason: string) => Promise<unknown> | unknown;
}

export interface ConfirmApi {
  ask: (spec: ConfirmSpec) => void;
  /** Render this where the bar belongs: under the record's header. RecordHeader does it for you. */
  bar: ReactNode;
  open: boolean;
}

export function useConfirm(): ConfirmApi {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const ask = useCallback((next: ConfirmSpec) => setSpec(next), []);
  const bar = spec ? <ConfirmBar key={spec.title} spec={spec} onDone={() => setSpec(null)} /> : null;
  return { ask, bar, open: spec !== null };
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'That did not go through. Try again.';
}

export function ConfirmBar({ spec, onDone }: { spec: ConfirmSpec; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const tone = spec.tone ?? 'danger';
  const missing = spec.reason === 'required' && reason.trim() === '';

  useEffect(() => {
    // The reason when one is asked for, else the safe answer.
    (reasonBox.current ?? keep.current)?.focus();
    reasonBox.current?.scrollIntoView?.({ block: 'nearest' });
    keep.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  async function go() {
    if (busy || missing) return;
    setBusy(true);
    setError(null);
    try {
      await spec.onConfirm(reason.trim());
      onDone();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <div
      className={`confirm-bar confirm-${tone}`}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="confirm-bar-text">
        <strong id={titleId}>{spec.title}</strong>
        {spec.body && <div className="confirm-bar-body">{spec.body}</div>}
      </div>
      {spec.reason && (
        <div className="field confirm-bar-reason">
          <label htmlFor={reasonId}>
            {spec.reasonLabel ?? 'Reason'}
            {spec.reason === 'required' && <span className="req"> *</span>}
          </label>
          <textarea
            id={reasonId}
            ref={reasonBox}
            rows={2}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      {error && (
        <div className="confirm-bar-error" role="alert">
          {error}
        </div>
      )}
      <div className="confirm-bar-actions">
        <button ref={keep} type="button" className="btn" disabled={busy} onClick={onDone}>
          Keep it
        </button>
        <button
          type="button"
          className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy || missing}
          onClick={() => void go()}
        >
          {busy ? 'Working…' : spec.confirmLabel}
        </button>
      </div>
    </div>
  );
}
