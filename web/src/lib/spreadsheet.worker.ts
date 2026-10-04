/**
 * The viewer's worker: parses one spreadsheet off the page's thread.
 *
 * An uploaded file is untrusted input. Parsed here, a malformed or hostile one
 * can only fail, or be stopped by the page's timeout, in a thread that holds
 * nothing — no token, no page — and what comes back is plain arrays of
 * strings, copied across, which the page renders as text.
 */
import { readWorkbook } from './spreadsheetRead';

interface Request {
  bytes: ArrayBuffer;
  fileName: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage({ ok: true, workbook: readWorkbook(event.data.bytes, event.data.fileName) });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
