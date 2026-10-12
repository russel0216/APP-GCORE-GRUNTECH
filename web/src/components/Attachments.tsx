import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Empty, ErrorBox, Loading, formatDateTime, useToast } from './ui';
import { Icon } from './Icon';
import { isSpreadsheet } from '../lib/spreadsheet';
import { pdfFirstPage } from '../lib/pdfThumb';

/**
 * Files hung off a record — the one way, for every record that has any.
 *
 * The attachment service has been there since Phase 1 (model §7) and nothing
 * in the browser ever used it: every document a customer sent lived in
 * somebody's mail. A scope of work is the case that makes it obvious — the
 * quotation, the costing and the job all descend from it, and the argument
 * six months later is always about what was actually asked for.
 *
 * Deliberately generic. `entityType` and `entityId` are free strings on the
 * server, so this drops onto a quotation, a job or a service report without
 * anything new behind it.
 */

interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption: string | null;
  uploadedAt: string;
  uploadedBy: { id: string; name: string } | null;
}

/**
 * Opens a stored file. The route needs the bearer token, so the bytes are
 * fetched and handed to the browser as a blob — pointing a link straight at
 * the URL gets a 401. Images and PDFs open in a tab; a spreadsheet opens in
 * G-CORE's own viewer (`/files/:id`) in a tab, because a browser cannot show
 * one; anything else downloads under its original name.
 *
 * Exported so a screen that shows a file outside this card — a partner's
 * catalogue — opens it the same way rather than keeping a second copy of the
 * token-bearing idiom. Resolves false when the file could not be opened.
 */
export async function openAttachment(file: { id: string; fileName: string; mimeType: string }): Promise<boolean> {
  if (isSpreadsheet(file)) {
    // Before any await, so the new tab still counts as the click's own.
    const a = document.createElement('a');
    a.href = `/files/${encodeURIComponent(file.id)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
    return true;
  }
  try {
    const res = await fetch(`/api/attachments/file/${file.id}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error('refused');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    if (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf') {
      a.target = '_blank';
      a.rel = 'noopener';
    } else {
      a.download = file.fileName;
    }
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

/** Bytes as somebody would say them. */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the card can show of a file: a picture, a PDF's first page, or only its kind. */
function previewKind(row: { mimeType: string; fileName: string; size: number }): 'image' | 'pdf' | 'none' {
  // A preview fetches the whole file; past this it is not worth the wait.
  if (row.size > PREVIEW_MAX_BYTES) return 'none';
  if (/^image\/(jpeg|png|gif|webp|bmp|svg\+xml)$/.test(row.mimeType)) return 'image';
  if (row.mimeType === 'application/pdf' || /\.pdf$/i.test(row.fileName)) return 'pdf';
  return 'none';
}

const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** "DOCX", "XLSX", "DWG" — the tile's label for a file that cannot be drawn. */
function extensionOf(fileName: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(fileName);
  return m ? m[1].toUpperCase() : 'FILE';
}

/**
 * The first page of a file, in the tile (2026-10-12, the owner's call: "in
 * all of the attachment menu, pdf, picture or documents can have preview of
 * the first page"). The bytes are fetched with the token (the route's own
 * guard decides, as for opening) only once the tile scrolls into view; an
 * image is drawn as itself, a PDF's first page drawn to a picture by the
 * vendored pdf.js (lib/pdfThumb.ts); the click opens the file. Word, Excel, CAD and archives
 * cannot be drawn in a browser (that needs a converter on the server), so
 * their tile says what they are.
 */
function AttachmentPreview({ row }: { row: Attachment }) {
  const kind = previewKind(row);
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (kind === 'none' || !ref.current) return;
    let made: string | null = null;
    let cancelled = false;
    const seen = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      try {
        const res = await fetch(`/api/attachments/file/${row.id}`, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error('refused');
        const blob = await res.blob();
        // A PDF's first page is drawn to a picture (lib/pdfThumb.ts), so both kinds show as an image.
        const picture = kind === 'pdf' ? await pdfFirstPage(await blob.arrayBuffer(), 900) : blob;
        if (cancelled) return;
        made = URL.createObjectURL(picture);
        setUrl(made);
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    seen.observe(ref.current);
    return () => {
      cancelled = true;
      seen.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [row.id, kind]);

  return (
    <div ref={ref} className={`attach-thumb attach-thumb-${kind}`} aria-hidden="true">
      {kind !== 'none' && url && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} />
      ) : (
        <span className="attach-thumb-kind">
          <Icon name={row.mimeType.startsWith('image/') ? 'image' : 'document'} size={28} />
          <span>{extensionOf(row.fileName)}</span>
          {kind !== 'none' && !url && !failed && <span className="faint">Loading…</span>}
          {failed && <span className="faint">No preview</span>}
          {row.size > PREVIEW_MAX_BYTES && <span className="faint">Too large to preview</span>}
        </span>
      )}
    </div>
  );
}

export function Attachments({
  entityType,
  entityId,
  title = 'Attachments',
  hint,
  canEdit = true,
}: {
  entityType: string;
  entityId: string;
  title?: string;
  hint?: string;
  canEdit?: boolean;
}) {
  const { me } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(() => {
    api
      .get<Attachment[]>(`/attachments/${entityType}/${entityId}`)
      .then(setRows)
      .catch(setError);
  }, [entityType, entityId]);

  useEffect(load, [load]);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of list) form.append('files', f);
      await api.post(`/attachments/${entityType}/${entityId}`, form);
      toast('ok', `${list.length} file${list.length === 1 ? '' : 's'} attached`);
      load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function open(row: Attachment) {
    if (!(await openAttachment(row))) toast('error', 'That file could not be opened');
  }

  async function remove(row: Attachment) {
    setBusy(true);
    try {
      await api.del(`/attachments/${row.id}`);
      toast('ok', 'Removed');
      load();
    } catch {
      // The server allows only the person who uploaded it, or a super admin.
      toast('error', 'Only the person who attached a file can remove it');
    } finally {
      setBusy(false);
    }
  }

  const mine = (row: Attachment) =>
    !!me?.user.isSuperAdmin || row.uploadedBy?.id === me?.user.id;

  return (
    <section className="card">
      <h3 className="card-title">
        {title}
        {rows?.length ? <span className="badge">{rows.length}</span> : null}
      </h3>
      {hint && <p className="panel-blurb">{hint}</p>}

      <ErrorBox error={error} />

      {rows === null ? (
        <Loading label="Reading the file list…" />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing attached yet"
          hint={canEdit ? 'Drop a file here, or use the button below.' : undefined}
        />
      ) : (
        <ul className="attach-stack">
          {rows.map((row) => (
            <li key={row.id} className="attach-item">
              <div className="attach-head">
                <button className="attach-name" onClick={() => open(row)} title="Open in a new tab">
                  {row.fileName}
                </button>
                <span className="attach-meta">
                  {readableSize(row.size)} · {row.uploadedBy?.name ?? 'someone'} · {formatDateTime(row.uploadedAt)}
                  {row.caption ? ` · ${row.caption}` : ''}
                </span>
                {canEdit && mine(row) && (
                  <button
                    className="btn btn-sm btn-ghost attach-remove"
                    onClick={() => remove(row)}
                    disabled={busy}
                    aria-label={`Remove ${row.fileName}`}
                  >
                    Remove
                  </button>
                )}
              </div>
              <button className="attach-open" onClick={() => open(row)} tabIndex={-1} aria-hidden="true">
                <AttachmentPreview row={row} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div
          className={`attach-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            className="visually-hidden"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
          <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : 'Attach a file'}
          </button>
          <span className="faint">or drop one here</span>
        </div>
      )}
    </section>
  );
}
