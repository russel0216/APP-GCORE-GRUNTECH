import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { prisma } from '../prisma';

/**
 * The document engine (model §7).
 *
 * "All PDF Format have uniformity across all Menus." Every printable document
 * in G-Core renders through this one function, so branding, the signature
 * block and page numbering are identical everywhere by construction. A module
 * supplies content; it never draws a header.
 */

export interface PdfField {
  label: string;
  value: string;
}

export type PdfSection =
  | { kind: 'fields'; title?: string; columns?: 1 | 2 | 3; fields: PdfField[] }
  | { kind: 'table'; title?: string; head: string[]; rows: string[][]; widths?: number[]; align?: ('left' | 'right' | 'center')[] }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'spacer'; height?: number };

export interface Signatory {
  role: string;
  name?: string;
  position?: string;
}

/**
 * When the document was raised, and when each approval landed.
 *
 * Every printable document carries this, so a signed PDF answers "who was
 * sitting on this, and for how long" on its own — without anybody opening the
 * system. That is the point: the bottleneck in an operation is almost never
 * the step somebody remembers, and a document that records only its own date
 * cannot be used to find it.
 *
 * Two approval mechanisms exist in G-Core and both are rendered:
 *
 *   - the approval engine's chain, for the document types that route through
 *     `submitForApproval` — give `documentType` and `documentId` and the trail
 *     is read from `ApprovalRequest`/`ApprovalAction`;
 *   - a single approval recorded on the document itself, which is how a
 *     progress report and a progress billing work — pass `approvedAt` and
 *     `approvedBy` directly.
 *
 * A document with neither says so, rather than leaving a blank that could be
 * read as "approved, time unknown".
 */
export interface PdfTrace {
  /** When the record itself was raised. */
  createdAt: Date;
  createdBy?: string | null;
  /** For documents approved on the record rather than through the engine. */
  approvedAt?: Date | null;
  approvedBy?: string | null;
  /** For documents that route through the approval engine. */
  documentType?: string;
  /**
   * The id the approval was raised against — which is not always the id of the
   * thing being printed. A quotation's approval hangs off the REVISION, so a
   * quotation PDF must pass the revision id or its own trail comes back empty.
   */
  documentId?: string;
}

export interface PdfDocumentSpec {
  title: string;
  documentNumber?: string;
  revision?: string;
  date?: Date;
  /** Customer / project reference line under the title. */
  reference?: string;
  sections: PdfSection[];
  /** Defaults to Prepared / Checked / Approved. */
  signatories?: Signatory[];
  /** Small print above the page number. */
  footerNote?: string;
  /** Raised-at and approved-at, printed as a trail at the foot of the document. */
  trace?: PdfTrace;
}

const MARGIN = 42;
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';
const HEAD_BG = '#f0f0f0';

export async function renderDocument(spec: PdfDocumentSpec): Promise<Buffer> {
  const company = await prisma.company.findUnique({ where: { id: 'company' } });

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: spec.documentNumber ? `${spec.documentNumber} — ${spec.title}` : spec.title,
      Author: company?.name ?? 'G-CORE',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  // Read before anything is drawn: the trail needs a database round trip, and
  // PDFKit's cursor cannot be left half-way through a document across an await.
  const trail = spec.trace ? await buildTrail(spec.trace) : null;
  const printedAt = new Date();

  drawHeader(doc, spec, company);
  for (const section of spec.sections) drawSection(doc, section);
  // The signature block pins itself to the foot of the page, so it has to be
  // told how much room the trail needs beneath it. Without this reservation
  // every document gained a second page just to carry its own trail.
  drawSignatures(doc, spec.signatories, trail ? trailHeight(trail) : 0);
  if (trail) drawTrace(doc, trail);
  paginate(doc, spec, company, printedAt);

  doc.end();
  return done;
}

// ── The document trail ───────────────────────────────────────────────────────

interface TrailRow {
  label: string;
  when: Date | null;
  who: string | null;
  /** Time spent waiting on THIS step — the number a bottleneck shows up in. */
  elapsedMs: number | null;
  outcome?: 'APPROVED' | 'REJECTED' | 'PENDING';
}

interface Trail {
  rows: TrailRow[];
  totalMs: number | null;
  note: string | null;
}

/**
 * Turns whichever approval record exists into one list of rows.
 *
 * Each row's elapsed time is measured from the PREVIOUS event, not from the
 * start, because "step 2 took three days" is the sentence that identifies a
 * bottleneck and "the document was three days old by step 2" is not.
 */
async function buildTrail(trace: PdfTrace): Promise<Trail> {
  const rows: TrailRow[] = [
    { label: 'Raised', when: trace.createdAt, who: trace.createdBy ?? null, elapsedMs: null },
  ];

  let previous = trace.createdAt;
  let note: string | null = null;

  if (trace.documentType && trace.documentId) {
    // Imported lazily: pdf.ts is imported by the approval-settled subscribers,
    // and a top-level import back into approvals.ts would close the circle.
    const { historyFor } = await import('./approvals');
    const requests = await historyFor(trace.documentType, trace.documentId);
    // historyFor returns newest first; a trail reads forwards.
    const rounds = [...requests].reverse();

    rounds.forEach((request, index) => {
      if (rounds.length > 1) {
        rows.push({
          label: `Submitted (attempt ${index + 1})`,
          when: request.createdAt,
          who: request.requester.name,
          elapsedMs: request.createdAt.getTime() - previous.getTime(),
        });
        previous = request.createdAt;
      }

      for (const action of request.actions) {
        const step = request.workflow?.steps.find((s) => s.sequence === action.sequence);
        rows.push({
          label: `Step ${action.sequence}${step ? ` · ${step.name}` : ''}`,
          when: action.actedAt,
          who: action.approver.name,
          elapsedMs: action.actedAt.getTime() - previous.getTime(),
          outcome: action.action === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        });
        previous = action.actedAt;
      }

      if (request.status === 'PENDING') {
        const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
        rows.push({
          label: `Step ${request.currentSequence}${step ? ` · ${step.name}` : ''}`,
          when: null,
          who: null,
          // Waiting time is live: measured to the moment this PDF was printed.
          elapsedMs: Date.now() - previous.getTime(),
          outcome: 'PENDING',
        });
      } else if (request.actions.length === 0 && request.closedAt) {
        // Settled without a recorded action — a document seeded or migrated
        // rather than approved through the engine. Say what is known and mark
        // what is not, because a trail that simply stops after "Raised" reads
        // as "never approved" on a document that plainly was.
        rows.push({
          label: request.status === 'APPROVED' ? 'Approved' : 'Closed',
          when: request.closedAt,
          who: null,
          elapsedMs: request.closedAt.getTime() - previous.getTime(),
          outcome: request.status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        });
        previous = request.closedAt;
        note = 'Settled without a recorded approver — not raised through the approval engine.';
      }
    });

    if (requests.length === 0) {
      note = 'Not submitted for approval.';
    }
  } else if (trace.approvedAt) {
    rows.push({
      label: 'Approved',
      when: trace.approvedAt,
      who: trace.approvedBy ?? null,
      elapsedMs: trace.approvedAt.getTime() - trace.createdAt.getTime(),
      outcome: 'APPROVED',
    });
    previous = trace.approvedAt;
  } else {
    note = 'This document type carries no approval step.';
  }

  const settled = [...rows].reverse().find((r) => r.when && r.outcome);
  const totalMs = settled?.when ? settled.when.getTime() - trace.createdAt.getTime() : null;

  return { rows, totalMs, note };
}

/** What drawTrace is about to need, so the signature block can leave room. */
function trailHeight(trail: Trail): number {
  return (
    14 + // gap above
    16 + // heading and rule
    trail.rows.reduce((h, r) => h + (r.outcome === 'REJECTED' ? 17.5 : 10), 0) +
    (trail.totalMs !== null ? 13 : 0) +
    (trail.note ? 9 : 0)
  );
}

function drawTrace(doc: PDFKit.PDFDocument, trail: Trail) {
  const right = doc.page.width - MARGIN;
  const width = right - MARGIN;

  ensureSpace(doc, 40 + trail.rows.length * 12);
  doc.y += 14;

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
  doc.text('DOCUMENT TRAIL', MARGIN, doc.y, { width, characterSpacing: 0.6 });
  doc.moveTo(MARGIN, doc.y + 2).lineTo(right, doc.y + 2).strokeColor(RULE).lineWidth(0.5).stroke();
  doc.y += 6;

  // Right-aligned columns so the elapsed times form a scannable column - the
  // whole reason this block exists is to be read down, not across.
  const whenX = MARGIN + 150;
  const whoX = MARGIN + 258;
  const elapsedX = right - 78;

  for (const row of trail.rows) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(INK);
    doc.text(row.label, MARGIN, y, { width: 146, lineBreak: false });

    doc.fillColor(row.when ? INK : MUTED);
    doc.text(row.when ? formatDateTime(row.when) : 'awaiting', whenX, y, {
      width: 104,
      lineBreak: false,
    });

    doc.fillColor(MUTED);
    doc.text(row.who ?? '—', whoX, y, { width: elapsedX - whoX - 6, lineBreak: false });

    if (row.elapsedMs !== null) {
      doc.fillColor(row.outcome === 'PENDING' ? INK : MUTED);
      doc.text(`${row.outcome === 'PENDING' ? 'waiting ' : ''}${formatElapsed(row.elapsedMs)}`, elapsedX, y, {
        width: 78,
        align: 'right',
        lineBreak: false,
      });
    }

    if (row.outcome === 'REJECTED') {
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK);
      doc.text('REJECTED', whoX, y + 7.5, { width: 80, lineBreak: false });
      doc.y += 7.5;
    }

    doc.y = y + 10;
  }

  if (trail.totalMs !== null) {
    doc.moveTo(elapsedX - 6, doc.y + 1).lineTo(right, doc.y + 1).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y += 3;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK);
    doc.text('Raised to approved', MARGIN, doc.y, { width: 200, lineBreak: false });
    doc.text(formatElapsed(trail.totalMs), elapsedX, doc.y, {
      width: 78,
      align: 'right',
      lineBreak: false,
    });
    doc.y += 10;
  }

  if (trail.note) {
    doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(MUTED);
    doc.text(trail.note, MARGIN, doc.y, { width, lineBreak: false });
    doc.y += 9;
  }
}

type Company = Awaited<ReturnType<typeof prisma.company.findUnique>>;

function drawHeader(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const right = doc.page.width - MARGIN;
  let textLeft = MARGIN;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, MARGIN, MARGIN - 4, { fit: [54, 54] });
      textLeft = MARGIN + 66;
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13);
  doc.text(company?.name ?? 'Company name not set', textLeft, MARGIN, { width: 300 });

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  const lines = [
    company?.address,
    [company?.city, company?.country].filter(Boolean).join(', '),
    company?.tin ? `TIN: ${company.tin}` : null,
    [company?.phone, company?.email].filter(Boolean).join('  ·  '),
  ].filter((l): l is string => Boolean(l && l.trim()));
  for (const line of lines) doc.text(line, textLeft, doc.y, { width: 300 });

  // Document identity block, right-aligned against the company block.
  const idTop = MARGIN;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK);
  doc.text(spec.title.toUpperCase(), right - 230, idTop, { width: 230, align: 'right' });

  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  const meta: string[] = [];
  if (spec.documentNumber) meta.push(`No. ${spec.documentNumber}`);
  if (spec.revision) meta.push(`Rev. ${spec.revision}`);
  meta.push(formatDate(spec.date ?? new Date()));
  doc.text(meta.join('   ·   '), right - 230, doc.y + 1, { width: 230, align: 'right' });

  const ruleY = Math.max(doc.y, idTop + 46) + 8;
  doc.moveTo(MARGIN, ruleY).lineTo(right, ruleY).strokeColor(RULE).lineWidth(1).stroke();
  doc.y = ruleY + 10;

  if (spec.reference) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text(spec.reference, MARGIN, doc.y, { width: right - MARGIN * 2 });
    doc.y += 4;
  }
}

function sectionTitle(doc: PDFKit.PDFDocument, title?: string) {
  if (!title) return;
  ensureSpace(doc, 40);
  // Explicit gaps rather than moveDown fractions: moveDown scales with whatever
  // font happens to be current, which left headings sitting ~3pt above their
  // own content — cramped on the page, and close enough to merge with it when
  // the PDF is parsed by anything that groups text into lines.
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(title.toUpperCase(), MARGIN, doc.y);
  doc.y += 7;
}

function drawSection(doc: PDFKit.PDFDocument, section: PdfSection) {
  switch (section.kind) {
    case 'spacer':
      doc.y += section.height ?? 12;
      return;

    case 'text':
      sectionTitle(doc, section.title);
      ensureSpace(doc, 40);
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(section.body, MARGIN, doc.y, {
        width: doc.page.width - MARGIN * 2,
        align: 'justify',
      });
      doc.moveDown(0.5);
      return;

    case 'fields': {
      sectionTitle(doc, section.title);
      const cols = section.columns ?? 2;
      const usable = doc.page.width - MARGIN * 2;
      const colWidth = usable / cols;
      let col = 0;
      let rowTop = doc.y;
      let rowHeight = 0;

      for (const field of section.fields) {
        if (col === 0) {
          ensureSpace(doc, 30);
          rowTop = doc.y;
          rowHeight = 0;
        }
        const x = MARGIN + col * colWidth;
        doc.font('Helvetica').fontSize(7).fillColor(MUTED);
        doc.text(field.label.toUpperCase(), x, rowTop, { width: colWidth - 10 });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
        doc.text(field.value || '—', x, doc.y, { width: colWidth - 10 });
        rowHeight = Math.max(rowHeight, doc.y - rowTop);
        col = (col + 1) % cols;
        if (col === 0) doc.y = rowTop + rowHeight + 6;
        else doc.y = rowTop;
      }
      if (col !== 0) doc.y = rowTop + rowHeight + 6;
      return;
    }

    case 'table': {
      sectionTitle(doc, section.title);
      const usable = doc.page.width - MARGIN * 2;
      const widths =
        section.widths && section.widths.length === section.head.length
          ? normalise(section.widths, usable)
          : section.head.map(() => usable / section.head.length);
      const align = section.align ?? section.head.map(() => 'left' as const);

      drawTableHead(doc, section.head, widths, align);
      for (const row of section.rows) {
        const height = rowHeight(doc, row, widths);
        if (doc.y + height > doc.page.height - 84) {
          doc.addPage();
          drawTableHead(doc, section.head, widths, align);
        }
        drawTableRow(doc, row, widths, align, height);
      }
      doc.moveDown(0.5);
      return;
    }
  }
}

function normalise(widths: number[], usable: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => (w / total) * usable);
}

function drawTableHead(
  doc: PDFKit.PDFDocument,
  head: string[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
) {
  ensureSpace(doc, 40);
  const top = doc.y;
  const height = 16;
  doc.rect(MARGIN, top, widths.reduce((a, b) => a + b, 0), height).fill(HEAD_BG);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
  let x = MARGIN;
  head.forEach((cell, i) => {
    doc.text(cell.toUpperCase(), x + 4, top + 5, { width: widths[i] - 8, align: align[i] });
    x += widths[i];
  });
  doc.y = top + height;
}

function rowHeight(doc: PDFKit.PDFDocument, row: string[], widths: number[]): number {
  doc.font('Helvetica').fontSize(8.5);
  let tallest = 0;
  row.forEach((cell, i) => {
    tallest = Math.max(tallest, doc.heightOfString(cell ?? '', { width: widths[i] - 8 }));
  });
  return tallest + 8;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: string[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
  height: number,
) {
  const top = doc.y;
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  let x = MARGIN;
  row.forEach((cell, i) => {
    doc.text(cell ?? '', x + 4, top + 4, { width: widths[i] - 8, align: align[i] });
    x += widths[i];
  });
  const bottom = top + height;
  doc
    .moveTo(MARGIN, bottom)
    .lineTo(MARGIN + widths.reduce((a, b) => a + b, 0), bottom)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  doc.y = bottom;
}

function drawSignatures(doc: PDFKit.PDFDocument, signatories: Signatory[] | undefined, reserve = 0) {
  const people = signatories ?? [
    { role: 'Prepared by' },
    { role: 'Checked by' },
    { role: 'Approved by' },
  ];
  if (!people.length) return;

  const blockHeight = 66;
  ensureSpace(doc, blockHeight + 10 + reserve);
  doc.y = Math.max(doc.y + 18, doc.page.height - 84 - blockHeight - reserve);

  const usable = doc.page.width - MARGIN * 2;
  const colWidth = usable / people.length;
  const top = doc.y;

  people.forEach((person, i) => {
    const x = MARGIN + i * colWidth;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(person.role.toUpperCase(), x, top, { width: colWidth - 12 });

    const lineY = top + 34;
    doc
      .moveTo(x, lineY)
      .lineTo(x + colWidth - 18, lineY)
      .strokeColor(RULE)
      .lineWidth(0.8)
      .stroke();

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
    doc.text(person.name ?? ' ', x, lineY + 4, { width: colWidth - 12 });
    if (person.position) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(person.position, x, doc.y, { width: colWidth - 12 });
    }
  });
}

/**
 * Footer and "Page n of m" on every page. Done at the end because the total
 * page count is only known once the content is laid out.
 */
function paginate(
  doc: PDFKit.PDFDocument,
  spec: PdfDocumentSpec,
  company: Company,
  printedAt: Date,
) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer deliberately sits BELOW the bottom margin. PDFKit treats any
    // text past that margin as overflow and helpfully starts a new page — which
    // would then need its own footer, and so on. Dropping the margin for the
    // duration of the write is the documented way to stop that; without it a
    // two-page document silently becomes six.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 46;
    doc
      .moveTo(MARGIN, y - 8)
      .lineTo(doc.page.width - MARGIN, y - 8)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();

    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    const left = spec.footerNote ?? company?.name ?? '';
    doc.text(left, MARGIN, y, { width: 320, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - MARGIN - 160, y, {
      width: 160,
      align: 'right',
      lineBreak: false,
    });
    // A PDF is a snapshot. Without the moment it was taken, two copies of the
    // same document that disagree cannot be told apart.
    const stamp = [
      spec.documentNumber,
      `Printed ${formatDateTime(printedAt)}`,
    ]
      .filter(Boolean)
      .join('   ·   ');
    doc.text(stamp, MARGIN, y + 9, { width: 400, lineBreak: false });

    doc.page.margins.bottom = bottomMargin;
  }
  // Leave the cursor on the last page so nothing is appended to page 1.
  doc.switchToPage(range.start + range.count - 1);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 84) doc.addPage();
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Date and time to the minute, in Manila. A timestamp on an approval is
 * evidence, so it is printed in the timezone the business works in rather than
 * whatever the server happens to be set to.
 */
export function formatDateTime(d: Date): string {
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * How long a step took, at the precision that is worth reading. Nobody chasing
 * a bottleneck cares about the seconds, and "1d 4h" is easier to compare down a
 * column than "28.4 hours".
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatMoney(value: number | string, currency = 'PHP'): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}
