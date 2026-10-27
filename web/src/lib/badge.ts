/**
 * The badge reader's web COPY (2026-10-27, Marketing): `parseBadge` and
 * `parseBadgeWith` in `api/src/shared/marketing.ts` are the rule; this is the
 * same code so the scanner fills the form the moment a badge is read.
 * verify-marketing pins the two equal. DOM-free.
 */

export interface Badge {
  name: string | null;
  company: string | null;
  position: string | null;
  email: string | null;
  mobile: string | null;
}

/** Reads a badge's QR — vCard, MECARD or plain text — as `parseBadge` in the API does. */
export function parseBadge(raw: string): Badge {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const out: Badge = { name: null, company: null, position: null, email: null, mobile: null };
  if (!text) return out;
  if (/^BEGIN:VCARD/i.test(text)) {
    // Folded lines (a line starting with a space continues the one before).
    const lines = text.replace(/\n[ \t]/g, '').split('\n');
    let n: string | null = null;
    for (const line of lines) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const head = line.slice(0, at).toUpperCase();
      const value = unescapeV(line.slice(at + 1)).trim();
      if (!value) continue;
      const prop = head.split(';')[0].replace(/^ITEM\d+\./, '');
      if (prop === 'FN') out.name ??= value;
      else if (prop === 'N') n ??= value;
      else if (prop === 'ORG') out.company ??= value.split(';').filter(Boolean).join(', ');
      else if (prop === 'TITLE' || prop === 'ROLE') out.position ??= value;
      else if (prop === 'EMAIL') out.email ??= value;
      else if (prop === 'TEL') {
        // A cell number first, else the first number given.
        if (/CELL|MOBILE/.test(head)) out.mobile = value;
        else out.mobile ??= value;
      }
    }
    if (!out.name && n) {
      const [last, first, middle] = n.split(';');
      out.name = [first, middle, last].map((p) => p?.trim()).filter(Boolean).join(' ') || null;
    }
    return out;
  }
  if (/^MECARD:/i.test(text)) {
    for (const part of text.slice(7).split(/(?<!\\);/)) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const key = part.slice(0, at).toUpperCase();
      const value = part.slice(at + 1).replace(/\\(.)/g, '$1').trim();
      if (!value) continue;
      if (key === 'N') out.name ??= value.includes(',') ? value.split(',').reverse().map((s) => s.trim()).join(' ') : value;
      else if (key === 'ORG') out.company ??= value;
      else if (key === 'TITLE') out.position ??= value;
      else if (key === 'EMAIL') out.email ??= value;
      else if (key === 'TEL') out.mobile ??= value;
    }
    return out;
  }
  // Plain text: an email and a number where there are any; nothing else is guessed.
  out.email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  out.mobile = text.match(/\+?\d[\d\s-]{8,}\d/)?.[0]?.replace(/\s+/g, ' ') ?? null;
  return out;
}

/** What a part of a DELIMITED badge can be. `skip` passes over a part (a badge number, a category). */
export const QR_FIELDS = ['name', 'firstName', 'lastName', 'company', 'position', 'email', 'mobile', 'skip'] as const;
export type QrField = (typeof QR_FIELDS)[number];

/** The separators offered; TAB and NEWLINE are named, the rest are the character itself. */
export const QR_SEPARATORS = ['|', ',', ';', 'TAB', 'NEWLINE', '^', '~'] as const;

export interface BadgeFormat {
  qrFormat: string;
  qrSeparator: string | null;
  qrFields: string[];
}

const sepOf = (s: string | null) => (s === 'TAB' ? '\t' : s === 'NEWLINE' ? '\n' : s || '|');

/**
 * Reads a badge the way ITS exhibition writes them (2026-10-27, "not only
 * this exhibit — modify based on the QR"). AUTO is `parseBadge` (a vCard, a
 * MECARD, plain text). DELIMITED splits the text on the exhibition's
 * separator and names each part in the exhibition's order; first and last
 * names join into the name. A vCard scanned at a DELIMITED exhibition is
 * still read as a vCard — a badge is read as what it is when it says so.
 */
export function parseBadgeWith(raw: string, format?: BadgeFormat | null): Badge {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!format || format.qrFormat !== 'DELIMITED' || /^(BEGIN:VCARD|MECARD:)/i.test(text)) return parseBadge(raw);
  const out: Badge = { name: null, company: null, position: null, email: null, mobile: null };
  const parts = text.split(sepOf(format.qrSeparator)).map((p) => p.trim());
  let first = '';
  let last = '';
  format.qrFields.forEach((field, i) => {
    const value = parts[i];
    if (!value) return;
    if (field === 'firstName') first = value;
    else if (field === 'lastName') last = value;
    else if (field === 'name' || field === 'company' || field === 'position' || field === 'email' || field === 'mobile') out[field] ??= value;
  });
  if (!out.name && (first || last)) out.name = [first, last].filter(Boolean).join(' ');
  return out;
}

function unescapeV(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}
