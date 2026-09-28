import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../lib/api';

// ── Toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'warn' | 'info';
  text: string;
}

const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    // An error stays twice as long. "Saved" can afford to be missed; "the
    // supplier bill was rejected" cannot.
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === 'error' ? 9000 : 4200,
    );
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/*
        aria-live so a screen reader is told what happened. Errors interrupt
        (assertive); confirmations wait their turn (polite), which is the
        difference between being informed and being shouted at.
      */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.kind}`}
            role={t.kind === 'error' ? 'alert' : undefined}
          >
            <span>{t.text}</span>
            <button
              type="button"
              onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ── Error rendering ──────────────────────────────────────────────────────────

/**
 * Field-level validation errors come back from the API as a details array.
 * Showing them beside the message is the difference between "Some fields need
 * attention" and knowing which ones.
 */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ApiError ? error.details : undefined;
  return (
    <div className="alert error">
      {message}
      {details && details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>
              <strong>{d.field}</strong>: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label}
    </div>
  );
}

/**
 * An empty state is the first thing a new user sees on most screens, and
 * "Nothing here yet" full stop is a dead end. The action slot lets the screen
 * offer the button that fixes it — which is also the cheapest place to teach
 * someone what the screen is for.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  /**
   * A dialog has to hold focus. Without this, Tab walked straight out of the
   * modal and into the page behind it — so you could be typing into a form you
   * could not see, and Escape would close a dialog you had already left.
   *
   * Three things, all of which were missing: focus moves in on open and back
   * to wherever it came from on close, Tab cycles inside the panel, and the
   * page behind stops scrolling under the cursor.
   */
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);

    // The first real field, not the close button — the close button is the
    // thing you want last.
    const first = focusable();
    (first.find((el) => !el.hasAttribute('aria-label')) ?? first[0])?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ── Form fields ──────────────────────────────────────────────────────────────

/**
 * A labelled form field.
 *
 * The label is now wired to the control with htmlFor/id, which it was not:
 * before this, clicking a label did nothing and a screen reader announced an
 * unnamed input. The id is generated and pushed onto the single child, so no
 * caller has to invent one and none of the existing call sites change.
 *
 * `error` puts the message under the field it belongs to. The page-level
 * ErrorBox stays — it is the right place for "the server refused this" — but on
 * a costing form with twenty inputs, a message at the top of the page about a
 * field at the bottom is not feedback, it is a puzzle.
 */
export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** The control's id, when the child is a component (a PasswordInput) the label cannot find by itself. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Only a single DOM element child can take the id. Anything else — a row of
  // inputs, a custom picker — is left exactly as it was, and the label simply
  // does not claim to point at it.
  const described = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const wired = isValidElement(children) && typeof children.type === 'string';
  // A child that brings its own id keeps it, and the label points at THAT id —
  // otherwise the label would name an element that does not exist.
  const controlId = wired ? ((children as ReactElement<{ id?: string }>).props.id ?? id) : id;
  const control = wired
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id: controlId,
        'aria-describedby': described || undefined,
        'aria-invalid': error ? true : undefined,
        required:
          (children as ReactElement<{ required?: boolean }>).props.required ?? required ?? false,
      })
    : children;

  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor={wired ? controlId : htmlFor}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {control}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={errorId}>
          <span aria-hidden="true">⚠</span>
          {error}
        </div>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | '';

/**
 * One status-to-colour mapping for the whole application.
 *
 * This was written nine times — in PurchaseRequests, Leave, Overtime,
 * Contracts, Receivables, Leads, Quotations (twice) and service/Reports, plus
 * STATUS_TONE in the HR dashboard — and had already drifted: Leave treated
 * DRAFT as neutral where Contracts did not handle it at all, so the same word
 * was a different colour depending on which menu you reached it from.
 *
 * The rules are the document lifecycle every module shares:
 *
 *   settled well     → ok       APPROVED, PAID, RECEIVED, ACTIVE, WON…
 *   settled badly    → danger   REJECTED, CANCELLED, LOST, EXPIRED…
 *   not yet started  → neutral  DRAFT
 *   in motion        → warn     everything else, which is "somebody owes you
 *                               an answer" — the honest default for a document
 *                               sitting in an approval chain
 *
 * A screen with a status of its own passes `extra` rather than starting a
 * tenth copy.
 */
export function statusTone(status: string, extra?: Record<string, Tone>): Tone {
  const s = status.toUpperCase();
  if (extra && s in extra) return extra[s];

  if (
    [
      'APPROVED',
      'PRIOR_APPROVED',
      'PAID',
      'RECEIVED',
      'REIMBURSED',
      'ISSUED',
      'ORDERED',
      'ACTIVE',
      'WON',
      'COMPLETED',
      'CLOSED',
      'SETTLED',
      'RENEWED',
    ].includes(s)
  ) {
    return 'ok';
  }

  if (
    ['REJECTED', 'CANCELLED', 'LOST', 'EXPIRED', 'VOID', 'OVERDUE', 'SUPERSEDED'].includes(s)
  ) {
    return 'danger';
  }

  if (['DRAFT', 'ON_HOLD', 'NEW'].includes(s)) return '';
  if (s.startsWith('QUOTATION') || ['NEGOTIATION', 'SUBMITTED', 'SENT'].includes(s)) return 'info';

  return 'warn';
}

/**
 * `ON_HOLD` → `On hold`. Written out twice before, and inline in a dozen more
 * places as `.replace(/_/g, ' ')` with no case handling at all.
 */
export function humanise(value: string): string {
  const s = value.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The status pill. Takes the raw enum the API returns and handles both the
 * colour and the wording, so a status never reads as `PRIOR_APPROVED` on one
 * screen and `Prior approved` on the next.
 */
export function StatusBadge({
  status,
  extra,
  label,
}: {
  status: string | null | undefined;
  extra?: Record<string, Tone>;
  label?: string;
}) {
  if (!status) return <span className="faint">—</span>;
  const tone = statusTone(status, extra);
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{label ?? humanise(status)}</span>;
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatMoney(value: number | null | undefined, currency = 'PHP'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value);
}

export function relativeTime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(d);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Object URLs for account photos, one per attachment id, for the life of the
 * page.
 *
 * The pipeline board draws an avatar on every card, and sixty cards owned by
 * one salesperson used to fetch the same photo sixty times on every load. The
 * promise is cached rather than the URL so that sixty avatars mounting in the
 * same tick share ONE request. A failed fetch is forgotten, so the next mount
 * tries again. The URLs are never revoked: they are shared by every avatar of
 * that person, and a replaced photo gets a new attachment id — a new key.
 */
const avatarUrls = new Map<string, Promise<string>>();

function avatarUrl(photoId: string): Promise<string> {
  let pending = avatarUrls.get(photoId);
  if (!pending) {
    pending = api.getBlob(`/attachments/file/${photoId}`).then((blob) => URL.createObjectURL(blob));
    pending.catch(() => avatarUrls.delete(photoId));
    avatarUrls.set(photoId, pending);
  }
  return pending;
}

/**
 * The one avatar, everywhere someone's picture appears — the topbar, the
 * Account page, the pipeline cards, and anywhere else that follows. `photoId`
 * is an Attachment id, never a URL: the file is behind
 * `/attachments/file/:id`, which needs the bearer token, so a bare
 * `<img src>` can't reach it. The bytes are fetched once per id (see
 * `avatarUrls`) and rendered as an object URL, falling back to the initials
 * disc — unchanged — when there is no photo or the fetch fails.
 */
export function Avatar({
  name,
  photoId,
  size = 30,
}: {
  name: string;
  photoId?: string | null;
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photoId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    avatarUrl(photoId)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [photoId]);

  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {url ? (
        <img src={url} alt="" className="avatar-img" />
      ) : (
        initials(name)
      )}
    </span>
  );
}
