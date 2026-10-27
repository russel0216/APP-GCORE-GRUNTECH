/**
 * The badge reader's web COPY (2026-10-27, Marketing): `parseBadge` in
 * `api/src/shared/marketing.ts` is the rule, this is the same code so the
 * scanner fills the form the moment a badge is read. verify-sales pins the
 * two equal. DOM-free.
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

function unescapeV(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}
