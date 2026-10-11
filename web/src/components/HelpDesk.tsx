import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { captureScreen } from '../lib/screenshot';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, useToast, type Tone } from './ui';

/**
 * The Help box (2026-10-11, the owner's call: "a help chat box so every user
 * can raise a ticket for improvement, allow them to screenshot the problem").
 *
 * A "? Help" button in the bottom-right corner of every signed-in page. It
 * opens a panel — never a modal: the page stays usable behind it — with two
 * tabs. New ticket: what it is (an improvement, something wrong, a
 * question), a subject, a description, and the screenshot the box took of the
 * page the moment it was opened, which can be taken again, removed, or joined
 * by an image of the person's own (attached, or pasted with Ctrl+V). The
 * page's address and the window size go with it. My tickets: what the person
 * raised, each opening its own page, where the thread and the answers are.
 * Every super admin is told of a new ticket (api/src/routes/helpTickets.ts).
 *
 * The draft lives as long as the Shell does, so closing the box and opening
 * it on another page keeps what was typed — and its screenshot, until the
 * person takes a new one.
 */

export const HELP_STATUS_TONES: Record<string, Tone> = { NEW: 'info', IN_PROGRESS: 'warn', DONE: 'ok', WONT_DO: '' };

export const HELP_KINDS = [
  { value: 'IMPROVEMENT', label: 'Improvement' },
  { value: 'PROBLEM', label: 'Something is wrong' },
  { value: 'QUESTION', label: 'Question' },
] as const;

/** As the API allows: the screenshot and a few images of the person's own. */
const MAX_IMAGES = 5;

interface Picture {
  key: string;
  blob: Blob;
  url: string;
  name: string;
}

interface MineRow {
  id: string;
  number: string;
  subject: string;
  status: string;
  statusLabel: string;
  kindLabel: string;
  createdAt: string;
  replies: number;
}

/** What the screenshot leaves out: the Help box itself and the toasts over the page. */
const outOfPicture = (el: Element) => el.classList.contains('help-fab') || el.classList.contains('help-panel') || el.classList.contains('toast-stack');

let keySeq = 0;
const picture = (blob: Blob, name: string): Picture => ({ key: `p${++keySeq}`, blob, url: URL.createObjectURL(blob), name });

export function HelpDesk() {
  const location = useLocation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'new' | 'mine'>('new');
  const [kind, setKind] = useState<string>('IMPROVEMENT');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [pagePath, setPagePath] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [shotError, setShotError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mine, setMine] = useState<MineRow[] | null>(null);
  const [mineError, setMineError] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);

  const here = `${location.pathname}${location.search}`;

  // A picture's object URL goes when the picture does.
  useEffect(() => () => pictures.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function takeScreenshot(replaceFirst: boolean) {
    setCapturing(true);
    setShotError(null);
    try {
      const blob = await captureScreen(outOfPicture);
      const shot = picture(blob, 'screenshot.png');
      setPictures((list) => {
        // The box's own screenshot is the first picture; taking it again replaces it.
        const rest = replaceFirst ? list.filter((p) => p.name !== 'screenshot.png') : list;
        for (const p of list) if (!rest.includes(p)) URL.revokeObjectURL(p.url);
        return [shot, ...rest].slice(0, MAX_IMAGES);
      });
      setPagePath(`${window.location.pathname}${window.location.search}`);
    } catch (err) {
      setShotError(err instanceof Error ? err.message : 'The screenshot could not be taken');
    } finally {
      setCapturing(false);
    }
  }

  function openBox() {
    setOpen(true);
    setTab('new');
    // A fresh draft takes its picture of the page it was opened on; a draft
    // already under way keeps its own until the person takes another.
    const fresh = !subject.trim() && !description.trim();
    if (fresh || !pictures.length) {
      setPagePath(here);
      void takeScreenshot(true);
    }
  }

  function closeBox() {
    setOpen(false);
    fabRef.current?.focus();
  }

  useEffect(() => {
    if (open && tab === 'new' && !capturing) subjectRef.current?.focus();
  }, [open, tab, capturing]);

  useEffect(() => {
    if (!open || tab !== 'mine') return;
    setMineError(null);
    api
      .get<MineRow[]>('/help-tickets/mine')
      .then(setMine)
      .catch(setMineError);
  }, [open, tab]);

  // The box is not a modal, but Escape still puts it away — the draft stays.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .overlay')) closeBox();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length < files.length) toast('error', 'Only images can go on a ticket');
    if (!images.length) return;
    setPictures((list) => {
      const room = MAX_IMAGES - list.length;
      if (images.length > room) toast('error', `A ticket takes ${MAX_IMAGES} pictures at most`);
      return [...list, ...images.slice(0, Math.max(0, room)).map((f) => picture(f, f.name || 'image.png'))];
    });
  }

  function remove(key: string) {
    setPictures((list) => {
      const gone = list.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
      return list.filter((p) => p.key !== key);
    });
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      addFiles(files);
    }
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('kind', kind);
      form.set('subject', subject.trim());
      form.set('description', description.trim());
      form.set('pagePath', pagePath || here);
      form.set('viewport', `${window.innerWidth}×${window.innerHeight}`);
      for (const p of pictures) form.append('files', p.blob, p.name);
      const saved = await api.post<{ id: string; number: string }>('/help-tickets', form);
      toast('ok', `${saved.number} sent — you will be told when it is answered`);
      pictures.forEach((p) => URL.revokeObjectURL(p.url));
      setPictures([]);
      setSubject('');
      setDescription('');
      setKind('IMPROVEMENT');
      setTab('mine');
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  const ready = subject.trim() && description.trim() && !capturing && !sending;

  return (
    <>
      {open && (
        <div className="help-panel" role="dialog" aria-label="Help and improvement" onPaste={onPaste}>
          <div className="help-head">
            <div>
              <h2>Help &amp; improvement</h2>
              <p>Tell the G-CORE team what to fix or improve</p>
            </div>
            <button type="button" className="btn-icon btn-ghost" aria-label="Close" onClick={closeBox}>
              ✕
            </button>
          </div>
          <div className="help-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>
              New ticket
            </button>
            <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
              My tickets{mine?.length ? ` (${mine.length})` : ''}
            </button>
          </div>

          {tab === 'new' ? (
            <>
              <div className="help-body">
                <ErrorBox error={error} />
                <div className="field">
                  <label id="help-kind">What is it?</label>
                  <div className="scope-switch help-kinds" role="group" aria-labelledby="help-kind">
                    {HELP_KINDS.map((k) => (
                      <button key={k.value} type="button" className={kind === k.value ? 'active' : ''} aria-pressed={kind === k.value} onClick={() => setKind(k.value)}>
                        {k.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Field label="Subject" required>
                  <input ref={subjectRef} value={subject} maxLength={200} placeholder="In a line — what should change?" onChange={(e) => setSubject(e.target.value)} />
                </Field>
                <Field label="Describe it" required>
                  <textarea
                    rows={4}
                    value={description}
                    maxLength={10000}
                    placeholder={kind === 'PROBLEM' ? 'What did you do, what happened, and what did you expect?' : 'What would help, and why?'}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <div className="field">
                  <label>Screenshot</label>
                  {capturing && !pictures.length ? (
                    <Loading label="Taking a screenshot of this page…" />
                  ) : (
                    <div className="help-shots">
                      {pictures.map((p) => (
                        <figure key={p.key} className="help-shot">
                          <img src={p.url} alt={p.name === 'screenshot.png' ? 'Screenshot of the page' : p.name} />
                          <button type="button" className="btn-sm btn-ghost help-shot-remove" onClick={() => remove(p.key)} aria-label={`Remove ${p.name}`}>
                            Remove
                          </button>
                        </figure>
                      ))}
                      {!pictures.length && <p className="faint help-none">No picture — take one, attach one, or paste one with Ctrl+V.</p>}
                    </div>
                  )}
                  {shotError && <div className="field-error">{shotError} — attach a picture instead.</div>}
                  <div className="help-shot-tools">
                    <button type="button" className="btn btn-sm" disabled={capturing} onClick={() => void takeScreenshot(true)}>
                      {capturing ? 'Taking it…' : pictures.some((p) => p.name === 'screenshot.png') ? 'Take it again' : 'Take a screenshot'}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={pictures.length >= MAX_IMAGES} onClick={() => fileRef.current?.click()}>
                      Attach an image…
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        addFiles([...(e.target.files ?? [])]);
                        e.target.value = '';
                      }}
                    />
                  </div>
                </div>
                <p className="help-context">
                  Sent with it: the page <strong>{pagePath || here}</strong>, your name, your browser and the time.
                </p>
              </div>
              <div className="help-foot">
                <button type="button" className="btn" onClick={closeBox}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void send()}>
                  {sending ? 'Sending…' : 'Send ticket'}
                </button>
              </div>
            </>
          ) : (
            <div className="help-body">
              <ErrorBox error={mineError} />
              {!mine && !mineError ? (
                <Loading />
              ) : mine && mine.length === 0 ? (
                <Empty title="No tickets yet" hint="What you raise is listed here, with its answers." />
              ) : (
                <ul className="help-mine">
                  {(mine ?? []).map((t) => (
                    <li key={t.id}>
                      <Link to={`/admin/help-tickets/${t.id}`} onClick={() => setOpen(false)}>
                        <span className="help-mine-top">
                          <span className="mono">{t.number}</span>
                          <StatusBadge status={t.status} extra={HELP_STATUS_TONES} label={t.statusLabel} />
                        </span>
                        <strong>{t.subject}</strong>
                        <span className="faint">
                          {t.kindLabel} · {formatDate(t.createdAt)}
                          {t.replies ? ` · ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'}` : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      <button
        ref={fabRef}
        type="button"
        className="help-fab"
        aria-expanded={open}
        aria-label={open ? 'Close help' : 'Help — raise a ticket'}
        onClick={() => (open ? closeBox() : openBox())}
      >
        <span className="help-fab-mark" aria-hidden="true">
          ?
        </span>
        Help
      </button>
    </>
  );
}
