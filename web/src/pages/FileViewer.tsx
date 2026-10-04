import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getToken } from '../lib/api';
import {
  MAX_COLS,
  MAX_ROWS,
  MAX_VIEW_BYTES,
  columnName,
  isSpreadsheet,
  matchRanges,
  matchingRows,
  rowKeys,
  type ViewWorkbook,
} from '../lib/spreadsheet';
import { readableSize } from '../components/Attachments';
import { Loading } from '../components/ui';

/**
 * A stored spreadsheet, read in the browser — /files/:id, opened in a tab of
 * its own by `openAttachment()` the way a PDF opens.
 *
 * Values only, as Excel shows them, and read-only: a partner's price list is
 * the partner's document, and changing it means uploading their next one.
 * The bytes come from the same guarded route the download uses, so whoever
 * may not open the record gets "not available" here too. They are parsed in
 * a worker (lib/spreadsheet.worker.ts) and come back as plain text, which is
 * all this page ever renders — no formulas, links or markup from the file.
 */

/** Rows drawn at a time. A sheet is searched whole; drawing fifty thousand
 *  rows at once would stall a site laptop. */
const PAGE = 1000;
/** A worker still parsing after this is stopped; the download still works. */
const READ_TIMEOUT_MS = 60_000;

type Stage =
  | { kind: 'fetching' }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  | { kind: 'reading' }
  | { kind: 'other'; reason: string }
  | { kind: 'ready'; book: ViewWorkbook };

interface Fetched {
  name: string;
  blob: Blob;
}

/** The original file name, from the route's Content-Disposition. */
function nameFrom(header: string | null): string {
  const match = header?.match(/filename="([^"]*)"/);
  if (!match) return 'file';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The query's occurrences in a cell, marked — found as the search finds them. */
function highlight(text: string, query: string): ReactNode {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) out.push(text.slice(from, start));
    out.push(<mark key={start}>{text.slice(start, end)}</mark>);
    from = end;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

export function FileViewer() {
  const { id = '' } = useParams<{ id: string }>();
  const [file, setFile] = useState<Fetched | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'fetching' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setStage({ kind: 'fetching' });

    (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/attachments/file/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
          signal: controller.signal,
        });
      } catch {
        if (!cancelled) setStage({ kind: 'failed', message: 'The file could not be loaded. Check the connection and try again.' });
        return;
      }
      if (res.status === 404 || res.status === 403) {
        if (!cancelled) setStage({ kind: 'missing' });
        return;
      }
      if (!res.ok) {
        if (!cancelled) setStage({ kind: 'failed', message: `The server refused the file (${res.status}). Try again in a moment.` });
        return;
      }
      const name = nameFrom(res.headers.get('Content-Disposition'));
      const blob = await res.blob();
      if (cancelled) return;
      setFile({ name, blob });

      if (!isSpreadsheet({ fileName: name })) {
        setStage({ kind: 'other', reason: 'This page shows spreadsheets. This file opens in its own program.' });
        return;
      }
      if (blob.size > MAX_VIEW_BYTES) {
        setStage({
          kind: 'other',
          reason: `At ${readableSize(blob.size)} this file is too large to read in the browser (the limit is ${readableSize(MAX_VIEW_BYTES)}).`,
        });
        return;
      }

      setStage({ kind: 'reading' });
      const bytes = await blob.arrayBuffer();
      if (cancelled) return;
      worker = new Worker(new URL('../lib/spreadsheet.worker.ts', import.meta.url), { type: 'module' });
      const stop = () => {
        clearTimeout(timer);
        worker?.terminate();
        worker = null;
      };
      timer = setTimeout(() => {
        stop();
        if (!cancelled) setStage({ kind: 'failed', message: 'Reading this file took too long. Download it to open it in Excel.' });
      }, READ_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<{ ok: true; workbook: ViewWorkbook } | { ok: false; error: string }>) => {
        stop();
        if (cancelled) return;
        const reply = event.data;
        setStage(
          reply.ok
            ? { kind: 'ready', book: reply.workbook }
            : { kind: 'failed', message: 'This file could not be read as a spreadsheet. Download it to open it in Excel.' },
        );
      };
      worker.onerror = () => {
        stop();
        if (!cancelled) setStage({ kind: 'failed', message: 'This file could not be read as a spreadsheet. Download it to open it in Excel.' });
      };
      worker.postMessage({ bytes, fileName: name }, [bytes]);
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [id, attempt]);

  // A working surface, so daylight — the rule Shell.tsx applies to every
  // screen but the launcher. This page sits outside the Shell, so it says so
  // itself, on <html> for the same reason the Shell does.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', 'day');
    return () => root.removeAttribute('data-theme');
  }, []);

  // The tab says which file it is, among the others somebody has open.
  useEffect(() => {
    const before = document.title;
    if (file) document.title = `${file.name} — G-CORE`;
    return () => {
      document.title = before;
    };
  }, [file]);

  function download() {
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  return (
    <div className="xv">
      <header className="topbar xv-top">
        <Link to="/" className="topbar-brand">
          G-CORE
        </Link>
        <div className="xv-file">
          <h1 className="xv-name">
            {file?.name ??
              (stage.kind === 'fetching' ? 'Opening the file…' : stage.kind === 'missing' ? 'File not available' : 'File')}
          </h1>
          {file && (
            <span className="xv-meta">
              {readableSize(file.blob.size)}
              {stage.kind === 'ready' &&
                ` · ${stage.book.sheets.length} sheet${stage.book.sheets.length === 1 ? '' : 's'}`}{' '}
              · read-only
            </span>
          )}
        </div>
        <div className="topbar-spacer" />
        {file && (
          <button type="button" className="btn btn-sm" onClick={download}>
            Download
          </button>
        )}
      </header>

      {stage.kind === 'fetching' && (
        <div className="xv-state">
          <Loading label="Fetching the file…" />
        </div>
      )}
      {stage.kind === 'reading' && (
        <div className="xv-state">
          <Loading label="Reading the spreadsheet…" />
        </div>
      )}
      {stage.kind === 'missing' && (
        <div className="xv-state">
          <div className="empty">
            <strong>This file is not available</strong>
            <p>It may have been removed, or it is on a record you cannot open.</p>
          </div>
        </div>
      )}
      {stage.kind === 'failed' && (
        <div className="xv-state">
          <div className="alert error">{stage.message}</div>
          <div className="row">
            {!file && (
              <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
            {file && (
              <button type="button" className="btn btn-sm btn-primary" onClick={download}>
                Download {file.name}
              </button>
            )}
          </div>
        </div>
      )}
      {stage.kind === 'other' && file && (
        <div className="xv-state">
          <div className="empty">
            <strong>{file.name}</strong>
            <p>{stage.reason}</p>
            <div className="empty-action">
              <button type="button" className="btn btn-sm btn-primary" onClick={download}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}
      {stage.kind === 'ready' && <Workbook book={stage.book} />}
    </div>
  );
}

function Workbook({ book }: { book: ViewWorkbook }) {
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const searching = deferred.trim() !== '';
  /** The headings row a reader picked per sheet; absent = the guessed one. */
  const [picked, setPicked] = useState<Record<number, number | null>>({});
  const [limit, setLimit] = useState(PAGE);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const keys = useMemo(() => book.sheets.map(rowKeys), [book]);
  const matches = useMemo(
    () => (searching ? keys.map((k) => matchingRows(k, deferred)) : null),
    [keys, deferred, searching],
  );

  const sheet = book.sheets[active];
  const header = sheet ? (active in picked ? picked[active] : sheet.headerRow) : null;

  useEffect(() => setLimit(PAGE), [active, deferred]);

  const spanAt = useMemo(() => {
    const map = new Map<number, Map<number, number>>();
    for (const s of sheet?.spans ?? []) {
      if (!map.has(s.r)) map.set(s.r, new Map());
      map.get(s.r)!.set(s.c, s.cols);
    }
    return map;
  }, [sheet]);

  if (!sheet) {
    return (
      <div className="xv-state">
        <div className="empty">
          <strong>Nothing to show</strong>
          <p>This file has no sheet Excel would show — download it to look inside.</p>
        </div>
      </div>
    );
  }

  // In a search the headings row leads the results, so they still say which
  // column is which; otherwise every row, the headings row in its place.
  const found = matches?.[active] ?? [];
  const order = searching
    ? [...(header !== null && header < sheet.rows.length ? [header] : []), ...found.filter((r) => r !== header)]
    : Array.from({ length: sheet.rows.length }, (_, r) => r);
  const shown = order.slice(0, limit);
  const letters = Array.from({ length: sheet.colCount }, (_, c) => columnName(c));
  const headingChoices = Array.from({ length: Math.min(30, sheet.rows.length) }, (_, r) => r);

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const to =
      event.key === 'Home' ? 0 : event.key === 'End' ? book.sheets.length - 1 : step ? active + step : null;
    if (to === null || to < 0 || to >= book.sheets.length) return;
    event.preventDefault();
    setActive(to);
    tabRefs.current[to]?.focus();
  }

  function renderRow(r: number) {
    const row = sheet.rows[r] ?? [];
    const kinds = sheet.kinds[r] ?? '';
    const spans = spanAt.get(r);
    const isHead = r === header;
    const Cell = isHead ? 'th' : 'td';
    const cells: ReactNode[] = [];
    for (let c = 0; c < sheet.colCount; c++) {
      const cols = spans?.get(c);
      const text = row[c] ?? '';
      cells.push(
        <Cell key={c} colSpan={cols} scope={isHead ? 'col' : undefined} className={kinds[c] === 'n' ? 'n' : undefined}>
          {searching ? highlight(text, deferred) : text}
        </Cell>,
      );
      if (cols) c += cols - 1;
    }
    return (
      <tr key={r} className={isHead ? 'xv-head-row' : undefined}>
        <th scope="row" className="xv-rownum">
          {r + 1}
        </th>
        {cells}
      </tr>
    );
  }

  // Where else the query is, when this sheet has none of it.
  const elsewhere = book.sheets
    .map((s, i) => ({ name: s.name, count: matches?.[i].length ?? 0 }))
    .filter((s, i) => i !== active && s.count > 0);
  const status = searching
    ? found.length === 0
      ? elsewhere.length
        ? `Nothing in “${sheet.name}” — ${elsewhere.map((s) => `${s.count.toLocaleString()} in “${s.name}”`).join(', ')}`
        : 'Nothing in this file matches'
      : `${found.length.toLocaleString()} row${found.length === 1 ? '' : 's'} match in “${sheet.name}”`
    : `${sheet.rows.length.toLocaleString()} row${sheet.rows.length === 1 ? '' : 's'} · ${sheet.colCount} column${sheet.colCount === 1 ? '' : 's'}`;

  return (
    <>
      <div className="xv-bar">
        {book.sheets.length > 1 && (
          <div className="scope-switch xv-tabs" role="tablist" aria-label="Sheets" onKeyDown={onTabKey}>
            {book.sheets.map((s, i) => (
              <button
                key={s.name}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`xv-tab-${i}`}
                aria-selected={i === active}
                aria-controls="xv-grid"
                tabIndex={i === active ? 0 : -1}
                className={i === active ? 'active' : ''}
                onClick={() => setActive(i)}
              >
                {s.name}
                {matches && <span className="xv-tab-count">{matches[i].length.toLocaleString()}</span>}
              </button>
            ))}
          </div>
        )}
        <input
          type="search"
          className="xv-search"
          placeholder="Find a model, a code, a price…"
          aria-label="Find in this file"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="xv-headings">
          Headings
          <select
            value={header === null ? '' : String(header)}
            onChange={(e) => setPicked((p) => ({ ...p, [active]: e.target.value === '' ? null : Number(e.target.value) }))}
          >
            <option value="">None</option>
            {headingChoices.map((r) => (
              <option key={r} value={r}>
                Row {r + 1}
              </option>
            ))}
          </select>
        </label>
        <span className="xv-status" role="status">
          {status}
        </span>
      </div>

      <div
        className="xv-grid"
        id="xv-grid"
        role="tabpanel"
        aria-labelledby={book.sheets.length > 1 ? `xv-tab-${active}` : undefined}
        aria-label={book.sheets.length > 1 ? undefined : sheet.name}
        tabIndex={0}
      >
        {sheet.rows.length === 0 ? (
          <div className="empty">
            <strong>This sheet is empty</strong>
          </div>
        ) : (
          <table className="xv-table">
            <thead>
              <tr>
                <th className="xv-corner" aria-label="Row" />
                {letters.map((l) => (
                  <th key={l} scope="col" className="xv-letter">
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{shown.map(renderRow)}</tbody>
          </table>
        )}
        {order.length > shown.length && (
          <div className="xv-more">
            <button type="button" className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE)}>
              Show {Math.min(PAGE, order.length - shown.length).toLocaleString()} more rows
            </button>
            <span className="faint">
              {shown.length.toLocaleString()} of {order.length.toLocaleString()} shown
            </span>
          </div>
        )}
      </div>

      <p className="xv-foot">
        Values only, as Excel shows them — colours, pictures and charts are not shown. Download the file to see
        everything, or to change it.
        {sheet.truncatedRows && ` Only the first ${MAX_ROWS.toLocaleString()} rows of this sheet are read.`}
        {sheet.truncatedCols && ` Only the first ${MAX_COLS} columns are shown.`}
        {book.hiddenSheets.length > 0 &&
          ` Hidden in the file: ${book.hiddenSheets.join(', ')}.`}
        {book.otherSheets > 0 &&
          ` ${book.otherSheets} chart sheet${book.otherSheets === 1 ? '' : 's'} not shown.`}
      </p>
    </>
  );
}
