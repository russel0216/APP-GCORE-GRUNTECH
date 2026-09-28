import { useRef, useState } from 'react';
import { formatDateTime } from './ui';

/** What the API answers when it issues an invitation or a reset link. */
export interface Delivery {
  link: string;
  emailed: boolean;
  expiresAt: string;
  /** Why the email did not go, when email is set up and it failed. */
  error?: string;
}

/**
 * Where an invitation or reset link went: emailed, or here for the
 * administrator to pass on — by Messenger, Viber or text — while email is not
 * set up, or when it failed. The link is a key to an account, so it is shown
 * only to the administrator who issued it, and says when it runs out.
 */
export function LinkDelivery({
  delivery,
  email,
  kind,
}: {
  delivery: Delivery;
  email: string;
  kind: 'invite' | 'reset';
}) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);
  const what = kind === 'invite' ? 'invitation' : 'password reset link';
  const until = formatDateTime(delivery.expiresAt);

  async function copy() {
    try {
      await navigator.clipboard.writeText(delivery.link);
      setCopied(true);
    } catch {
      // A browser without clipboard access: select it for Ctrl+C instead.
      field.current?.focus();
      field.current?.select();
    }
  }

  return (
    <div className={`alert ${delivery.emailed ? 'ok' : delivery.error ? 'warn' : 'info'} link-delivery`} role="status">
      {delivery.emailed ? (
        <p>
          The {what} was emailed to <strong>{email}</strong>. It works until {until}, once.
        </p>
      ) : (
        <p>
          {delivery.error ? `The email did not go (${delivery.error}). ` : 'Email is not set up yet, so nothing was sent. '}
          Send this {what} to <strong>{email}</strong> yourself — by Messenger, Viber or text. It works until {until},
          once.
        </p>
      )}
      <div className="link-delivery-row">
        <input
          ref={field}
          readOnly
          className="mono"
          value={delivery.link}
          aria-label={`The ${what} for ${email}`}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}
