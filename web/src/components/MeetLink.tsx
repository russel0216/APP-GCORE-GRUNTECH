import { useState } from 'react';
import { ErrorBox, useToast } from './ui';

/**
 * The Google Meet link on a meeting or a training session.
 *
 * G-CORE holds no Google credentials and sends no email. The organiser creates
 * the event in their own Google Calendar from the hand-off link the API builds
 * (`shared/calendar-links.ts`), then pastes the Meet link back here so
 * everybody invited can join from the record. That is the whole integration,
 * deliberately: a service account would make the company's calendar a thing
 * the app can write to, and nobody asked for that.
 */
export function MeetLink({
  meetLink,
  calendarEventUrl,
  googleCalendarUrl,
  canEdit,
  onSave,
  live,
}: {
  meetLink: string | null;
  /** The organiser's own calendar event, once one exists. */
  calendarEventUrl?: string | null;
  /** The "create this event in Google Calendar" hand-off the API built. */
  googleCalendarUrl?: string | null;
  canEdit: boolean;
  onSave: (googleUrl: string) => Promise<void>;
  /** True while the event is current — Join only makes sense then. */
  live: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(!meetLink);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function copy() {
    if (!meetLink) return;
    try {
      await navigator.clipboard.writeText(meetLink);
      toast('ok', 'Link copied');
    } catch {
      toast('error', 'Could not copy — select the link and copy it by hand');
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setDraft('');
      setEditing(false);
      toast('ok', 'Link saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="meet-link">
      {meetLink && (
        <div className="row meet-link-row">
          {live && (
            <a className="btn btn-sm btn-primary" href={meetLink} target="_blank" rel="noopener noreferrer">
              Join
            </a>
          )}
          <span className="mono meet-link-url">{meetLink}</span>
          <button type="button" className="btn btn-sm" onClick={copy}>
            Copy
          </button>
          {calendarEventUrl && (
            <a className="btn btn-sm" href={calendarEventUrl} target="_blank" rel="noopener noreferrer">
              Open in Google Calendar
            </a>
          )}
          {canEdit && !editing && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              Change link
            </button>
          )}
        </div>
      )}

      {!meetLink && !canEdit && <div className="faint">No Meet link yet.</div>}

      {canEdit && editing && (
        <div className="meet-link-edit">
          {googleCalendarUrl && (
            <a className="btn btn-sm" href={googleCalendarUrl} target="_blank" rel="noopener noreferrer">
              Create in Google Calendar
            </a>
          )}
          <p className="muted">
            G-CORE has no Google credentials and sends no email. Create the event in your own Google
            Calendar from the link above, then paste the Meet link — or the event link — here so
            everybody invited can join from this page.
          </p>
          <ErrorBox error={error} />
          <div className="row">
            <input
              type="url"
              placeholder="https://meet.google.com/…"
              aria-label="Google Meet or Calendar link"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) void save();
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={save}
              disabled={busy || !draft.trim()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {meetLink && (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
