import { useState, type InputHTMLAttributes } from 'react';

/**
 * A password box with a Show / Hide switch. The sign-in page, the invitation,
 * a reset and My Account all use this one, so the switch works the same way
 * everywhere.
 *
 * The switch is a real button — reachable by keyboard, announced with what
 * pressing it does, and `type="button"` so it never submits the form it sits
 * in. Showing flips the input's type and nothing else: the password is not
 * copied anywhere.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />
      <button
        type="button"
        className="password-toggle"
        aria-controls={props.id}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
